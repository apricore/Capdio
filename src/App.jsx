import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Folder, FolderOpen, Minus, Moon, Music, Square, Sun, Video, X } from 'lucide-react';
import MediaPlayer from './MediaPlayer';
import capdioIcon from '../assets/capdio-icon.png';

const { ipcRenderer } = window.require('electron');

function App() {
  const [library, setLibrary] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [contextMenu, setContextMenu] = useState(null);
  const [appMenu, setAppMenu] = useState(null);
  const [nameDialog, setNameDialog] = useState(null);
  const [deleteDialog, setDeleteDialog] = useState(null);
  const [uploadSession, setUploadSession] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [uploadQueueSize, setUploadQueueSize] = useState(0);
  const [inlineRename, setInlineRename] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [dragTargetGroup, setDragTargetGroup] = useState(null);
  const [media, setMedia] = useState(null);
  const [captions, setCaptions] = useState([]);
  const [status, setStatus] = useState('Loading library...');
  const [progress, setProgress] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribingMediaId, setTranscribingMediaId] = useState(null);
  const [queuedTranscriptionIds, setQueuedTranscriptionIds] = useState(new Set());
  const [darkTheme, setDarkTheme] = useState(() => localStorage.getItem('capdio-theme') !== 'light');
  useEffect(() => {
    const receiveTheme = (_event, dark) => setDarkTheme(dark);
    ipcRenderer.on('dictionary-theme-changed', receiveTheme);
    return () => ipcRenderer.removeListener('dictionary-theme-changed', receiveTheme);
  }, []);
  const [sideNavWidth, setSideNavWidth] = useState(() => Number(localStorage.getItem('capdio-side-nav-width')) || 282);
  const [playerFullscreenRequest, setPlayerFullscreenRequest] = useState(0);
  const [videoFullscreenRequest, setVideoFullscreenRequest] = useState(0);
  const [mediaWasPlaying, setMediaWasPlaying] = useState(false);
  const [autoplayNext, setAutoplayNext] = useState(false);
  const [playbackToggleRequest, setPlaybackToggleRequest] = useState(0);
  const [playbackSeekRequest, setPlaybackSeekRequest] = useState({ sequence: 0, seconds: 0 });
  const [volumeRevealRequest, setVolumeRevealRequest] = useState(0);
  const libraryRef = useRef([]);
  const transcriptionQueueRef = useRef([]);
  const isQueueRunningRef = useRef(false);
  const activeTranscriptionRef = useRef(null);
  const volumeSaveTimerRef = useRef(null);
  const positionSaveTimersRef = useRef(new Map());
  const currentPositionRef = useRef(0);
  const activeMediaRef = useRef(null);

  useEffect(() => { activeMediaRef.current = media; }, [media]);

  useEffect(() => {
    const saveBeforeClose = () => {
      const active = activeMediaRef.current;
      if (!active) return ipcRenderer.invoke('window-close');
      ipcRenderer.invoke('set-media-position', active.id, currentPositionRef.current)
        .finally(() => ipcRenderer.invoke('window-close'));
    };
    ipcRenderer.on('save-before-close', saveBeforeClose);
    return () => ipcRenderer.removeListener('save-before-close', saveBeforeClose);
  }, []);

  useEffect(() => {
    libraryRef.current = library;
  }, [library]);

  useEffect(() => {
    document.documentElement.style.setProperty('--startup-bg', darkTheme ? '#111827' : '#f4f6fb');
    localStorage.setItem('capdio-theme', darkTheme ? 'dark' : 'light');
    ipcRenderer.send('dictionary-theme', darkTheme);
  }, [darkTheme]);

  useEffect(() => {
    localStorage.setItem('capdio-side-nav-width', String(sideNavWidth));
  }, [sideNavWidth]);

  useEffect(() => {
    const cancelButton = document.querySelector('.upload-dialog__cancel');
    if (!cancelButton) return;
    const canCancel = uploadQueueSize > 0 || uploads.some((upload) => upload.state === 'uploading' || upload.state === 'importing');
    cancelButton.disabled = !canCancel;
    cancelButton.textContent = 'Cancel uploads';
  }, [uploadSession, uploads, uploadQueueSize]);

  useEffect(() => {
    if (!uploadSession) return undefined;
    const urlElement = document.querySelector('.upload-dialog code');
    if (!urlElement) return undefined;
    const button = document.createElement('button');
    button.className = 'upload-dialog__copy';
    button.type = 'button';
    button.title = 'Copy upload URL';
    button.setAttribute('aria-label', 'Copy upload URL');
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
    button.onclick = () => ipcRenderer.invoke('copy-text', uploadSession.url);
    urlElement.insertAdjacentElement('afterend', button);
    return () => button.remove();
  }, [uploadSession]);

  useEffect(() => {
    const handleWindowShortcuts = (event) => {
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        if (!event.repeat) {
          ipcRenderer.invoke('dictionary-open').catch((error) => {
            window.alert(`Unable to open dictionary: ${error.message}`);
          });
        }
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 's') {
        const selection = window.getSelection();
        const word = selection?.toString().trim();
        const book = selection?.anchorNode?.parentElement?.closest('.media-player__book');
        if (word && book && book.contains(selection.focusNode)) {
          event.preventDefault();
          if (!event.repeat) {
            selection.removeAllRanges();
            ipcRenderer.invoke('dictionary-lookup', word).catch((error) => {
              window.alert(`Dictionary lookup failed: ${error.message}`);
            });
          }
        }
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'o' && !isImporting) {
        event.preventDefault();
        chooseMedia();
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        setDarkTheme((value) => !value);
      }
      const target = event.target;
      const isEditingText = target instanceof HTMLElement && (target.matches('input, textarea, [contenteditable="true"]') || target.isContentEditable);
      if (media && !isEditingText && !event.ctrlKey && !event.altKey && !event.metaKey && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        setPlaybackToggleRequest((value) => value + 1);
        return;
      }
      if (media && !isEditingText && !event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        adjustMediaVolume(event.key === 'ArrowUp' ? 0.05 : -0.05);
        return;
      }
      if (media && !isEditingText && !event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        setPlaybackSeekRequest((request) => ({ sequence: request.sequence + 1, seconds: event.key === 'ArrowLeft' ? -5 : 5 }));
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'f' && media) {
        event.preventDefault();
        setPlayerFullscreenRequest((value) => value + 1);
      }
      if (event.key === 'F11' && media && media.type !== 'audio') {
        event.preventDefault();
        setVideoFullscreenRequest((value) => value + 1);
      }
    };
    window.addEventListener('keydown', handleWindowShortcuts);
    return () => window.removeEventListener('keydown', handleWindowShortcuts);
  }, [media, isImporting]);

  useEffect(() => {
    const blurNonTextControls = (event) => {
      const control = event.target;
      if (!(control instanceof HTMLElement) || control.isContentEditable) return;
      if (control.matches('button, [role="button"], input[type="range"]')) control.blur();
    };
    document.addEventListener('focusin', blurNonTextControls);
    return () => document.removeEventListener('focusin', blurNonTextControls);
  }, []);

  function beginSideNavResize(event) {
    event.preventDefault();
    const onMove = (moveEvent) => setSideNavWidth(Math.min(460, Math.max(190, moveEvent.clientX)));
    const onEnd = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd, { once: true });
  }

  async function saveMediaVolume(value, targetMedia = activeMediaRef.current) {
    if (!targetMedia) return;
    const volume = Math.max(0, Math.min(1, Number(value)));
    const mediaId = targetMedia.id;
    const updated = { ...targetMedia, volume };
    if (activeMediaRef.current?.id === mediaId) activeMediaRef.current = updated;
    setMedia(updated);
    setLibrary((items) => items.map((item) => item.id === mediaId ? { ...item, volume } : item));
    clearTimeout(volumeSaveTimerRef.current);
    volumeSaveTimerRef.current = setTimeout(async () => {
      try {
        await ipcRenderer.invoke('set-media-volume', mediaId, volume);
      } catch (error) {
        setStatus(`Could not save volume: ${error.message}`);
      }
    }, 220);
  }

  function adjustMediaVolume(delta) {
    const active = activeMediaRef.current;
    if (!active) return;
    saveMediaVolume((active.volume ?? 1) + delta, active);
    setVolumeRevealRequest((value) => value + 1);
  }

  function selectMedia(item, event) {
    const isMultiSelect = event?.ctrlKey || event?.metaKey;
    setSelectedIds((current) => {
      if (!isMultiSelect) return new Set([item.id]);
      const next = new Set(current);
      next.has(item.id) ? next.delete(item.id) : next.add(item.id);
      return next;
    });
    if (media && media.id !== item.id) {
      saveMediaPosition(media.id, currentPositionRef.current, true);
    }
    setAutoplayNext(mediaWasPlaying);
    setMedia(item);
    currentPositionRef.current = item.seekPosition ?? 0;
    localStorage.setItem('capdio-active-media-id', item.id);
    setCaptions(item.captions || []);
    setStatus(`Selected ${item.name}.`);
  }

  async function loadLibrary(selectFirst = false) {
    try {
      const result = await ipcRenderer.invoke('get-library');
      setGroups(result.groups);
      setLibrary(result.media);
      if (selectFirst && result.media.length) {
        const savedId = localStorage.getItem('capdio-active-media-id');
        const initial = result.media.find((item) => item.id === savedId) || result.media[0];
        selectMedia(initial);
        if (initial.groupId) setExpandedGroups((groups) => new Set([...groups, initial.groupId]));
        requestAnimationFrame(() => document.querySelector('.side-nav__item.is-selected')?.scrollIntoView({ block: 'nearest' }));
      }
      if (!result.media.length) setStatus('Select a local audio or video file to begin.');
    } catch (error) {
      setStatus(`Could not load manifest.json: ${error.message}`);
    }
  }

  useEffect(() => {
    loadLibrary(true);
    const onProgress = (_event, value) => setProgress(Math.round(value * 100));
    const onStatus = (_event, message) => setStatus(message);
    const onUploadStatus = (_event, update) => {
      if (Number.isFinite(update.queued)) setUploadQueueSize(update.queued);
      setUploads((uploads) => {
        const existing = uploads.findIndex((upload) => upload.id === update.id);
        const next = existing < 0 ? [...uploads, update] : uploads.map((upload, index) => index === existing ? { ...upload, ...update } : upload);
        return next.slice(-12);
      });
      if (update.state === 'complete' && update.item) setLibrary((items) => [...items, { ...update.item, captions: [] }]);
    };
    ipcRenderer.on('transcription-progress', onProgress);
    ipcRenderer.on('transcription-status', onStatus);
    ipcRenderer.on('upload-status', onUploadStatus);
    return () => {
      ipcRenderer.removeListener('transcription-progress', onProgress);
      ipcRenderer.removeListener('transcription-status', onStatus);
      ipcRenderer.removeListener('upload-status', onUploadStatus);
    };
  }, []);

  async function openUpload() {
    try {
      const session = await ipcRenderer.invoke('start-upload');
      setUploadSession(session);
      setUploads([]);
      setUploadQueueSize(0);
    } catch (error) {
      setStatus(`Could not start upload: ${error.message}`);
    }
  }

  function saveMediaPosition(mediaId, value, immediately = false) {
    if (!mediaId) return;
    const seekPosition = Math.max(0, Number(value) || 0);
    setLibrary((items) => items.map((item) => item.id === mediaId ? { ...item, seekPosition } : item));
    setMedia((current) => current?.id === mediaId ? { ...current, seekPosition } : current);
    const previousTimer = positionSaveTimersRef.current.get(mediaId);
    if (previousTimer) clearTimeout(previousTimer);
    const persist = () => {
      positionSaveTimersRef.current.delete(mediaId);
      ipcRenderer.invoke('set-media-position', mediaId, seekPosition).catch(() => {});
    };
    if (immediately) persist();
    else positionSaveTimersRef.current.set(mediaId, setTimeout(persist, 700));
  }

  async function cancelUploads() {
    await ipcRenderer.invoke('cancel-uploads');
  }

  async function chooseMedia(groupId = null) {
    setIsImporting(true);
    setStatus('Choose an audio or video file...');
    try {
      const sourceFiles = await ipcRenderer.invoke('select-files');
      if (!sourceFiles.length) {
        setStatus('No file selected.');
        return;
      }
      setStatus(`Copying ${sourceFiles.length} file${sourceFiles.length === 1 ? '' : 's'} into media/...`);
      // Import one at a time: each IPC call updates manifest.json, so parallel
      // writes can otherwise overwrite earlier entries from the same selection.
      const imported = [];
      for (const sourceFile of sourceFiles) {
        imported.push(await ipcRenderer.invoke('import-media', sourceFile, groupId));
      }
      const items = imported.map((item) => ({ ...item, captions: [] }));
      setLibrary((current) => [...current, ...items]);
      selectMedia(items[0]);
      setStatus(`Imported ${items.length} media item${items.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setStatus(`Import failed: ${error.message}`);
    } finally {
      setIsImporting(false);
    }
  }

  async function transcribeItem(item) {
    if (!item || activeTranscriptionRef.current || item.caption) return;
    activeTranscriptionRef.current = item.id;
    setIsTranscribing(true);
    setTranscribingMediaId(item.id);
    setProgress(0);
    setStatus('Preparing transcription...');
    try {
      // The main process resolves the manifest entry to its on-disk path. Keep
      // the renderer-only capdio:// playback URL out of the transcription flow.
      const result = await ipcRenderer.invoke('transcribe', item.id);
      if (result.cancelled) {
        setStatus('Transcription cancelled.');
        return;
      }
      setStatus('Writing caption JSON and manifest...');
      const saved = await ipcRenderer.invoke('save-transcription', item.id, result);
      const updatedItem = { ...item, caption: saved.captionRelativePath, captions: saved.caption.captions };
      if (media?.id === item.id) {
        setMedia(updatedItem);
        setCaptions(saved.caption.captions);
      }
      setLibrary((items) => items.map((entry) => entry.id === item.id ? updatedItem : entry));
      setProgress(100);
      setStatus(`Saved ${saved.captionRelativePath} and updated manifest.json.`);
    } catch (error) {
      setStatus(`Transcription failed: ${error.message}`);
    } finally {
      setIsTranscribing(false);
      setTranscribingMediaId(null);
      activeTranscriptionRef.current = null;
    }
  }

  function transcribeMedia() {
    enqueueFromTarget(media);
  }

  async function cancelTranscription() {
    await ipcRenderer.invoke('cancel-transcription');
    setStatus('Cancelling transcription...');
  }

  function syncQueueState() {
    setQueuedTranscriptionIds(new Set(transcriptionQueueRef.current));
  }

  async function processTranscriptionQueue() {
    if (isQueueRunningRef.current) return;
    isQueueRunningRef.current = true;
    while (transcriptionQueueRef.current.length) {
      const mediaId = transcriptionQueueRef.current.shift();
      syncQueueState();
      const item = libraryRef.current.find((entry) => entry.id === mediaId);
      if (item && !item.caption) await transcribeItem(item);
    }
    isQueueRunningRef.current = false;
  }

  function enqueueTranscriptions(items) {
    const knownIds = new Set(transcriptionQueueRef.current);
    const nextIds = items.filter((item) => item && !item.caption && item.id !== activeTranscriptionRef.current && !knownIds.has(item.id)).map((item) => item.id);
    if (!nextIds.length) return;
    transcriptionQueueRef.current.push(...nextIds);
    syncQueueState();
    processTranscriptionQueue();
  }

  function enqueueFromTarget(item) {
    if (!item) return;
    const selected = library.filter((entry) => selectedIds.has(entry.id) && entry.id !== item.id);
    enqueueTranscriptions([item, ...selected]);
  }

  function dequeueTranscription(mediaId) {
    transcriptionQueueRef.current = transcriptionQueueRef.current.filter((id) => id !== mediaId);
    syncQueueState();
  }

  function transcribeGroup(group) {
    enqueueTranscriptions(library.filter((item) => item.groupId === group.id));
  }

  function transcribeUngrouped() {
    enqueueTranscriptions(library.filter((item) => !item.groupId));
  }

  async function cancelGroupTranscriptions(group) {
    const groupIds = new Set(library.filter((item) => item.groupId === group.id).map((item) => item.id));
    transcriptionQueueRef.current = transcriptionQueueRef.current.filter((id) => !groupIds.has(id));
    syncQueueState();
    if (activeTranscriptionRef.current && groupIds.has(activeTranscriptionRef.current)) {
      await cancelTranscription();
    }
  }

  async function cancelUngroupedTranscriptions() {
    const ungroupedIds = new Set(library.filter((item) => !item.groupId).map((item) => item.id));
    transcriptionQueueRef.current = transcriptionQueueRef.current.filter((id) => !ungroupedIds.has(id));
    syncQueueState();
    if (activeTranscriptionRef.current && ungroupedIds.has(activeTranscriptionRef.current)) {
      await cancelTranscription();
    }
  }

  async function stopTranscriptionsFor(mediaIds) {
    const ids = new Set(mediaIds);
    transcriptionQueueRef.current = transcriptionQueueRef.current.filter((id) => !ids.has(id));
    syncQueueState();

    if (activeTranscriptionRef.current && ids.has(activeTranscriptionRef.current)) {
      setStatus('Cancelling transcription before deletion...');
      await cancelTranscription();
    }
  }

  function controlWindow(action) {
    if (action !== 'close') return ipcRenderer.invoke(`window-${action}`);
    const position = currentPositionRef.current;
    const activeId = media?.id;
    Promise.resolve(activeId ? ipcRenderer.invoke('set-media-position', activeId, position) : null)
      .finally(() => ipcRenderer.invoke('window-close'));
  }

  async function exportGroup(group) {
    setContextMenu(null);
    try {
      const result = await ipcRenderer.invoke('export-group', group.id);
      if (result) setStatus(`Exported ${result.count} media files to ${result.destination}.`);
    } catch (error) {
      setStatus(`Could not export group: ${error.message}`);
      window.alert(`Could not export group: ${error.message}`);
    }
  }
  async function exportMedia(item) {
    setContextMenu(null);
    try {
      const destination = await ipcRenderer.invoke('export-media', item.id);
      if (destination) setStatus(`Exported ${item.name} to ${destination}.`);
    } catch (error) {
      setStatus(`Could not export media: ${error.message}`);
      window.alert(`Could not export media: ${error.message}`);
    }
  }
  function createGroup() {
    setNameDialog({ mode: 'create-group', title: 'New group', value: '' });
  }

  async function saveGroup(name) {
    try {
      const group = await ipcRenderer.invoke('create-group', name);
      setGroups((items) => [...items, group]);
      setStatus(`Created group ${group.name}.`);
    } catch (error) {
      setStatus(`Could not create group: ${error.message}`);
    }
  }

  function renameItem(type, item) {
    setInlineRename({ type, id: item.id, originalName: item.name, value: item.name });
  }

  async function saveRename(type, item, name) {
    try {
      const updated = await ipcRenderer.invoke('rename-library-item', type, item.id, name);
      if (type === 'group') setGroups((items) => items.map((entry) => entry.id === updated.id ? updated : entry));
      else {
        setLibrary((items) => items.map((entry) => entry.id === updated.id ? { ...entry, ...updated } : entry));
        setMedia((entry) => entry?.id === updated.id ? { ...entry, ...updated } : entry);
      }
      setStatus(`Renamed to ${updated.name}.`);
    } catch (error) {
      setStatus(`Could not rename: ${error.message}`);
    }
  }

  async function commitInlineRename(value) {
    if (!inlineRename) return;
    const rename = { ...inlineRename, value: value ?? inlineRename.value };
    setInlineRename(null);
    const name = rename.value.trim();
    if (!name || name === rename.originalName) return;
    await saveRename(rename.type, { id: rename.id, name: rename.originalName }, name);
  }

  async function moveSelection(groupId, draggedId) {
    const ids = selectedIds.has(draggedId) ? [...selectedIds] : [draggedId];
    try {
      await ipcRenderer.invoke('move-media-to-group', ids, groupId);
      setLibrary((items) => items.map((item) => ids.includes(item.id) ? { ...item, groupId } : item));
      setStatus(`Moved ${ids.length} media item${ids.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setStatus(`Could not move media: ${error.message}`);
    }
  }

  function showContextMenu(event, type, item) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, type, item });
  }

  function toggleGroup(groupId) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      next.has(groupId) ? next.delete(groupId) : next.add(groupId);
      return next;
    });
  }

  function handleGroupDrop(event, groupId) {
    event.preventDefault();
    setDragTargetGroup(null);
    moveSelection(groupId, event.dataTransfer.getData('text/media-id'));
  }

  function startMediaDrag(event, item) {
    const ids = selectedIds.has(item.id) ? [...selectedIds] : [item.id];
    event.dataTransfer.setData('text/media-id', item.id);
    event.dataTransfer.effectAllowed = 'move';

    const preview = document.createElement('div');
    preview.textContent = ids.length === 1 ? item.name : `${ids.length} media items`;
    Object.assign(preview.style, {
      position: 'fixed', top: '-1000px', left: '-1000px',
      maxWidth: '240px', padding: '8px 12px', border: darkTheme ? '1px solid rgba(139, 140, 255, .9)' : '1px solid #818cf8',
      borderRadius: '9px', color: darkTheme ? '#edf2ff' : '#272b63', background: darkTheme ? '#222d43' : '#f8f9ff',
      boxShadow: darkTheme ? '0 10px 24px rgba(0, 0, 0, .35)' : '0 10px 24px rgba(59, 66, 129, .2)', font: '600 12px Inter, sans-serif',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
    });
    document.body.append(preview);
    event.dataTransfer.setDragImage(preview, 16, 16);
    requestAnimationFrame(() => preview.remove());
  }

  async function submitNameDialog(event) {
    event.preventDefault();
    const name = nameDialog.value.trim();
    if (!name) return;
    if (nameDialog.mode === 'create-group') await saveGroup(name);
    else if (name !== nameDialog.item.name) await saveRename(nameDialog.type, nameDialog.item, name);
    setNameDialog(null);
  }

  const contextScopeItems = contextMenu?.type === 'group'
    ? library.filter((item) => item.groupId === contextMenu.item.id)
    : contextMenu?.type === 'root'
      ? library.filter((item) => !item.groupId)
      : [];
  const contextScopeHasTranscribing = contextScopeItems.some((item) => item.id === transcribingMediaId || queuedTranscriptionIds.has(item.id));
  const contextScopeHasEligibleTranscription = contextScopeItems.some((item) => !item.caption && item.id !== transcribingMediaId && !queuedTranscriptionIds.has(item.id));

  function requestDelete(item) {
    const ids = selectedIds.has(item.id) ? [...selectedIds] : [item.id];
    setDeleteDialog({ ids, name: ids.length === 1 ? item.name : `${ids.length} selected media items` });
  }

  function requestDeleteGroup(group) {
    const count = library.filter((item) => item.groupId === group.id).length;
    setDeleteDialog({ type: 'group', group, count });
  }

  async function confirmDelete() {
    try {
      if (deleteDialog.type === 'group') {
        const groupMediaIds = library.filter((item) => item.groupId === deleteDialog.group.id).map((item) => item.id);
        await stopTranscriptionsFor(groupMediaIds);
        const result = await ipcRenderer.invoke('delete-group', deleteDialog.group.id);
        const deleted = new Set(result.mediaIds);
        setGroups((items) => items.filter((item) => item.id !== result.groupId));
        setLibrary((items) => items.filter((item) => !deleted.has(item.id)));
        if (media && deleted.has(media.id)) { setMedia(null); setCaptions([]); }
        setSelectedIds(new Set());
        setStatus(`Deleted group ${deleteDialog.group.name} and ${deleted.size} media item${deleted.size === 1 ? '' : 's'}.`);
        return;
      }
      await stopTranscriptionsFor(deleteDialog.ids);
      const deletedIds = await ipcRenderer.invoke('delete-media', deleteDialog.ids);
      const deleted = new Set(deletedIds);
      setLibrary((items) => items.filter((item) => !deleted.has(item.id)));
      setSelectedIds(new Set());
      if (media && deleted.has(media.id)) {
        setMedia(null);
        setCaptions([]);
      }
      setStatus(`Deleted ${deletedIds.length} media item${deletedIds.length === 1 ? '' : 's'} and linked captions.`);
    } catch (error) {
      setStatus(`Could not delete media: ${error.message}`);
    } finally {
      setDeleteDialog(null);
    }
  }

  return (
    <main className={`app-frame ${darkTheme ? 'app-frame--dark' : ''}`} onClick={() => { setContextMenu(null); setAppMenu(null); }}>
      <header className="app-menu" aria-label="Application menu">
        <div className="app-menu__brand"><img src={capdioIcon} alt="Capdio" draggable="false" /></div>
        <nav className="app-menu__items" aria-label="Main menu" onClick={(event) => event.stopPropagation()}>
          <div className="app-menu__dropdown">
            <button type="button" onClick={() => setAppMenu((value) => value === 'file' ? null : 'file')}>File</button>
            {appMenu === 'file' && <div className="app-menu__popup"><button type="button" disabled={isImporting} onClick={() => { chooseMedia(); setAppMenu(null); }}>Import media <kbd>Ctrl+O</kbd></button><button type="button" onClick={() => { openUpload(); setAppMenu(null); }}>Import from phone</button></div>}
          </div>
          <div className="app-menu__dropdown">
            <button type="button" onClick={() => setAppMenu((value) => value === 'view' ? null : 'view')}>View</button>
            {appMenu === 'view' && <div className="app-menu__popup"><button type="button" onClick={() => { setDarkTheme((value) => !value); setAppMenu(null); }}><span>{darkTheme ? <Sun /> : <Moon />} Toggle colour theme</span><kbd>Ctrl+Shift+T</kbd></button></div>}
          </div>
          <div className="app-menu__dropdown">
            <button type="button" onClick={() => setAppMenu((value) => value === 'window' ? null : 'window')}>Window</button>
            {appMenu === 'window' && <div className="app-menu__popup"><button type="button" disabled={!media} onClick={() => { setPlayerFullscreenRequest((value) => value + 1); setAppMenu(null); }}>Toggle Player Fullscreen <kbd>Ctrl+F</kbd></button><button type="button" disabled={!media || media.type === 'audio'} onClick={() => { setVideoFullscreenRequest((value) => value + 1); setAppMenu(null); }}>Fullscreen Video <kbd>F11</kbd></button><button type="button" onClick={() => { ipcRenderer.invoke('toggle-developer-tools'); setAppMenu(null); }}>Toggle Developer Tools <kbd>Ctrl+Shift+I</kbd></button></div>}
          </div>
        </nav>
        <div className="app-menu__window-controls" aria-label="Window controls">
          <button type="button" title="Minimize" aria-label="Minimize" onClick={() => controlWindow('minimize')}><Minus /></button>
          <button type="button" title="Maximize or restore" aria-label="Maximize or restore" onClick={() => controlWindow('toggle-maximize')}><Square /></button>
          <button className="app-menu__close" type="button" title="Close" aria-label="Close" onClick={() => controlWindow('close')}><X /></button>
        </div>
      </header>
      <div className="app-shell" style={{ '--side-nav-width': `${sideNavWidth}px` }}>
      <aside className="side-nav" aria-label="Media library">
        <div className="side-nav__header"><img src={capdioIcon} alt="" draggable="false" /><div><h1>Capdio</h1><p>Media studio</p></div><span className="side-nav__count">{library.length}</span></div>
        <button className="side-nav__import" type="button" onClick={() => chooseMedia()} disabled={isImporting}>
          {isImporting ? 'Importing...' : 'Import media'}
        </button>
        <button className="side-nav__new-group" type="button" onClick={createGroup}>+ New group</button>
        <nav className="side-nav__items side-nav__items--legacy">
          {groups.map((group) => <section key={group.id} className="side-nav__group" onContextMenu={(event) => showContextMenu(event, 'group', group)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => moveSelection(group.id, event.dataTransfer.getData('text/media-id'))}>
            <div className="side-nav__group-name">⌄ <span>{group.name}</span></div>
            {library.filter((item) => item.groupId === group.id).map((item) => <MediaItem key={item.id} item={item} selected={selectedIds.has(item.id)} active={media?.id === item.id} onSelect={selectMedia} onContextMenu={showContextMenu} />)}
          </section>)}
          <section className="side-nav__group" onDragOver={(event) => event.preventDefault()} onDrop={(event) => moveSelection(null, event.dataTransfer.getData('text/media-id'))}>
            {groups.length > 0 && <div className="side-nav__group-name">⌄ <span>Ungrouped</span></div>}
            {library.filter((item) => !item.groupId).map((item) => <MediaItem key={item.id} item={item} selected={selectedIds.has(item.id)} active={media?.id === item.id} onSelect={selectMedia} onContextMenu={showContextMenu} />)}
          </section>
          {!library.length && <p className="side-nav__empty">Your manifest has no media yet.</p>}
        </nav>
        <LibraryTree library={library} groups={groups} selectedIds={selectedIds} activeId={media?.id} expandedGroups={expandedGroups} dragTargetGroup={dragTargetGroup} inlineRename={inlineRename} transcribingMediaId={transcribingMediaId} queuedTranscriptionIds={queuedTranscriptionIds} transcriptionProgress={progress} onRenameChange={setInlineRename} onRenameCommit={commitInlineRename} onSelect={selectMedia} onContextMenu={showContextMenu} onDragStart={startMediaDrag} onToggleGroup={toggleGroup} onDragTarget={setDragTargetGroup} onDrop={handleGroupDrop} />
      </aside>
      <div className="side-nav__resize-handle" role="separator" aria-label="Resize media library" aria-orientation="vertical" onPointerDown={beginSideNavResize} />

      <section className="workspace">
        {media && <MediaPlayer key={media.id} mediaId={media.id} src={media.playbackPath || `library/${media.media}`} captions={captions} hasCaptions={Boolean(media.caption)} volume={media.volume ?? 1} volumeRevealRequest={volumeRevealRequest} playbackToggleRequest={playbackToggleRequest} playbackSeekRequest={playbackSeekRequest} initialPosition={media.seekPosition ?? 0} autoplay={autoplayNext} onPlayingChange={setMediaWasPlaying} onCurrentPosition={(mediaId, value) => { if (activeMediaRef.current?.id === mediaId) currentPositionRef.current = value; }} onPositionChange={saveMediaPosition} dark={darkTheme} showMedia={media.type !== 'audio'} fullscreenRequest={playerFullscreenRequest} videoFullscreenRequest={videoFullscreenRequest} transcribing={transcribingMediaId === media.id} queued={queuedTranscriptionIds.has(media.id)} transcriptionProgress={progress} onTranscribe={transcribeMedia} onVolumeChange={saveMediaVolume} onToggleTheme={() => setDarkTheme((value) => !value)} />}
      </section>
      </div>
      {contextMenu && <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
        {contextMenu.type !== 'root' && <button type="button" onClick={() => { renameItem(contextMenu.type, contextMenu.item); setContextMenu(null); }}>Rename</button>}
        {contextMenu.type === 'group' && <button type="button" onClick={() => { chooseMedia(contextMenu.item.id); setContextMenu(null); }}>Import media</button>}
        {contextMenu.type === 'group' && <button type="button" onClick={() => exportGroup(contextMenu.item)}>Export group</button>}
        {contextMenu.type === 'group' && <button type="button" disabled={!contextScopeHasEligibleTranscription} onClick={() => { transcribeGroup(contextMenu.item); setContextMenu(null); }}>Transcribe all</button>}
        {contextMenu.type === 'group' && contextScopeHasTranscribing && <button type="button" onClick={() => { cancelGroupTranscriptions(contextMenu.item); setContextMenu(null); }}>Cancel all transcriptions</button>}
        {contextMenu.type === 'group' && <button type="button" className="context-menu__delete" onClick={() => { requestDeleteGroup(contextMenu.item); setContextMenu(null); }}>Delete group</button>}
        {contextMenu.type === 'root' && <button type="button" onClick={() => { chooseMedia(); setContextMenu(null); }}>Import media</button>}
        {contextMenu.type === 'root' && <button type="button" disabled={!contextScopeHasEligibleTranscription} onClick={() => { transcribeUngrouped(); setContextMenu(null); }}>Transcribe all</button>}
        {contextMenu.type === 'root' && contextScopeHasTranscribing && <button type="button" onClick={() => { cancelUngroupedTranscriptions(); setContextMenu(null); }}>Cancel all transcriptions</button>}
        {contextMenu.type === 'media' && <button type="button" onClick={() => exportMedia(contextMenu.item)}>Export</button>}
        {contextMenu.type === 'media' && transcribingMediaId === contextMenu.item.id && <button type="button" onClick={() => { cancelTranscription(); setContextMenu(null); }}>Cancel transcription</button>}
        {contextMenu.type === 'media' && transcribingMediaId !== contextMenu.item.id && queuedTranscriptionIds.has(contextMenu.item.id) && <button type="button" onClick={() => { dequeueTranscription(contextMenu.item.id); setContextMenu(null); }}>Dequeue / Exclude</button>}
        {contextMenu.type === 'media' && transcribingMediaId !== contextMenu.item.id && !queuedTranscriptionIds.has(contextMenu.item.id) && <button type="button" disabled={Boolean(contextMenu.item.caption)} onClick={() => { enqueueFromTarget(contextMenu.item); setContextMenu(null); }}>{contextMenu.item.caption ? 'Transcribed' : 'Transcribe'}</button>}
        {contextMenu.type === 'media' && <button type="button" className="context-menu__delete" onClick={() => { requestDelete(contextMenu.item); setContextMenu(null); }}>Delete</button>}
      </div>}
      {nameDialog && <div className="name-dialog-backdrop" onMouseDown={() => setNameDialog(null)}>
        <form className="name-dialog" onSubmit={submitNameDialog} onMouseDown={(event) => event.stopPropagation()}>
          <h3>{nameDialog.title}</h3>
          <input autoFocus value={nameDialog.value} onChange={(event) => setNameDialog((dialog) => ({ ...dialog, value: event.target.value }))} />
          <div><button type="button" onClick={() => setNameDialog(null)}>Cancel</button><button type="submit">Save</button></div>
        </form>
      </div>}
      {deleteDialog && <div className="name-dialog-backdrop" onMouseDown={() => setDeleteDialog(null)}>
        <div className="name-dialog" role="alertdialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
          <h3>{deleteDialog.type === 'group' ? 'Delete group and its media?' : 'Delete media?'}</h3><p>{deleteDialog.type === 'group' ? <>Delete <strong>{deleteDialog.group.name}</strong> and all {deleteDialog.count} media item{deleteDialog.count === 1 ? '' : 's'} in it, including their caption JSON files?</> : <>Delete <strong>{deleteDialog.name}</strong> from the library, including its caption JSON file if present?</>}</p>
          <div><button type="button" onClick={() => setDeleteDialog(null)}>Cancel</button><button className="name-dialog__delete" type="button" onClick={confirmDelete}>Delete</button></div>
        </div>
      </div>}
      {uploadSession && <div className="name-dialog-backdrop" onMouseDown={() => setUploadSession(null)}><div className="upload-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}><button className="upload-dialog__close" type="button" onClick={() => setUploadSession(null)} aria-label="Close"><X /></button><h3>Import from phone</h3><p>Scan this code with a phone on the same Wi-Fi network, then select one or more audio/video files.</p><img src={uploadSession.qrCode} alt={`QR code for ${uploadSession.url}`} /><code>{uploadSession.url}</code><div className="upload-dialog__queue">{uploads.length ? uploads.map((upload) => <div key={upload.id}><span>{upload.name}</span><span>{upload.state === 'uploading' ? <><progress value={upload.progress || 0} max="100" />{upload.progress || 0}%</> : upload.state === 'importing' ? 'Importing…' : upload.state === 'complete' ? 'Imported' : upload.state === 'error' ? 'Failed' : upload.state === 'cancelled' ? 'Cancelled' : upload.state === 'received' ? 'Received' : 'Queued'}</span></div>) : <p>Waiting for uploads…</p>}</div><button className="upload-dialog__cancel" type="button" onClick={cancelUploads}>Cancel pending uploads</button></div></div>}
    </main>
  );
}

function LibraryTree({ library, groups, selectedIds, activeId, expandedGroups, dragTargetGroup, inlineRename, transcribingMediaId, queuedTranscriptionIds, transcriptionProgress, onRenameChange, onRenameCommit, onSelect, onContextMenu, onDragStart, onToggleGroup, onDragTarget, onDrop }) {
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const isRenaming = Boolean(inlineRename);
  return <nav className={`side-nav__items ${dragTargetGroup === 'root' ? 'is-root-drop-target' : ''}`} onContextMenu={(event) => { if (event.target === event.currentTarget) onContextMenu(event, 'root', null); }} onDragOver={(event) => { if (isRenaming) return; event.preventDefault(); onDragTarget('root'); }} onDragLeave={(event) => { if (!isRenaming && !event.currentTarget.contains(event.relatedTarget)) onDragTarget(null); }} onDrop={(event) => { if (isRenaming) return; onDrop(event, null); }}>
    {[...groups].sort(byName).map((group) => {
      const expanded = expandedGroups.has(group.id);
      const groupMedia = library.filter((item) => item.groupId === group.id).sort(byName);
      return <section key={group.id} className={`side-nav__group ${dragTargetGroup === group.id ? 'is-drop-target' : ''}`} onContextMenu={(event) => onContextMenu(event, 'group', group)} onDragOver={(event) => { if (isRenaming) return; event.preventDefault(); event.stopPropagation(); onDragTarget(group.id); }} onDragLeave={(event) => { if (!isRenaming && !event.currentTarget.contains(event.relatedTarget)) onDragTarget(null); }} onDrop={(event) => { if (isRenaming) return; event.stopPropagation(); onDrop(event, group.id); }}>
        <div className={`side-nav__group-name ${expanded ? 'is-open' : ''}`} role="button" tabIndex={0} onClick={() => onToggleGroup(group.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggleGroup(group.id); } }} aria-expanded={expanded}><span className="side-nav__folder" aria-hidden="true">{expanded ? <FolderOpen /> : <Folder />}</span>{inlineRename?.type === 'group' && inlineRename.id === group.id ? <InlineName className="side-nav__name side-nav__group-label" rename={inlineRename} onChange={onRenameChange} onCommit={onRenameCommit} /> : <span className="side-nav__name side-nav__group-label">{group.name}</span>}<span className="side-nav__group-count">{groupMedia.length}</span></div>
        <div className={`side-nav__group-content ${expanded ? 'is-expanded' : ''}`}><div>{groupMedia.map((item) => <MediaItem key={item.id} item={item} selected={selectedIds.has(item.id)} active={activeId === item.id} inlineRename={inlineRename} transcribing={transcribingMediaId === item.id} queued={queuedTranscriptionIds.has(item.id)} progress={transcriptionProgress} onRenameChange={onRenameChange} onRenameCommit={onRenameCommit} onSelect={onSelect} onContextMenu={onContextMenu} onDragStart={onDragStart} onDragEnd={() => onDragTarget(null)} />)}</div></div>
      </section>;
    })}
    {library.filter((item) => !item.groupId).sort(byName).map((item) => <MediaItem key={item.id} item={item} selected={selectedIds.has(item.id)} active={activeId === item.id} inlineRename={inlineRename} transcribing={transcribingMediaId === item.id} queued={queuedTranscriptionIds.has(item.id)} progress={transcriptionProgress} onRenameChange={onRenameChange} onRenameCommit={onRenameCommit} onSelect={onSelect} onContextMenu={onContextMenu} onDragStart={onDragStart} onDragEnd={() => onDragTarget(null)} />)}
    {!library.length && <p className="side-nav__empty">Your manifest has no media yet.</p>}
  </nav>;
}

function InlineName({ className, rename, onChange, onCommit }) {
  const editorRef = useRef(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  return <span ref={editorRef} className={`${className || ''} side-nav__rename-editor`.trim()} contentEditable suppressContentEditableWarning tabIndex={0} onBlur={(event) => onCommit(event.currentTarget.textContent)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { onChange(null); event.currentTarget.blur(); } }} onClick={(event) => event.stopPropagation()}>{rename.value}</span>;
}

function MediaItem({ item, selected, active, inlineRename, transcribing, queued, progress, onRenameChange, onRenameCommit, onSelect, onContextMenu, onDragStart, onDragEnd }) {
  return <div draggable={!inlineRename} key={item.id} role="button" className={`side-nav__item ${active ? 'is-selected' : ''} ${selected ? 'is-multi-selected' : ''}`} onClick={(event) => { if (inlineRename?.type === 'media' && inlineRename.id === item.id) return; onSelect(item, event); }} onContextMenu={(event) => onContextMenu(event, 'media', item)} onDragStart={(event) => { if (inlineRename) { event.preventDefault(); return; } if (onDragStart) onDragStart(event, item); else event.dataTransfer.setData('text/media-id', item.id); }} onDragEnd={onDragEnd}>
    <span className={`side-nav__media-icon side-nav__media-icon--${item.type || 'video'}`} aria-hidden="true">{item.type === 'audio' ? <Music /> : <Video />}</span>
    {inlineRename?.type === 'media' && inlineRename.id === item.id ? <InlineName className="side-nav__name" rename={inlineRename} onChange={onRenameChange} onCommit={onRenameCommit} /> : <span className="side-nav__name">{item.name}</span>}
    {transcribing && <span className="side-nav__transcription-progress" style={{ '--progress': `${progress}%` }}>{progress}%</span>}
    {!transcribing && queued && <span className="side-nav__transcription-queued">Queued</span>}
    {!transcribing && item.caption && <Check className="side-nav__caption-check" aria-label="Captions available" />}
  </div>;
}

export default App;
