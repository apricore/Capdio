import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, Moon, Pause, Play, Repeat2, SkipBack, SkipForward, Sun, Volume2 } from 'lucide-react';
import './MediaPlayer.css';

const EMPTY_CAPTIONS = [];
const { ipcRenderer } = window.require('electron');

function timestampToSeconds(value) {
  if (typeof value === 'number') return value;
  const parts = String(value ?? '').split(':').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return 0;
  return parts[0] * 60 + parts[1] + parts[2] / 10;
}

function secondsToTimestamp(value) {
  const tenths = Math.max(0, Math.round((Number(value) || 0) * 10));
  return `${Math.floor(tenths / 600)}:${String(Math.floor((tenths % 600) / 10)).padStart(2, '0')}:${tenths % 10}`;
}

/**
 * React version of the legacy qr-audio caption-book player.
 * Captions are read and emitted as: { s: '0:05:0', e: '0:09:4', t: 'Text' }.
 */
export default function MediaPlayer({
  src,
  mediaId,
  initialPosition = 0,
  autoplay = false,
  onPlayingChange,
  onCurrentPosition,
  onPositionChange,
  captions = EMPTY_CAPTIONS,
  className = '',
  dark = false,
  showMedia = false,
  fullscreenRequest = 0,
  videoFullscreenRequest = 0,
  hasCaptions = false,
  transcribing = false,
  queued = false,
  transcriptionProgress = 0,
  onTranscribe,
  volume = 1,
  onVolumeChange,
  onToggleTheme,
}) {
  const playerRef = useRef(null);
  const mediaRef = useRef(null);
  const activeRef = useRef(null);
  const positionRef = useRef(0);
  const hasLoadedSourceRef = useRef(false);
  const hasRestoredPositionRef = useRef(false);
  const onPositionChangeRef = useRef(onPositionChange);
  onPositionChangeRef.current = onPositionChange;
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [repeatSegment, setRepeatSegment] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [normalSplit, setNormalSplit] = useState(() => Number(localStorage.getItem('capdio-player-normal-split')) || 48);
  const [fullscreenSplit, setFullscreenSplit] = useState(() => Number(localStorage.getItem('capdio-player-fullscreen-split')) || 64);

  const entries = useMemo(() => captions.map((caption) => ({
    ...caption,
    start: timestampToSeconds(caption.s ?? caption.start),
    end: timestampToSeconds(caption.e ?? caption.end),
  })), [captions]);

  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(document.fullscreenElement === playerRef.current);
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () => document.removeEventListener('fullscreenchange', updateFullscreen);
  }, []);

  useEffect(() => {
    if (fullscreenRequest) toggleFullscreen();
  }, [fullscreenRequest]);

  useEffect(() => {
    if (videoFullscreenRequest && showMedia) toggleVideoFullscreen();
  }, [videoFullscreenRequest, showMedia]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    hasLoadedSourceRef.current = false;
    hasRestoredPositionRef.current = false;
    media.pause();
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setActiveIndex(-1);
    media.load();
  }, [src]);

  useEffect(() => () => {
    if (hasLoadedSourceRef.current) onPositionChangeRef.current?.(mediaId, positionRef.current);
  }, [src, mediaId]);

  useEffect(() => {
    if (mediaRef.current) mediaRef.current.volume = volume;
  }, [volume, src]);

  useEffect(() => localStorage.setItem('capdio-player-normal-split', String(normalSplit)), [normalSplit]);
  useEffect(() => localStorage.setItem('capdio-player-fullscreen-split', String(fullscreenSplit)), [fullscreenSplit]);

  useEffect(() => {
    if (activeIndex >= 0) {
      activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIndex]);

  function activeAt(time) {
    return entries.findIndex((entry) => time >= entry.start && time < entry.end);
  }

  function updateTime() {
    const media = mediaRef.current;
    if (!media) return;
    const time = media.currentTime;
    setCurrentTime(time);
    positionRef.current = time;
    onCurrentPosition?.(time);
    const repeatingEntry = entries[activeIndex];
    if (repeatSegment && repeatingEntry && time >= repeatingEntry.end - 0.03) {
      media.currentTime = repeatingEntry.start;
      setCurrentTime(repeatingEntry.start);
      return;
    }
    const index = activeAt(time);
    setActiveIndex(index);
  }

  async function play() {
    try {
      await mediaRef.current?.play();
    } catch (error) {
      console.error('Unable to play media:', error);
    }
  }

  function seek(time) {
    const media = mediaRef.current;
    if (!media) return;
    const next = Math.min(Math.max(0, time), Number.isFinite(media.duration) ? media.duration : duration);
    media.currentTime = next;
    positionRef.current = next;
    setCurrentTime(next);
    setActiveIndex(activeAt(next));
  }

  function selectCaption(index, autoplay = true) {
    const entry = entries[index];
    if (!entry) return;
    setActiveIndex(index);
    seek(entry.start);
    if (autoplay) play();
  }

  function handleLoadedMetadata(event) {
    const media = event.currentTarget;
    hasLoadedSourceRef.current = true;
    setDuration(media.duration);
    const target = Math.min(Math.max(0, initialPosition), media.duration || 0);
    const beginPlayback = () => { if (autoplay) media.play().catch(() => {}); };
    if (target > 0.01) {
      hasRestoredPositionRef.current = true;
      media.addEventListener('seeked', beginPlayback, { once: true });
      media.currentTime = target;
      positionRef.current = target;
    } else beginPlayback();
  }

  function handleCanPlay(event) {
    if (hasRestoredPositionRef.current) return;
    const media = event.currentTarget;
    const target = Math.min(Math.max(0, initialPosition), media.duration || 0);
    if (target > 0.01 && Math.abs(media.currentTime - target) > 0.1) {
      hasRestoredPositionRef.current = true;
      media.currentTime = target;
      positionRef.current = target;
    }
  }

  function handleCaptionClick(event, index) {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      return;
    }
    selectCaption(index);
  }

  function copyCaption(event, text) {
    event.preventDefault();
    ipcRenderer.invoke('copy-text', text || '');
  }

  function handleKeys(event) {
    if (event.target.matches('input, textarea')) return;
    if (event.key === ' ') {
      event.preventDefault();
      isPlaying ? mediaRef.current?.pause() : play();
    }
    if (event.key === 'ArrowLeft') seek(currentTime - 5);
    if (event.key === 'ArrowRight') seek(currentTime + 5);
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement === playerRef.current) {
      await document.exitFullscreen();
    } else {
      await playerRef.current?.requestFullscreen();
    }
  }

  async function toggleVideoFullscreen() {
    if (!mediaRef.current) return;
    if (document.fullscreenElement === mediaRef.current) {
      await document.exitFullscreen();
    } else {
      await mediaRef.current.requestFullscreen();
    }
  }

  function beginResize(event) {
    event.preventDefault();
    const onMove = (moveEvent) => {
      const bounds = playerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      if (document.fullscreenElement === playerRef.current) {
        setFullscreenSplit(Math.min(78, Math.max(30, ((bounds.right - moveEvent.clientX) / bounds.width) * 100)));
      } else {
        setNormalSplit(Math.min(72, Math.max(22, ((moveEvent.clientY - bounds.top) / bounds.height) * 100)));
      }
    };
    const onEnd = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd, { once: true });
  }

  return (
    <section ref={playerRef} style={{ '--media-player-normal-split': `${normalSplit}%`, '--media-player-fullscreen-split': `${fullscreenSplit}%` }} className={`media-player ${!showMedia ? 'media-player--audio' : ''} ${dark ? 'media-player--dark' : ''} ${className}`} tabIndex="0" onKeyDown={handleKeys}>
      {showMedia ? <video className="media-player__media" ref={mediaRef} src={src} onTimeUpdate={updateTime} onLoadedMetadata={handleLoadedMetadata} onCanPlay={handleCanPlay} onPlay={() => { setIsPlaying(true); onPlayingChange?.(true); }} onPause={() => { setIsPlaying(false); onPlayingChange?.(false); }} /> : <audio ref={mediaRef} src={src} onTimeUpdate={updateTime} onLoadedMetadata={handleLoadedMetadata} onCanPlay={handleCanPlay} onPlay={() => { setIsPlaying(true); onPlayingChange?.(true); }} onPause={() => { setIsPlaying(false); onPlayingChange?.(false); }} />}

      {showMedia && <div className="media-player__resize-handle" role="separator" aria-label="Resize video and captions" aria-orientation={isFullscreen ? 'vertical' : 'horizontal'} onPointerDown={beginResize} />}

      <div className="media-player__book" aria-label="Captions">
        {entries.map((entry, index) => (
          <article key={`${entry.s}-${entry.e}-${index}`} ref={index === activeIndex ? activeRef : undefined} className={`media-player__mark ${index === activeIndex ? 'is-active' : ''}`} onClick={(event) => handleCaptionClick(event, index)} onContextMenu={(event) => copyCaption(event, entry.t)}>
            <p>{entry.t}</p>
          </article>
        ))}
        {!entries.length && <div className="media-player__empty"><p>No captions yet.</p>{!hasCaptions && (transcribing ? <div className="media-player__transcription-status"><span>Transcribing… {transcriptionProgress}%</span><progress value={transcriptionProgress} max="100">{transcriptionProgress}%</progress></div> : queued ? <p className="media-player__queue-status">Queued for transcription.</p> : <button type="button" onClick={onTranscribe}>Transcribe</button>)}</div>}
      </div>

      <footer className="media-player__controls">
        <input className="media-player__timeline" aria-label="Playback position" type="range" min="0" max={duration || 0} step="0.01" value={Math.min(currentTime, duration || 0)} onChange={(event) => seek(Number(event.target.value))} />
        <div className="media-player__times"><span>{secondsToTimestamp(currentTime).slice(0, -2)}</span><span>{secondsToTimestamp(duration).slice(0, -2)}</span></div>
        <div className="media-player__buttons">
          <label className="media-player__volume" title={`Volume ${Math.round(volume * 100)}%`}><Volume2 /><input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => onVolumeChange?.(Number(event.target.value))} /></label>
          <button type="button" title="Repeat active caption" aria-label="Repeat active caption" className={repeatSegment ? 'is-on' : ''} onClick={() => setRepeatSegment((value) => !value)}><Repeat2 /></button>
          <button type="button" title="Back 5 seconds" aria-label="Back 5 seconds" onClick={() => seek(currentTime - 5)}><SkipBack /></button>
          <button type="button" className="media-player__play" aria-label={isPlaying ? 'Pause' : 'Play'} onClick={() => isPlaying ? mediaRef.current?.pause() : play()}>{isPlaying ? <Pause /> : <Play />}</button>
          <button type="button" title="Forward 5 seconds" aria-label="Forward 5 seconds" onClick={() => seek(currentTime + 5)}><SkipForward /></button>
          <button type="button" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 /> : <Maximize2 />}</button>
          <button type="button" title="Toggle colour theme" aria-label="Toggle colour theme" onClick={onToggleTheme}>{dark ? <Sun /> : <Moon />}</button>
        </div>
      </footer>
    </section>
  );
}
