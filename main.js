const { app, BrowserWindow, clipboard, ipcMain, dialog, Menu, globalShortcut } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const libraryRoot = path.join(__dirname, 'library');
const mediaDirectory = path.join(libraryRoot, 'media');
const captionDirectory = path.join(libraryRoot, 'caption');
const manifestPath = path.join(libraryRoot, 'manifest.json');

function mediaType(filePath) {
    return ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(path.extname(filePath).toLowerCase()) ? 'audio' : 'video';
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

async function uniqueMediaPath(fileName) {
    const parsed = path.parse(fileName);
    let candidate = path.join(mediaDirectory, fileName);
    let suffix = 2;

    while (true) {
        try {
            await fs.access(candidate);
            candidate = path.join(mediaDirectory, `${parsed.name}-${suffix}${parsed.ext}`);
            suffix += 1;
        } catch (error) {
            if (error.code === 'ENOENT') return candidate;
            throw error;
        }
    }
}

async function moveMediaFile(source, destination) {
    try {
        await fs.rename(source, destination);
    } catch (error) {
        // A rename cannot cross volumes on some systems. Copy, then remove only
        // after a successful copy to preserve the requested move semantics.
        if (error.code !== 'EXDEV') throw error;
        await fs.copyFile(source, destination);
        await fs.unlink(source);
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1000,
        height: 700,
        frame: false,
        icon: path.join(__dirname, 'assets', 'capdio-icon.png'),

        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadURL('http://localhost:5173');
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
    BrowserWindow.fromWebContents(event.sender)?.close();
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
        let captions = [];
        if (item.caption) {
            const captionPath = path.resolve(libraryRoot, item.caption);
            const allowedPath = `${captionDirectory}${path.sep}`;
            if (!captionPath.startsWith(allowedPath)) {
                throw new Error(`Invalid caption path in manifest: ${item.caption}`);
            }
            try {
                const caption = JSON.parse(await fs.readFile(captionPath, 'utf8'));
                captions = Array.isArray(caption.captions) ? caption.captions : [];
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        return {
            ...item,
            type: item.type || mediaType(item.media),
            absolutePath: path.resolve(libraryRoot, item.media),
            playbackPath: path.posix.join('library', item.media),
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
    manifest.media.forEach((item) => {
        if (ids.has(item.id)) item.groupId = groupId;
    });
    await writeManifest(manifest);
    return manifest.media.filter((item) => ids.has(item.id));
});

async function removeProjectFile(relativePath, directory) {
    const resolvedPath = path.resolve(libraryRoot, relativePath);
    const allowedPath = `${directory}${path.sep}`;
    if (!resolvedPath.startsWith(allowedPath)) {
        throw new Error(`Invalid project file path: ${relativePath}`);
    }
    try {
        await fs.unlink(resolvedPath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

ipcMain.handle('delete-media', async (event, mediaIds) => {
    const manifest = await readManifest();
    const ids = new Set(Array.isArray(mediaIds) ? mediaIds : []);
    const removing = manifest.media.filter((item) => ids.has(item.id));
    await Promise.all(removing.flatMap((item) => {
        const files = [removeProjectFile(item.media, mediaDirectory)];
        if (item.caption) files.push(removeProjectFile(item.caption, captionDirectory));
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
        const files = [removeProjectFile(item.media, mediaDirectory)];
        if (item.caption) files.push(removeProjectFile(item.caption, captionDirectory));
        return files;
    }));
    manifest.groups = manifest.groups.filter((item) => item.id !== groupId);
    manifest.media = manifest.media.filter((item) => item.groupId !== groupId);
    await writeManifest(manifest);
    return { groupId, mediaIds: removing.map((item) => item.id) };
});

ipcMain.handle('import-media', async (event, sourceFile, groupId = null) => {
    if (!sourceFile || typeof sourceFile !== 'string') {
        throw new Error('A media file is required.');
    }

    await fs.mkdir(mediaDirectory, { recursive: true });
    await fs.mkdir(captionDirectory, { recursive: true });

    const sourceName = path.basename(sourceFile);
    const extension = path.extname(sourceName);
    const destination = path.join(mediaDirectory, `${crypto.randomUUID()}${extension}`);
    await fs.copyFile(sourceFile, destination);

    const manifest = await readManifest();
    if (groupId !== null && !manifest.groups.some((group) => group.id === groupId)) {
        throw new Error('Group was not found.');
    }
    const item = {
        id: crypto.randomUUID(),
        name: path.parse(sourceName).name,
        type: mediaType(sourceName),
        media: path.relative(libraryRoot, destination).replace(/\\/g, '/'),
        caption: null,
        volume: 1,
        importedAt: new Date().toISOString(),
        groupId
    };
    manifest.media.push(item);
    await writeManifest(manifest);
    return { ...item, absolutePath: destination, playbackPath: path.posix.join('library', item.media) };
});

ipcMain.handle('set-media-volume', async (event, mediaId, value) => {
    const volume = Number(value);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
        throw new Error('Volume must be between 0 and 1.');
    }
    const manifest = await readManifest();
    const item = manifest.media.find((entry) => entry.id === mediaId);
    if (!item) throw new Error('The imported media entry was not found in manifest.json.');
    item.volume = volume;
    await writeManifest(manifest);
    return volume;
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
    const captionName = `${path.parse(item.media).name}.captions.json`;
    const captionPath = path.join(captionDirectory, captionName);
    const caption = {
        version: 1,
        media: item.media,
        text: transcription.text || '',
        captions,
        generatedAt: new Date().toISOString()
    };

    await fs.writeFile(captionPath, `${JSON.stringify(caption, null, 2)}\n`);
    item.caption = path.relative(libraryRoot, captionPath).replace(/\\/g, '/');
    item.transcribedAt = caption.generatedAt;
    await writeManifest(manifest);
    return { caption, captionPath, captionRelativePath: item.caption };
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

        const ffmpeg = spawn('ffmpeg', [
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

ipcMain.handle('transcribe', async (event, audioFile) => {
    return new Promise((resolve, reject) => {
        transcriptionCancelled = false;
        const pythonScript = path.join(
            __dirname,
            'python',
            'transcribe.py'
        );

        const python = spawn('python', [
            pythonScript,
            audioFile
        ]);

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

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    globalShortcut.register('CommandOrControl+Shift+I', () => {
        BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools();
    });
    createWindow();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
