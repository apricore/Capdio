const { app, BrowserWindow, clipboard, ipcMain, dialog, Menu, globalShortcut, protocol } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const Busboy = require('busboy');
const QRCode = require('qrcode');
const { lookup, openDictionary, setDictionaryTheme } = require('./dictionary');

// Register before the app is ready so Chromium treats capdio as a first-class,
// secure URL scheme. This is required for media elements to issue range requests.
protocol.registerSchemesAsPrivileged([{
    scheme: 'capdio',
    privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true
    }
}]);

// Keep one Capdio process/window per user session. A subsequent launch brings
// the existing window forward instead of starting a second library instance.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const existingWindow = BrowserWindow.getAllWindows()[0];
        if (!existingWindow) return;
        if (existingWindow.isMinimized()) existingWindow.restore();
        existingWindow.show();
        existingWindow.focus();
    });
}

const runtimeRoot = app.isPackaged ? process.resourcesPath : __dirname;
const platformBinaryDirectory = path.join(runtimeRoot, 'bin', `${process.platform}-${process.arch}`);
const bundledDevelopmentPython = path.join(__dirname, '.venv-packaging', 'Scripts', 'python.exe');
const defaultDevelopmentPython = process.platform === 'win32' ? 'python' : 'python3';
const developmentPythonExecutable = process.env.CAPDIO_PYTHON
    || (fsSync.existsSync(bundledDevelopmentPython) ? bundledDevelopmentPython : defaultDevelopmentPython);
const ffmpegExecutable = app.isPackaged
    ? path.join(platformBinaryDirectory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    : (process.env.CAPDIO_FFMPEG || require('ffmpeg-static') || 'ffmpeg');
const stagedDevelopmentYtDlp = path.join(__dirname, 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const ytDlpExecutable = app.isPackaged
    ? path.join(platformBinaryDirectory, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
    : (process.env.CAPDIO_YT_DLP || (fsSync.existsSync(stagedDevelopmentYtDlp) ? stagedDevelopmentYtDlp : 'yt-dlp'));
const transcriberExecutable = app.isPackaged
    ? path.join(platformBinaryDirectory, 'capdio-transcribe', process.platform === 'win32' ? 'capdio-transcribe.exe' : 'capdio-transcribe')
    : developmentPythonExecutable;
const whisperModelDirectory = app.isPackaged ? path.join(runtimeRoot, 'models') : null;
const defaultLibraryRoot = app.isPackaged ? path.join(app.getPath('userData'), 'library') : path.join(__dirname, 'library');
const libraryLocationConfigPath = path.join(app.getPath('userData'), 'library-path.txt');
let libraryRoot = defaultLibraryRoot;

// The assisted Windows installer writes this small pointer after the user picks
// a library location. Development always keeps its library inside the project.
if (app.isPackaged) {
    try {
        const configuredPath = fsSync.readFileSync(libraryLocationConfigPath, 'utf8').trim();
        if (configuredPath) libraryRoot = path.resolve(configuredPath);
    } catch {
        // First launch or an older installation: use the standard user-data path.
    }
}
const mediaDirectory = path.join(libraryRoot, 'media');
const captionDirectory = path.join(libraryRoot, 'caption');
const metadataDirectory = path.join(libraryRoot, 'metadata');
const manifestPath = path.join(libraryRoot, 'manifest.json');

function mediaType(filePath) {
    return ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(path.extname(filePath).toLowerCase()) ? 'audio' : 'video';
}

function mediaMimeType(filePath) {
    const types = {
        '.aac': 'audio/aac', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
        '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
        '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.mp4': 'video/mp4',
        '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.webm': 'video/webm'
    };
    return types[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const supportedMediaExtensions = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.mp4', '.mkv', '.avi', '.mov', '.webm']);
const deletingMediaIds = new Set();
const pendingMetadataWrites = new Map();

function trackMetadataWrite(mediaId, promise) {
    if (!pendingMetadataWrites.has(mediaId)) pendingMetadataWrites.set(mediaId, new Set());
    pendingMetadataWrites.get(mediaId).add(promise);
    promise.finally(() => {
        const pending = pendingMetadataWrites.get(mediaId);
        pending?.delete(promise);
        if (!pending?.size) pendingMetadataWrites.delete(mediaId);
    }).catch(() => {});
    return promise;
}

async function prepareMetadataDeletion(mediaIds) {
    for (const id of mediaIds) deletingMediaIds.add(id);
    await Promise.all(mediaIds.flatMap((id) => [...(pendingMetadataWrites.get(id) || [])].map((promise) => promise.catch(() => {}))));
}
let uploadSessionServer = null;
let uploadSessionQueue = [];
let uploadSessionRunning = false;
let uploadSessionCurrent = null;
const uploadSessionRecords = new Map();
const uploadImportWaiters = new Map();
const activeUploadRequests = new Set();

function uploadHost() {
    return Object.entries(os.networkInterfaces()).find(([name]) =>
        /wi-?fi|wlan|wlp|en0/i.test(name)
    )?.[1].find(addr =>
        addr.family === 'IPv4' && !addr.internal
    )?.address || '127.0.0.1';
}

function sendUploadStatus(payload) {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('upload-status', payload);
}

async function readManifest() {
    try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        return {
            version: 1,
            groups: Array.isArray(manifest.groups) ? manifest.groups : [],
            media: Array.isArray(manifest.media) ? manifest.media : []
        };
    } catch (error) {
        if (error.code === 'ENOENT') return { version: 1, groups: [], media: [] };
        throw new Error(`Could not read manifest.json: ${error.message}`);
    }
}

async function writeManifest(manifest) {
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function metadataPath(id) { return path.join(metadataDirectory, `${id}.json`); }
async function readMetadata(id) {
    try { return JSON.parse(await fs.readFile(metadataPath(id), 'utf8')); } catch (error) {
        if (error.code === 'ENOENT') return { name: id, groupId: null, volume: 1, extension: '' };
        throw error;
    }
}
async function writeMetadata(id, metadata) {
    await fs.mkdir(metadataDirectory, { recursive: true });
    await fs.writeFile(metadataPath(id), `${JSON.stringify(metadata, null, 2)}\n`);
}
function mediaPathFor(item) { return path.join(mediaDirectory, `${item.id}${item.extension}`); }
function captionPathFor(item) { return path.join(captionDirectory, `${item.id}.captions.json`); }

const themeConfigPath = path.join(app.getPath('userData'), 'theme.json');
let darkTheme = true;
try {
    darkTheme = JSON.parse(fsSync.readFileSync(themeConfigPath, 'utf8')).dark !== false;
} catch { /* Use the default theme until the renderer supplies its preference. */ }
function createWindow() {
    const win = new BrowserWindow({
        width: 1000,
        height: 700,
        frame: false,
        show: false,
        backgroundColor: darkTheme ? '#111827' : '#f4f6fb',
        icon: path.join(__dirname, 'assets', 'capdio-icon.png'),

        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    if (app.isPackaged) {
        win.loadFile(path.join(__dirname, 'dist', 'index.html'));
    } else {
        win.loadURL('http://localhost:5173');
    }
    win.once('ready-to-show', () => win.show());
    win.on('focus', () => win.webContents.send('player-window-focused'));
    win.on('blur', () => win.webContents.send('player-window-blurred'));
    win.on('close', (event) => {
        if (win.__capdioCloseAllowed) return;
        event.preventDefault();
        win.webContents.send('save-before-close');
        setTimeout(() => { if (!win.isDestroyed()) { win.__capdioCloseAllowed = true; win.close(); } }, 1200);
    });
}

ipcMain.handle('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle('window-toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) {
        win.unmaximize();
        return false;
    }
    win.maximize();
    return true;
});

ipcMain.handle('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) { win.__capdioCloseAllowed = true; win.close(); }
});

ipcMain.handle('toggle-developer-tools', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.toggleDevTools();
});

ipcMain.handle('select-file', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
            {
                name: 'Audio / Video',
                extensions: [
                    'mp3',
                    'wav',
                    'm4a',
                    'aac',
                    'flac',
                    'ogg',
                    'mp4',
                    'mkv',
                    'avi',
                    'mov',
                    'webm'
                ]
            },
            {
                name: 'All Files',
                extensions: ['*']
            }
        ]
    });

    if (result.canceled) {
        return null;
    }

    return result.filePaths[0];
});

ipcMain.handle('get-library', async () => {
    const manifest = await readManifest();
    const media = await Promise.all(manifest.media.map(async (item) => {
        const metadata = await readMetadata(item.id);
        const mediaPath = mediaPathFor(item);
        const captionPath = captionPathFor(item);
        let captions = [];
        try { const caption = JSON.parse(await fs.readFile(captionPath, 'utf8')); captions = Array.isArray(caption.captions) ? caption.captions : []; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return {
            ...item,
            ...metadata, caption: (await fs.access(captionPath).then(() => `caption/${item.id}.captions.json`).catch(() => null)),
            type: item.type,
            media: `media/${item.id}${item.extension}`,
            absolutePath: mediaPath,
            playbackPath: `capdio://library/media/${item.id}${item.extension}`,
            captions
        };
    }));
    return { groups: manifest.groups, media };
});

ipcMain.handle('select-files', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Audio / Video', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mkv', 'avi', 'mov', 'webm'] }]
    });
    return result.canceled ? [] : result.filePaths;
});

function cleanName(value, type) {
    const name = String(value || '').trim();
    if (!name) throw new Error(`${type} name cannot be empty.`);
    if (name.length > 120) throw new Error(`${type} name is too long.`);
    return name;
}

ipcMain.handle('create-group', async (event, name) => {
    const manifest = await readManifest();
    const group = { id: crypto.randomUUID(), name: cleanName(name, 'Group') };
    manifest.groups.push(group);
    await writeManifest(manifest);
    return group;
});

ipcMain.handle('rename-library-item', async (event, type, id, name) => {
    const manifest = await readManifest();
    const collection = type === 'group' ? manifest.groups : manifest.media;
    const item = collection.find((entry) => entry.id === id);
    if (!item) throw new Error(`${type} was not found.`);
    if (type === 'media') {
        const metadata = await readMetadata(id);
        metadata.name = cleanName(name, 'Media');
        await writeMetadata(id, metadata);
        return { ...item, ...metadata };
    }
    item.name = cleanName(name, type === 'group' ? 'Group' : 'Media');
    await writeManifest(manifest);
    return item;
});

ipcMain.handle('move-media-to-group', async (event, mediaIds, groupId) => {
    const manifest = await readManifest();
    if (groupId !== null && !manifest.groups.some((group) => group.id === groupId)) {
        throw new Error('Group was not found.');
    }
    const ids = new Set(Array.isArray(mediaIds) ? mediaIds : []);
    const moving = manifest.media.filter((item) => ids.has(item.id));
    await Promise.all(moving.map(async (item) => {
        const metadata = await readMetadata(item.id);
        metadata.groupId = groupId;
        await writeMetadata(item.id, metadata);
    }));
    return moving;
});

ipcMain.handle('delete-media', async (event, mediaIds) => {
    const manifest = await readManifest();
    const ids = new Set(Array.isArray(mediaIds) ? mediaIds : []);
    const removing = manifest.media.filter((item) => ids.has(item.id));
    await prepareMetadataDeletion(removing.map((item) => item.id));
    await Promise.all(removing.flatMap((item) => {
        const files = [fs.unlink(mediaPathFor(item)).catch(() => {}), fs.unlink(metadataPath(item.id)).catch(() => {})];
        files.push(fs.unlink(captionPathFor(item)).catch(() => {}));
        return files;
    }));
    manifest.media = manifest.media.filter((item) => !ids.has(item.id));
    await writeManifest(manifest);
    return [...ids];
});

ipcMain.handle('delete-group', async (event, groupId) => {
    const manifest = await readManifest();
    const group = manifest.groups.find((item) => item.id === groupId);
    if (!group) throw new Error('Group was not found.');
    const removing = manifest.media.filter((item) => item.groupId === groupId);
    await prepareMetadataDeletion(removing.map((item) => item.id));
    await Promise.all(removing.flatMap((item) => {
        const files = [fs.unlink(mediaPathFor(item)).catch(() => {}), fs.unlink(metadataPath(item.id)).catch(() => {}), fs.unlink(captionPathFor(item)).catch(() => {})];
        return files;
    }));
    manifest.groups = manifest.groups.filter((item) => item.id !== groupId);
    manifest.media = manifest.media.filter((item) => item.groupId !== groupId);
    await writeManifest(manifest);
    return { groupId, mediaIds: removing.map((item) => item.id) };
});

function exportName(value, fallback) {
    let name = String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return name;
}

ipcMain.handle('export-group', async (event, groupId) => {
    const manifest = await readManifest();
    const group = manifest.groups.find((entry) => entry.id === groupId);
    if (!group) throw new Error('The group was not found.');
    const entries = [];
    for (const item of manifest.media) {
        const metadata = await readMetadata(item.id);
        if (metadata.groupId !== groupId) continue;
        const source = path.resolve(mediaPathFor(item));
        const relative = path.relative(mediaDirectory, source);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid media path.');
        await fs.access(source);
        const extension = path.extname(source);
        let name = exportName(metadata.name, item.id);
        if (!name.toLowerCase().endsWith(extension.toLowerCase())) name += extension;
        entries.push({ source, name });
    }
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: `Export ${group.name} — choose destination`,
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    const parent = await fs.realpath(result.filePaths[0]);
    const relative = path.relative(await fs.realpath(libraryRoot), parent);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        throw new Error('Choose a destination outside the Capdio library.');
    }
    const folderName = exportName(group.name, 'Exported group');
    let destination;
    for (let suffix = 0; ; suffix += 1) {
        destination = path.join(parent, suffix ? `${folderName} (${suffix})` : folderName);
        try { await fs.mkdir(destination); break; } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
    }
    let count = 0;
    try {
        for (const entry of entries) {
            const parsed = path.parse(entry.name);
            for (let suffix = 0; ; suffix += 1) {
                const name = suffix ? `${parsed.name} (${suffix})${parsed.ext}` : entry.name;
                try {
                    await fs.copyFile(entry.source, path.join(destination, name), fsSync.constants.COPYFILE_EXCL);
                    break;
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                }
            }
            count += 1;
        }
    } catch (error) {
        throw new Error(`Export stopped after ${count} of ${entries.length} files. Saved copies are in ${destination}. ${error.message}`);
    }
    return { destination, count };
});
ipcMain.handle('export-media', async (event, mediaId) => {
    const manifest = await readManifest();
    const item = manifest.media.find((entry) => entry.id === mediaId);
    if (!item) throw new Error('The media item was not found.');
    const source = path.resolve(mediaPathFor(item));
    const relative = path.relative(mediaDirectory, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid media path.');
    const metadata = await readMetadata(mediaId);
    const extension = path.extname(source);
    let name = String(metadata.name || mediaId).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || mediaId;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    if (!name.toLowerCase().endsWith(extension.toLowerCase())) name += extension;
    const options = {
        title: 'Export media',
        defaultPath: path.join(app.getPath('downloads'), name),
        filters: [{ name: item.type === 'audio' ? 'Audio' : 'Video', extensions: [extension.slice(1)] }]
    };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(parent, options);
    if (result.canceled || !result.filePath) return null;
    // Export a copy; never overwrite files inside the managed library.
    const destination = path.resolve(result.filePath);
    const libraryRelative = path.relative(libraryRoot, destination);
    if (!libraryRelative.startsWith('..') && !path.isAbsolute(libraryRelative)) {
        throw new Error('Choose a save location outside the Capdio library.');
    }
    await fs.copyFile(source, destination);
    return destination;
});
async function importMediaFile(sourceFile, groupId = null, originalName = path.basename(sourceFile)) {
    if (!sourceFile || typeof sourceFile !== 'string') {
        throw new Error('A media file is required.');
    }

    await fs.mkdir(mediaDirectory, { recursive: true });
    await fs.mkdir(captionDirectory, { recursive: true }); await fs.mkdir(metadataDirectory, { recursive: true });

    const sourceName = path.basename(originalName);
    const extension = path.extname(sourceName);
    const id = crypto.randomUUID();
    const destination = path.join(mediaDirectory, `${id}${extension}`);
    await fs.copyFile(sourceFile, destination);

    const manifest = await readManifest();
    if (groupId !== null && !manifest.groups.some((group) => group.id === groupId)) {
        throw new Error('Group was not found.');
    }
    const item = {
        id,
        type: mediaType(sourceName), extension,
        importedAt: new Date().toISOString()
    };
    manifest.media.push(item);
    await writeManifest(manifest);
    await writeMetadata(id, { name: path.parse(sourceName).name, groupId, volume: 1, loop: false });
    return {
        ...item,
        absolutePath: destination,
        playbackPath: `capdio://library/media/${id}${extension}`,
        media: `media/${id}${extension}`, caption: null, name: path.parse(sourceName).name, groupId, volume: 1, loop: false
    };
}

ipcMain.handle('import-media', (event, sourceFile, groupId = null) => {
    return importMediaFile(sourceFile, groupId);
});

let activeUrlDownload = null;
let lastUrlDiscovery = null;

function sendUrlDownloadStatus(sender, message) {
    if (activeUrlDownload) activeUrlDownload.progressMessage = message;
    if (sender && !sender.isDestroyed()) sender.send('url-download-status', message);
}

function runProcess(executable, arguments_, onLine, timeoutMs = 15 * 60 * 1000, signal = null) {
    return new Promise((resolve, reject) => {
        const isYtDlp = /^yt-dlp(?:\.exe)?$/i.test(path.basename(executable));
        const child = spawn(executable, arguments_, {
            windowsHide: true,
            // yt-dlp can launch Electron as a Node-compatible JavaScript
            // runtime for YouTube's player challenges. This also works in the
            // packaged app, where a separate system Node install may not exist.
            env: isYtDlp ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
        });
        let stderr = '';
        let settled = false;
        let terminationError = null;
        let stopPromise = null;
        let forceFinishTimer = null;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearTimeout(forceFinishTimer);
            signal?.removeEventListener('abort', abort);
            callback(value);
        };
        const requestStop = (error) => {
            if (settled || terminationError) return;
            terminationError = error;
            if (process.platform === 'win32' && child.pid) {
                // yt-dlp can launch FFmpeg. Killing only the parent leaves the
                // child holding its output file open, so terminate the complete
                // Windows process tree and wait for taskkill to finish.
                stopPromise = new Promise((resolveStop) => {
                    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
                    killer.once('error', () => { child.kill(); resolveStop(); });
                    killer.once('close', resolveStop);
                });
            } else {
                child.kill();
                stopPromise = Promise.resolve();
            }
            // Normally 'close' fires after all stdio handles are released. Do
            // not block forever if a broken child ignores termination.
            forceFinishTimer = setTimeout(() => finish(reject, error), 10000);
        };
        const timeout = setTimeout(() => {
            requestStop(new Error(`${path.basename(executable)} stopped responding and was cancelled.`));
        }, timeoutMs);
        const abort = () => requestStop(new Error('Download cancelled.'));
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (data) => onLine?.(data.toString()));
        child.stderr.on('data', (data) => {
            stderr = `${stderr}${data}`.slice(-12000);
            onLine?.(data.toString());
        });
        child.once('error', (error) => finish(reject, error));
        child.once('close', (code) => {
            if (terminationError) {
                Promise.resolve(stopPromise).then(() => finish(reject, terminationError));
            } else if (code === 0) {
                finish(resolve);
            } else {
                finish(reject, new Error(stderr.trim() || `${path.basename(executable)} exited with code ${code}.`));
            }
        });
    });
}

async function removeStagedFile(filePath, reportFailure = true) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
            await fs.unlink(filePath);
            return;
        } catch (error) {
            if (error.code === 'ENOENT') return;
            if (attempt === 11) {
                if (reportFailure) console.error(`Unable to remove staged download ${filePath}:`, error.message);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
}

async function downloadDirectMedia(url, destination, headers, signal, onProgress) {
    const response = await fetch(url, {
        redirect: 'follow',
        signal,
        headers: Object.fromEntries(headers.map((header) => {
            const separator = header.indexOf(':');
            return [header.slice(0, separator), header.slice(separator + 1).trim()];
        }))
    });
    if (!response.ok) throw new Error(`The media server returned HTTP ${response.status}.`);
    const contentType = response.headers.get('content-type') || '';
    if (/^(?:text\/html|application\/(?:json|xml))/i.test(contentType)) {
        throw new Error(`The URL returned ${contentType} instead of a media file.`);
    }
    if (!response.body) throw new Error('The media server returned an empty response.');
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    let lastUpdate = 0;
    const progress = new Transform({
        transform(chunk, _encoding, callback) {
            received += chunk.length;
            const now = Date.now();
            if (now - lastUpdate > 200) {
                lastUpdate = now;
                onProgress(total ? Math.min(99, Math.round(received / total * 100)) : null, received);
            }
            callback(null, chunk);
        }
    });
    await pipeline(Readable.fromWeb(response.body), progress, fsSync.createWriteStream(destination), { signal });
    if (!received) throw new Error('The media server returned an empty file.');
    if (path.extname(destination).toLowerCase() === '.mp4') {
        const handle = await fs.open(destination, 'r');
        try {
            const header = Buffer.alloc(64);
            const { bytesRead } = await handle.read(header, 0, header.length, 0);
            if (!header.subarray(0, bytesRead).includes(Buffer.from('ftyp'))) {
                throw new Error('The URL did not return a valid MP4 file.');
            }
        } finally {
            await handle.close();
        }
    }
    onProgress(100, received);
}

function sendUrlDownloadItemStatus(sender, url, state, details = {}) {
    if (sender && !sender.isDestroyed()) sender.send('url-download-item-status', { url, state, ...details });
}

async function clearUrlDownloadStaging() {
    const stagingDirectory = path.join(libraryRoot, '.downloads');
    await fs.mkdir(stagingDirectory, { recursive: true });
    const entries = await fs.readdir(stagingDirectory);
    await Promise.all(entries.map((name) => fs.rm(path.join(stagingDirectory, name), {
        recursive: true,
        force: true,
        maxRetries: 12,
        retryDelay: 200
    })));
}

function safeDownloadName(value) {
    return String(value || 'Downloaded video').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'Downloaded video';
}

function parseHttpUrl(rawUrl) {
    const value = String(rawUrl || '').trim();
    const markdownLink = /^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/i.exec(value);
    let parsed;
    try { parsed = new URL(markdownLink ? markdownLink[1] : value); } catch { throw new Error('Enter a valid webpage or media URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
    return parsed;
}

function abortableDelay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, milliseconds);
        function done() {
            signal?.removeEventListener('abort', abort);
            resolve();
        }
        function abort() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(new Error('Download cancelled.'));
        }
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
    });
}

async function findRenderedMedia(pageUrl, sender, signal = null) {
    const candidates = new Map();
    const rejectedCandidates = new Set();
    const add = (url, type = '') => {
        try {
            const absolute = new URL(url, pageUrl).href;
            if (!/^https?:/i.test(absolute)) return;
            if (rejectedCandidates.has(absolute)) return;
            // These are individual adaptive-stream chunks, not independently
            // playable media. Their parent .mpd/.m3u8 manifest is captured and
            // passed to FFmpeg instead.
            if (/\.(?:m4s|cmfv|cmfa|ts)(?:$|[?#])/i.test(absolute)) return;
            const score = (/\.m3u8(?:$|\?)/i.test(absolute) ? 90 : /\.mpd(?:$|\?)/i.test(absolute) ? 85 : /\.(?:mp4|webm|mov|mkv|m4v)(?:$|\?)/i.test(absolute) ? 70 : /^video\//i.test(type) ? 60 : /^audio\//i.test(type) ? 25 : 0);
            if (score) candidates.set(absolute, Math.max(score, candidates.get(absolute) || 0));
        } catch { /* Ignore malformed URLs exposed by page scripts. */ }
    };
    const inspector = new BrowserWindow({ show: false, width: 1024, height: 720, webPreferences: { sandbox: true, contextIsolation: true } });
    // Detection pages may autoplay media or advertisements even though their
    // window is hidden. Mute the complete WebContents before navigation so
    // HTML media and Web Audio cannot leak sound while the page is inspected.
    inspector.webContents.setAudioMuted(true);
    const abortInspection = () => { if (!inspector.isDestroyed()) inspector.destroy(); };
    signal?.addEventListener('abort', abortInspection, { once: true });
    const filter = { urls: ['http://*/*', 'https://*/*'] };
    const beforeRequest = (details, callback) => {
        add(details.url, details.resourceType === 'media' ? 'video/unknown' : '');
        callback({});
    };
    const headersReceived = (details, callback) => {
        const contentType = details.responseHeaders?.['content-type']?.[0] || details.responseHeaders?.['Content-Type']?.[0] || '';
        if (/^(?:text\/html|application\/(?:json|xml))/i.test(contentType)) {
            try {
                const absolute = new URL(details.url, pageUrl).href;
                rejectedCandidates.add(absolute);
                candidates.delete(absolute);
            } catch { /* Ignore malformed response URLs. */ }
        } else {
            add(details.url, contentType);
        }
        callback({ responseHeaders: details.responseHeaders });
    };
    inspector.webContents.session.webRequest.onBeforeRequest(filter, beforeRequest);
    inspector.webContents.session.webRequest.onHeadersReceived(filter, headersReceived);
    try {
        sendUrlDownloadStatus(sender, 'Opening webpage and detecting media…');
        await Promise.race([
            inspector.loadURL(pageUrl, { userAgent: inspector.webContents.getUserAgent() }),
            abortableDelay(30000, signal).then(() => { throw new Error('The webpage took too long to load.'); })
        ]);
        await abortableDelay(4500, signal);
        let page = { title: pageUrl.hostname, urls: [] };
        try {
            page = await inspector.webContents.executeJavaScript(`(() => {
                const domUrls = [];
                for (const element of document.querySelectorAll('video, audio')) {
                    try {
                        const source = element.currentSrc || element.src || element.querySelector('source')?.src;
                        if (source) domUrls.push(source);
                    } catch { /* Keep inspecting the remaining media elements. */ }
                }
                const found = new Set(domUrls);
                try {
                    performance.getEntriesByType('resource').forEach((entry) => found.add(entry.name));
                } catch { /* Resource timing may be restricted by the page. */ }
                try {
                    const urlPattern = /https?:\\/\\/[^\\s"'<>\\\\]+/g;
                    document.querySelectorAll('script:not([src])').forEach((script) => {
                        for (const url of ((script.textContent || '').match(urlPattern) || [])) {
                            found.add(url.replace(/\\\\u0026/g, '&').replace(/\\\\\//g, '/'));
                        }
                    });
                } catch { /* Inline script scanning is optional. */ }
                return { title: document.title, urls: [...found], domUrls: [...new Set(domUrls)] };
            })()`, true);
        } catch (error) {
            // Some pages continuously navigate, tear down their renderer, or
            // prohibit page-world evaluation. Network observation above still
            // discovers media requested by those pages, so do not discard it.
            console.warn('Page DOM media inspection was unavailable:', error.message);
            sendUrlDownloadStatus(sender, 'Page script inspection was blocked; checking captured media requests…');
        }
        for (const url of page.urls || []) add(url);
        const cookies = await inspector.webContents.session.cookies.get({ url: pageUrl });
        const domMediaUrls = [...new Set((page.domUrls || []).filter((url) => {
            try {
                const absolute = new URL(url, pageUrl).href;
                return /^https?:/i.test(absolute) && !/\.(?:m4s|cmfv|cmfa|ts)(?:$|[?#])/i.test(absolute);
            } catch { return false; }
        }).map((url) => new URL(url, pageUrl).href))];
        return {
            title: safeDownloadName(page.title),
            // A page may request dozens of rendition playlists for ten actual
            // video elements. Prefer one active source per element so quality
            // variants and separate tracks are not presented as extra videos.
            mediaUrls: domMediaUrls.length ? domMediaUrls : [...candidates].sort((a, b) => b[1] - a[1]).map(([url]) => url),
            cookieHeader: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
            userAgent: inspector.webContents.getUserAgent()
        };
    } finally {
        inspector.webContents.session.webRequest.onBeforeRequest(filter, null);
        inspector.webContents.session.webRequest.onHeadersReceived(filter, null);
        signal?.removeEventListener('abort', abortInspection);
        if (!inspector.isDestroyed()) inspector.destroy();
    }
}

ipcMain.handle('discover-url-media', async (event, rawUrl) => {
    let pageUrl;
    try { pageUrl = parseHttpUrl(rawUrl); } catch (error) {
        return { cancelled: false, available: [], error: error.message };
    }
    if (activeUrlDownload?.running) {
        return { cancelled: false, available: [], error: 'Another URL task is already running.' };
    }
    const directExtension = path.extname(pageUrl.pathname).toLowerCase();
    if (supportedMediaExtensions.has(directExtension)) {
        const name = decodeURIComponent(path.posix.basename(pageUrl.pathname)) || `media${directExtension}`;
        const found = {
            title: safeDownloadName(path.parse(name).name),
            mediaUrls: [pageUrl.href],
            cookieHeader: '',
            userAgent: BrowserWindow.fromWebContents(event.sender)?.webContents.getUserAgent() || 'Mozilla/5.0'
        };
        lastUrlDiscovery = { pageUrl: pageUrl.href, found };
        return {
            cancelled: false,
            available: [{
                id: crypto.createHash('sha1').update(pageUrl.href).digest('hex'),
                url: pageUrl.href,
                name,
                type: directExtension.slice(1).toUpperCase(),
                host: pageUrl.host
            }]
        };
    }
    const controller = new AbortController();
    activeUrlDownload = { running: true, url: pageUrl.href, progressMessage: 'Opening webpage and detecting media...', controller };
    try {
        try {
            sendUrlDownloadStatus(event.sender, 'Checking the URL with the media extractor…');
            let extractorOutput = '';
            await runProcess(ytDlpExecutable, [
                '--js-runtimes', `node:${process.execPath}`,
                '--no-playlist', '--skip-download', '--dump-single-json', '--quiet', '--no-warnings', pageUrl.href
            ], (output) => { extractorOutput += output; }, 60000, controller.signal);
            const info = JSON.parse(extractorOutput.trim());
            const title = safeDownloadName(info.title || pageUrl.hostname);
            const found = {
                title,
                mediaUrls: [pageUrl.href],
                cookieHeader: '',
                userAgent: info.http_headers?.['User-Agent'] || 'Mozilla/5.0',
                extractorPage: true
            };
            lastUrlDiscovery = { pageUrl: pageUrl.href, found };
            return {
                cancelled: false,
                available: [{
                    id: crypto.createHash('sha1').update(pageUrl.href).digest('hex'),
                    url: pageUrl.href,
                    name: title,
                    type: String(info.extractor_key || info.extractor || 'WEB VIDEO').toUpperCase(),
                    host: pageUrl.host
                }]
            };
        } catch (extractorError) {
            if (controller.signal.aborted) return { cancelled: true, available: [] };
            // Unsupported sites and development installs without yt-dlp fall
            // through to rendered-page inspection.
        }
        const found = await findRenderedMedia(pageUrl.href, event.sender, controller.signal);
        lastUrlDiscovery = { pageUrl: pageUrl.href, found };
        const available = found.mediaUrls.map((url, index) => {
            const parsed = new URL(url);
            const fileName = decodeURIComponent(path.posix.basename(parsed.pathname)) || `Media ${index + 1}`;
            const type = /\.m3u8(?:$|\?)/i.test(url) ? 'HLS' : /\.mpd(?:$|\?)/i.test(url) ? 'DASH' : (path.extname(parsed.pathname).slice(1).toUpperCase() || 'MEDIA');
            return { id: crypto.createHash('sha1').update(url).digest('hex'), url, name: fileName, type, host: parsed.host };
        });
        return { cancelled: false, available };
    } catch (error) {
        if (controller.signal.aborted) return { cancelled: true, available: [] };
        const message = /^ERR_[A-Z_]+/.test(error.message)
            ? 'The webpage could not be loaded. Check the URL and make sure the server is reachable.'
            : error.message;
        return { cancelled: false, available: [], error: message };
    } finally {
        activeUrlDownload.running = false;
    }
});

ipcMain.handle('get-url-download-state', () => activeUrlDownload ? {
    running: activeUrlDownload.running,
    url: activeUrlDownload.url,
    progressMessage: activeUrlDownload.progressMessage
} : null);

ipcMain.handle('cancel-url-download', () => {
    if (!activeUrlDownload?.running) return false;
    activeUrlDownload.progressMessage = 'Cancelling download...';
    activeUrlDownload.controller.abort();
    return true;
});

ipcMain.handle('download-from-url', async (event, rawUrl, selectedUrls = []) => {
    const pageUrl = parseHttpUrl(rawUrl);

    const sender = event.sender;
    if (activeUrlDownload?.running) throw new Error('Another URL download is already running.');
    const controller = new AbortController();
    activeUrlDownload = { running: true, url: pageUrl.href, progressMessage: 'Preparing download...', controller };
    const stagingDirectory = path.join(libraryRoot, '.downloads');
    await fs.mkdir(stagingDirectory, { recursive: true });
    const token = crypto.randomUUID();
    const outputTemplate = path.join(stagingDirectory, `${token}.%(autonumber)03d.%(ext)s`);
    const resultListPath = path.join(stagingDirectory, `${token}.result.txt`);
    const downloadedFiles = [];
    const items = [];
    const failures = [];
    const completedUrls = new Set();
    const useExtractorSelection = selectedUrls.length === 1
        && selectedUrls[0] === pageUrl.href
        && lastUrlDiscovery?.pageUrl === pageUrl.href
        && lastUrlDiscovery.found.extractorPage;
    let downloadedTitle = pageUrl.hostname;
    if (useExtractorSelection) downloadedTitle = lastUrlDiscovery.found.title;

    try {
        for (const url of selectedUrls) sendUrlDownloadItemStatus(sender, url, 'queued');
        sendUrlDownloadStatus(sender, selectedUrls.length ? 'Preparing selected media…' : 'Checking the page for media…');
        try {
            if (selectedUrls.length && !useExtractorSelection) {
                const selection = new Error('Use selected browser media.');
                selection.isMediaSelection = true;
                throw selection;
            }
            if (useExtractorSelection) sendUrlDownloadItemStatus(sender, pageUrl.href, 'downloading', { position: 1, total: 1 });
            const extractorArguments = [
                '--js-runtimes', `node:${process.execPath}`,
                useExtractorSelection ? '--no-playlist' : '--yes-playlist', '--no-part', '--newline', '--restrict-filenames', '--windows-filenames',
                '--ffmpeg-location', ffmpegExecutable, '--merge-output-format', 'mp4',
                '--print-to-file', 'after_move:%(filepath)s', resultListPath,
                '-f', 'bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/bv*+ba/b', '-o', useExtractorSelection ? path.join(stagingDirectory, `${token}.%(ext)s`) : outputTemplate, pageUrl.href
            ];
            await runProcess(ytDlpExecutable, extractorArguments, (output) => {
                const percentage = /\[download\]\s+([\d.]+)%/.exec(output)?.[1];
                if (percentage) sendUrlDownloadStatus(sender, `Downloading page media… ${Math.round(Number(percentage))}%`);
            }, 15 * 60 * 1000, controller.signal);
            const reportedFiles = (await fs.readFile(resultListPath, 'utf8').catch(() => ''))
                .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
            for (const reportedFile of reportedFiles) {
                const resolved = path.resolve(reportedFile);
                const relative = path.relative(stagingDirectory, resolved);
                if (!relative.startsWith('..') && !path.isAbsolute(relative) && await fs.stat(resolved).then((stat) => stat.isFile()).catch(() => false)) {
                    downloadedFiles.push(resolved);
                }
            }
            if (!downloadedFiles.length) {
                const producedFiles = (await fs.readdir(stagingDirectory))
                    .filter((name) => name.startsWith(`${token}.`) && !name.endsWith('.part') && name !== path.basename(resultListPath) && !/\.f\d+\./i.test(name));
                downloadedFiles.push(...producedFiles.map((name) => path.join(stagingDirectory, name)));
            }
        } catch (extractorError) {
            if (controller.signal.aborted) throw new Error('Download cancelled.');
            if (useExtractorSelection) {
                failures.push({ url: pageUrl.href, error: 'The media extractor could not download this video.' });
                sendUrlDownloadItemStatus(sender, pageUrl.href, 'failed', { error: failures[0].error });
                return { cancelled: false, items, failures };
            }
            if (!extractorError.isMediaSelection && extractorError.code !== 'ENOENT' && !/not recognized|ENOENT/i.test(extractorError.message)) {
                console.warn('yt-dlp fallback:', extractorError.message);
            }
            const cachedDiscovery = lastUrlDiscovery?.pageUrl === pageUrl.href ? lastUrlDiscovery.found : null;
            const found = selectedUrls.length && cachedDiscovery
                ? { ...cachedDiscovery, mediaUrls: [...cachedDiscovery.mediaUrls] }
                : await findRenderedMedia(pageUrl.href, sender, controller.signal);
            if (selectedUrls.length) {
                found.mediaUrls = [...new Set(selectedUrls)].filter((url) => {
                    try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
                });
            }
            if (!found.mediaUrls.length) {
                throw new Error('No downloadable media request was detected. The site may require interaction, reject its TLS certificate, or use DRM-protected media.');
            }
            downloadedTitle = found.title || downloadedTitle;
            const headers = [`Referer: ${pageUrl.href}`, `User-Agent: ${found.userAgent}`];
            if (found.cookieHeader) headers.push(`Cookie: ${found.cookieHeader}`);

            for (const [index, mediaUrl] of found.mediaUrls.entries()) {
                const directExtension = path.extname(new URL(mediaUrl).pathname).toLowerCase();
                const isDirectMedia = supportedMediaExtensions.has(directExtension);
                const downloadedFile = path.join(stagingDirectory, `${token}.${String(index + 1).padStart(3, '0')}${isDirectMedia ? directExtension : '.mp4'}`);
                sendUrlDownloadItemStatus(sender, mediaUrl, 'downloading', { position: index + 1, total: found.mediaUrls.length });
                sendUrlDownloadStatus(sender, `Downloading media ${index + 1} of ${found.mediaUrls.length}${isDirectMedia ? '…' : ' with FFmpeg…'}`);
                try {
                    if (isDirectMedia) {
                        await downloadDirectMedia(mediaUrl, downloadedFile, headers, controller.signal, (percentage, bytes) => {
                            const progressText = percentage === null ? `${(bytes / 1048576).toFixed(1)} MB` : `${percentage}%`;
                            sendUrlDownloadStatus(sender, `Media ${index + 1}/${found.mediaUrls.length}… ${progressText}`);
                        });
                    } else {
                        await runProcess(ffmpegExecutable, [
                            '-y', '-headers', `${headers.join('\r\n')}\r\n`, '-i', mediaUrl,
                            '-c', 'copy', '-movflags', '+faststart',
                            '-progress', 'pipe:1', '-stats_period', '1', downloadedFile
                        ], (output) => {
                            const time = /out_time=([^\r\n]+)/.exec(output)?.[1];
                            const bytes = /total_size=(\d+)/.exec(output)?.[1];
                            if (time || bytes) {
                                const size = bytes ? ` · ${(Number(bytes) / 1048576).toFixed(1)} MB` : '';
                                sendUrlDownloadStatus(sender, `Media ${index + 1}/${found.mediaUrls.length}… ${time || ''}${size}`);
                            }
                        }, 15 * 60 * 1000, controller.signal);
                    }
                    const displayName = found.mediaUrls.length === 1 ? downloadedTitle : `${downloadedTitle} ${index + 1}`;
                    sendUrlDownloadItemStatus(sender, mediaUrl, 'importing');
                    sendUrlDownloadStatus(sender, `Importing media ${index + 1} of ${found.mediaUrls.length}…`);
                    const item = await importMediaFile(downloadedFile, null, `${safeDownloadName(displayName)}${path.extname(downloadedFile)}`);
                    items.push(item);
                    completedUrls.add(mediaUrl);
                    sendUrlDownloadItemStatus(sender, mediaUrl, 'downloaded');
                    if (!sender.isDestroyed()) sender.send('url-download-imported', item);
                    await removeStagedFile(downloadedFile, false);
                } catch (error) {
                    await removeStagedFile(downloadedFile, false);
                    if (controller.signal.aborted) throw new Error('Download cancelled.');
                    failures.push({ url: mediaUrl, error: error.message });
                    sendUrlDownloadItemStatus(sender, mediaUrl, 'failed', { error: error.message });
                }
            }
        }

        if (!downloadedFiles.length && !items.length && !failures.length) {
            const error = 'The media extractor finished without producing a merged media file.';
            failures.push({ url: pageUrl.href, error });
            if (selectedUrls.length === 1) sendUrlDownloadItemStatus(sender, selectedUrls[0], 'failed', { error });
        }
        for (const [index, downloadedFile] of downloadedFiles.entries()) {
            if (controller.signal.aborted) throw new Error('Download cancelled.');
            const extension = path.extname(downloadedFile);
            const displayName = downloadedFiles.length === 1 ? downloadedTitle : `${downloadedTitle} ${index + 1}`;
            sendUrlDownloadStatus(sender, `Importing media ${index + 1} of ${downloadedFiles.length}…`);
            if (selectedUrls.length === 1) sendUrlDownloadItemStatus(sender, selectedUrls[0], 'importing');
            const item = await importMediaFile(downloadedFile, null, `${safeDownloadName(displayName)}${extension}`);
            items.push(item);
            if (selectedUrls.length === 1) {
                completedUrls.add(selectedUrls[0]);
                sendUrlDownloadItemStatus(sender, selectedUrls[0], 'downloaded');
            }
            if (!sender.isDestroyed()) sender.send('url-download-imported', item);
            await removeStagedFile(downloadedFile, false);
        }
        sendUrlDownloadStatus(sender, `${items.length} media item${items.length === 1 ? '' : 's'} imported into the library.`);
        return { cancelled: false, items, failures };
    } catch (error) {
        if (controller.signal.aborted || error.message === 'Download cancelled.') {
            for (const url of selectedUrls) {
                if (!completedUrls.has(url)) sendUrlDownloadItemStatus(sender, url, 'idle');
            }
            sendUrlDownloadStatus(sender, `Download cancelled. ${items.length} completed media item${items.length === 1 ? '' : 's'} kept.`);
            return { cancelled: true, items };
        }
        throw error;
    } finally {
        activeUrlDownload.running = false;
        const leftovers = await fs.readdir(stagingDirectory).catch(() => []);
        await Promise.all(leftovers
            .filter((name) => name.startsWith(token))
            .map((name) => removeStagedFile(path.join(stagingDirectory, name))));
    }
});

async function processUploadQueue() {
    if (uploadSessionRunning) return;
    uploadSessionRunning = true;
    while (uploadSessionQueue.length) {
        const upload = uploadSessionQueue.shift();
        uploadSessionCurrent = upload;
        uploadSessionRecords.set(upload.id, { ...upload, state: 'importing' });
        sendUploadStatus({ id: upload.id, name: upload.name, state: 'importing', queued: uploadSessionQueue.length });
        try {
            const item = await importMediaFile(upload.path, null, upload.name);
            await fs.unlink(upload.path).catch(() => {});
            uploadSessionRecords.set(upload.id, { ...upload, state: 'complete' });
            uploadImportWaiters.get(upload.id)?.resolve({ ok: true, item });
            uploadImportWaiters.delete(upload.id);
            sendUploadStatus({ id: upload.id, name: upload.name, state: 'complete', item, queued: uploadSessionQueue.length });
        } catch (error) {
            await fs.unlink(upload.path).catch(() => {});
            uploadSessionRecords.set(upload.id, { ...upload, state: 'error' });
            uploadImportWaiters.get(upload.id)?.resolve({ ok: false, error: error.message });
            uploadImportWaiters.delete(upload.id);
            sendUploadStatus({ id: upload.id, name: upload.name, state: 'error', error: error.message, queued: uploadSessionQueue.length });
        }
    }
    uploadSessionCurrent = null;
    uploadSessionRunning = false;
}

function uploadQueueStatus(ids = []) {
    const active = uploadSessionCurrent ? [uploadSessionCurrent, ...uploadSessionQueue] : [...uploadSessionQueue];
    const total = active.length;
    return { total, items: ids.map((id) => {
        const record = uploadSessionRecords.get(id);
        const position = active.findIndex((upload) => upload.id === id);
        return record ? { id, name: record.name, state: record.state, position: position < 0 ? null : position + 1, total } : { id, state: 'unknown', position: null, total };
    }) };
}

ipcMain.handle('start-upload', async () => {
    if (!uploadSessionServer) {
        const stagingDirectory = path.join(libraryRoot, '.uploads');
        await fs.mkdir(stagingDirectory, { recursive: true });
        uploadSessionServer = http.createServer((request, response) => {
            const pagePath = '/upload';
            const uploadPath = `${pagePath}/upload`;
            const statusPath = `${pagePath}/status`;
            if (request.method === 'GET' && request.url === pagePath) {
                response.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
                });
                fs.readFile(path.join(__dirname, 'upload.html'), 'utf8')
                    .then((page) => response.end(page))
                    .catch(() => { response.writeHead(500); response.end('Capdio upload page is unavailable.'); });
                return;
            }
            if (request.method === 'GET' && request.url.startsWith(statusPath)) {
                const ids = new URL(request.url, 'http://capdio.local').searchParams.get('ids')?.split(',').filter(Boolean) || [];
                response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                response.end(JSON.stringify(uploadQueueStatus(ids)));
                return;
            }
            if (request.method !== 'POST' || request.url !== uploadPath) { response.writeHead(404).end(); return; }
            let parser;
            try { parser = Busboy({ headers: request.headers, defParamCharset: 'utf8', limits: { files: 30, fileSize: 10 * 1024 * 1024 * 1024 } }); } catch { response.writeHead(400).end('Invalid upload.'); return; }
            const saved = [];
            const writes = [];
            const uploadRequest = { request, saved, cancelled: false };
            activeUploadRequests.add(uploadRequest);
            const discardPartialUploads = async () => {
                uploadRequest.cancelled = true;
                await Promise.all(saved.map((upload) => fs.unlink(upload.path).catch(() => {})));
                sendUploadStatus({ id: 'transfer', name: 'Receiving files from phone', state: 'cancelled' });
            };
            request.on('aborted', () => { discardPartialUploads(); activeUploadRequests.delete(uploadRequest); });
            const totalBytes = Number(request.headers['content-length']) || 0;
            let receivedBytes = 0;
            let lastProgressAt = 0;
            request.on('data', (chunk) => {
                receivedBytes += chunk.length;
                const now = Date.now();
                if (totalBytes && now - lastProgressAt > 120) {
                    lastProgressAt = now;
                    sendUploadStatus({ id: 'transfer', name: 'Receiving files from phone', state: 'uploading', progress: Math.min(99, Math.round(receivedBytes / totalBytes * 100)) });
                }
            });
            parser.on('file', (_field, stream, info) => {
                const name = path.basename(info.filename || 'media');
                const extension = path.extname(name).toLowerCase();
                if (!supportedMediaExtensions.has(extension)) { stream.resume(); return; }
                const upload = { id: crypto.randomUUID(), name, path: path.join(stagingDirectory, `${crypto.randomUUID()}${extension}`) };
                saved.push(upload);
                const output = fsSync.createWriteStream(upload.path);
                stream.pipe(output);
                writes.push(new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); stream.on('limit', () => reject(new Error(`${name} is too large.`))); }));
            });
            parser.on('finish', async () => {
                try {
                    await Promise.all(writes);
                    if (uploadRequest.cancelled) return;
                    sendUploadStatus({ id: 'transfer', name: 'Receiving files from phone', state: 'received', progress: 100 });
                    const completed = saved.map((upload) => new Promise((resolve) => uploadImportWaiters.set(upload.id, { resolve })));
                    uploadSessionQueue.push(...saved);
                    saved.forEach((upload) => { uploadSessionRecords.set(upload.id, { ...upload, state: 'queued' }); sendUploadStatus({ id: upload.id, name: upload.name, state: 'queued', queued: uploadSessionQueue.length }); });
                    processUploadQueue();
                    const results = await Promise.all(completed);
                    response.writeHead(results.every((result) => result.ok) ? 201 : 500, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ results }));
                } catch (error) { await Promise.all(saved.map((upload) => fs.unlink(upload.path).catch(() => {}))); response.writeHead(400).end(error.message); } finally { activeUploadRequests.delete(uploadRequest); }
            });
            request.pipe(parser);
        });
        await new Promise((resolve, reject) => { uploadSessionServer.once('error', reject); uploadSessionServer.listen(0, '0.0.0.0', resolve); });
    }
    const { port } = uploadSessionServer.address();
    const url = `http://${uploadHost()}:${port}/upload`;
    return { url, qrCode: await QRCode.toDataURL(url, { margin: 1, width: 280 }) };
});

ipcMain.handle('cancel-uploads', async () => {
    const queued = uploadSessionQueue.splice(0);
    await Promise.all(queued.map((upload) => fs.unlink(upload.path).catch(() => {})));
    queued.forEach((upload) => { uploadSessionRecords.set(upload.id, { ...upload, state: 'cancelled' }); uploadImportWaiters.get(upload.id)?.resolve({ ok: false, error: 'Cancelled' }); uploadImportWaiters.delete(upload.id); sendUploadStatus({ id: upload.id, name: upload.name, state: 'cancelled' }); });
    for (const uploadRequest of activeUploadRequests) uploadRequest.request.destroy();
    return true;
});

ipcMain.handle('set-media-volume', async (event, mediaId, value) => {
    const volume = Number(value);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
        throw new Error('Volume must be between 0 and 1.');
    }
    if (deletingMediaIds.has(mediaId)) throw new Error('The media item is being deleted.');
    return trackMetadataWrite(mediaId, (async () => {
        const manifest = await readManifest();
        const item = manifest.media.find((entry) => entry.id === mediaId);
        if (!item || deletingMediaIds.has(mediaId)) throw new Error('The imported media entry was not found in manifest.json.');
        const metadata = await readMetadata(mediaId);
        metadata.volume = volume;
        if (deletingMediaIds.has(mediaId)) throw new Error('The media item is being deleted.');
        await writeMetadata(mediaId, metadata);
        return volume;
    })());
});

ipcMain.handle('set-media-loop', async (event, mediaId, value) => {
    const loop = Boolean(value);
    if (deletingMediaIds.has(mediaId)) throw new Error('The media item is being deleted.');
    return trackMetadataWrite(mediaId, (async () => {
        const manifest = await readManifest();
        const item = manifest.media.find((entry) => entry.id === mediaId);
        if (!item || deletingMediaIds.has(mediaId)) throw new Error('The imported media entry was not found in manifest.json.');
        const metadata = await readMetadata(mediaId);
        metadata.loop = loop;
        if (deletingMediaIds.has(mediaId)) throw new Error('The media item is being deleted.');
        await writeMetadata(mediaId, metadata);
        return loop;
    })());
});

ipcMain.handle('set-media-position', async (event, mediaId, value) => {
    const position = Math.max(0, Number(value) || 0);
    if (deletingMediaIds.has(mediaId)) throw new Error('The media item is being deleted.');
    return trackMetadataWrite(mediaId, (async () => {
        const manifest = await readManifest();
        const item = manifest.media.find((entry) => entry.id === mediaId);
        if (!item || deletingMediaIds.has(mediaId)) throw new Error('The imported media entry was not found in manifest.json.');
        const metadata = await readMetadata(mediaId);
        metadata.seekPosition = position;
        if (deletingMediaIds.has(mediaId)) throw new Error('The media item is being deleted.');
        await writeMetadata(mediaId, metadata);
        return position;
    })());
});

ipcMain.handle('save-transcription', async (event, mediaId, transcription) => {
    const manifest = await readManifest();
    const item = manifest.media.find((entry) => entry.id === mediaId);
    if (!item) throw new Error('The imported media entry was not found in manifest.json.');

    const captions = (transcription.segments || []).map((segment) => ({
        s: secondsToTimestamp(segment.start),
        e: secondsToTimestamp(segment.end),
        t: String(segment.text || '').trim()
    })).filter((segment) => segment.t);
    const captionPath = captionPathFor(item);
    const caption = {
        version: 1,
        media: item.id,
        text: transcription.text || '',
        captions,
        generatedAt: new Date().toISOString()
    };

    await fs.writeFile(captionPath, `${JSON.stringify(caption, null, 2)}\n`);
    item.transcribedAt = caption.generatedAt;
    await writeManifest(manifest);
    return { caption, captionPath, captionRelativePath: `caption/${item.id}.captions.json` };
});

function secondsToTimestamp(seconds) {
    const tenths = Math.max(0, Math.round(Number(seconds || 0) * 10));
    const minutes = Math.floor(tenths / 600);
    const remainder = tenths % 600;
    return `${minutes}:${Math.floor(remainder / 10)}:${remainder % 10}`;
}

ipcMain.handle('extract-audio', async (event, inputFile) => {
    return new Promise((resolve, reject) => {
        const outputFile = path.join(
            path.dirname(inputFile),
            `${path.parse(inputFile).name}_audio.wav`
        );

        console.log('FFmpeg input:', inputFile);
        console.log('FFmpeg output:', outputFile);

        const ffmpeg = spawn(ffmpegExecutable, [
            '-y',
            '-i', inputFile,
            '-vn',
            '-ac', '1',
            '-ar', '16000',
            '-c:a', 'pcm_s16le',
            outputFile
        ]);

        let stderr = '';

        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();

            console.log(data.toString());
        });

        ffmpeg.on('error', (error) => {
            reject(error);
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve(outputFile);
            } else {
                reject(
                    new Error(
                        `FFmpeg exited with code ${code}\n${stderr}`
                    )
                );
            }
        });
    });
});

ipcMain.handle('run-python-test', async () => {
    return new Promise((resolve, reject) => {
        const pythonScript = path.join(
            __dirname,
            'python',
            'test.py'
        );

        const python = spawn(developmentPythonExecutable, [pythonScript]);

        let stdout = '';
        let stderr = '';

        python.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        python.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        python.on('error', (error) => {
            reject(error);
        });

        python.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(
                    new Error(
                        `Python exited with code ${code}\n${stderr}`
                    )
                );
            }
        });
    });
});

let currentTranscriptionProcess = null;
let transcriptionCancelled = false;

ipcMain.handle('transcribe', async (event, mediaId) => {
    const manifest = await readManifest();
    const item = manifest.media.find((entry) => entry.id === mediaId);
    if (!item) throw new Error('The imported media entry was not found in manifest.json.');

    const audioFile = mediaPathFor(item);
    const relativePath = path.relative(mediaDirectory, audioFile);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error('The media entry points outside the Capdio media library.');
    }

    return new Promise((resolve, reject) => {
        transcriptionCancelled = false;
        const transcriptionArguments = app.isPackaged
            ? [audioFile]
            : [path.join(__dirname, 'python', 'transcribe.py'), audioFile];
        const python = spawn(transcriberExecutable, transcriptionArguments, {
            env: {
                ...process.env,
                // Whisper launches `ffmpeg` itself. Make the bundled executable
                // discoverable on machines that do not have FFmpeg installed.
                ...(app.isPackaged ? {
                    PATH: [platformBinaryDirectory, process.env.PATH].filter(Boolean).join(path.delimiter)
                } : {}),
                ...(whisperModelDirectory ? { CAPDIO_WHISPER_MODEL_DIR: whisperModelDirectory } : {})
            }
        });

        currentTranscriptionProcess = python;

        let stdout = '';
        let stderr = '';

        python.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        python.stderr.on('data', (data) => {
            const message = data.toString();

            stderr += message;

            console.log(message);

            const lines = message.split(/\r?\n/);

            for (const line of lines) {
                if (line.startsWith('PROGRESS:')) {
                    const value = Number(
                        line.substring('PROGRESS:'.length)
                    );

                    event.sender.send(
                        'transcription-progress',
                        value
                    );
                }

                if (line.startsWith('STATUS:')) {
                    const status = line.substring(
                        'STATUS:'.length
                    );

                    event.sender.send(
                        'transcription-status',
                        status
                    );
                }
            }
        });

        python.on('error', (error) => {
            currentTranscriptionProcess = null;
            reject(error);
        });

        python.on('close', (code) => {
            currentTranscriptionProcess = null;

            if (transcriptionCancelled) {
                resolve({
                    cancelled: true
                });
                return;
            }

            if (code !== 0) {
                reject(
                    new Error(
                        `Whisper exited with code ${code}\n${stderr}`
                    )
                );
                return;
            }

            try {
                const jsonStart = stdout.indexOf('{');

                if (jsonStart === -1) {
                    throw new Error('No JSON output found');
                }

                const result = JSON.parse(
                    stdout.slice(jsonStart)
                );

                resolve(result);

            } catch (error) {
                reject(
                    new Error(
                        `Failed to parse Whisper output:\n${stdout}`
                    )
                );
            }
        });
    });
});

ipcMain.handle('cancel-transcription', async () => {
    if (!currentTranscriptionProcess) {
        return false;
    }

    transcriptionCancelled = true;

    const process = currentTranscriptionProcess;
    const closed = new Promise((resolve) => process.once('close', resolve));
    process.kill();
    await closed;

    return true;
});

ipcMain.handle('copy-text', (event, value) => {
    clipboard.writeText(String(value || ''));
});

ipcMain.handle('dictionary-lookup', (event, word) => lookup(word, event.sender, { clearHistory: true }));
ipcMain.on('dictionary-theme', (event, dark) => {
    darkTheme = Boolean(dark);
    BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(darkTheme ? '#111827' : '#f4f6fb');
    setDictionaryTheme(darkTheme);
    try {
        fsSync.mkdirSync(path.dirname(themeConfigPath), { recursive: true });
        fsSync.writeFileSync(themeConfigPath, JSON.stringify({ dark: darkTheme }));
    } catch (error) {
        console.error('Unable to save window theme:', error);
    }
});
ipcMain.handle('dictionary-open', (event) => openDictionary(event.sender));

app.whenReady().then(async () => {
    if (!hasSingleInstanceLock) return;
    protocol.handle('capdio', async (request) => {
        const url = new URL(request.url);
        if (url.hostname !== 'library') {
            return new Response('Not found', { status: 404 });
        }
        const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const filePath = path.resolve(libraryRoot, relativePath);
        const mediaRelativePath = path.relative(mediaDirectory, filePath);
        if (mediaRelativePath.startsWith('..') || path.isAbsolute(mediaRelativePath)) {
            return new Response('Forbidden', { status: 403 });
        }
        let stat;
        try {
            stat = await fs.stat(filePath);
        } catch {
            return new Response('Not found', { status: 404 });
        }
        if (!stat.isFile()) return new Response('Not found', { status: 404 });

        const size = stat.size;
        const range = request.headers.get('range');
        let start = 0;
        let end = Math.max(0, size - 1);
        let status = 200;

        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
            if (!match) {
                return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
            }
            if (match[1] === '') {
                const requestedLength = Number(match[2]);
                start = Math.max(0, size - requestedLength);
            } else {
                start = Number(match[1]);
                end = match[2] === '' ? end : Math.min(Number(match[2]), end);
            }
            if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
                return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
            }
            status = 206;
        }

        const length = end - start + 1;
        const headers = {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(length),
            'Content-Type': mediaMimeType(filePath)
        };
        if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        const body = request.method === 'HEAD' ? null : Readable.toWeb(fsSync.createReadStream(filePath, { start, end }));
        return new Response(body, { status, headers });
    });
    Menu.setApplicationMenu(null);
    globalShortcut.register('CommandOrControl+Shift+I', () => {
        BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools();
    });
    await Promise.all([
        fs.mkdir(mediaDirectory, { recursive: true }),
        fs.mkdir(captionDirectory, { recursive: true }),
        clearUrlDownloadStaging()
    ]);
    createWindow();
});

let shutdownCleanupStarted = false;
let shutdownCleanupComplete = false;
app.on('before-quit', (event) => {
    if (shutdownCleanupComplete) return;
    event.preventDefault();
    if (shutdownCleanupStarted) return;
    shutdownCleanupStarted = true;
    activeUrlDownload?.controller.abort();

    const deadline = Date.now() + 12000;
    const waitForDownloader = () => new Promise((resolve) => {
        const check = () => {
            if (!activeUrlDownload?.running || Date.now() >= deadline) resolve();
            else setTimeout(check, 100);
        };
        check();
    });
    waitForDownloader()
        .then(clearUrlDownloadStaging)
        .catch((error) => console.error('Unable to clear URL download staging during shutdown:', error.message))
        .finally(() => {
            shutdownCleanupComplete = true;
            app.quit();
        });
});

app.on('session-end', () => {
    activeUrlDownload?.controller.abort();
    clearUrlDownloadStaging().catch(() => {});
});
app.on('will-quit', () => globalShortcut.unregisterAll());
