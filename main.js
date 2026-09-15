const { app, BrowserWindow, clipboard, ipcMain, dialog, Menu, globalShortcut, protocol } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
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
const developmentPythonExecutable = process.env.CAPDIO_PYTHON
    || (fsSync.existsSync(bundledDevelopmentPython) ? bundledDevelopmentPython : 'python');
const ffmpegExecutable = app.isPackaged
    ? path.join(platformBinaryDirectory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    : 'ffmpeg';
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
    await writeMetadata(id, { name: path.parse(sourceName).name, groupId, volume: 1 });
    return {
        ...item,
        absolutePath: destination,
        playbackPath: `capdio://library/media/${id}${extension}`,
        media: `media/${id}${extension}`, caption: null, name: path.parse(sourceName).name, groupId, volume: 1
    };
}

ipcMain.handle('import-media', (event, sourceFile, groupId = null) => {
    return importMediaFile(sourceFile, groupId);
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
    const manifest = await readManifest();
    const item = manifest.media.find((entry) => entry.id === mediaId);
    if (!item) throw new Error('The imported media entry was not found in manifest.json.');
    const metadata = await readMetadata(mediaId);
    metadata.volume = volume;
    await writeMetadata(mediaId, metadata);
    return volume;
});

ipcMain.handle('set-media-position', async (event, mediaId, value) => {
    const position = Math.max(0, Number(value) || 0);
    const metadata = await readMetadata(mediaId);
    metadata.seekPosition = position;
    await writeMetadata(mediaId, metadata);
    return position;
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

        const python = spawn('python', [pythonScript]);

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

ipcMain.handle('dictionary-lookup', (event, word) => lookup(word, event.sender));
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
        fs.mkdir(captionDirectory, { recursive: true })
    ]);
    createWindow();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
