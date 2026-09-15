const { BrowserWindow, WebContentsView, ipcMain } = require('electron');
const path = require('node:path');

let youdaoWindow;
let pageReady;
let lookupSender;

let dictionaryContents;
let dictionaryView;
let darkTheme = true;

// Adapt the site's light palette without depending on Youdao's internal classes.
// Reduce contrast so white panels become dark gray instead of pure black.
// Counter-filter media to keep its colors as close to the originals as possible.
const dictionaryDarkCSS = `
    html {
        background: #ffffff !important;
        filter: invert(1) hue-rotate(180deg) contrast(0.87) !important;
        min-height: 100%;
        color-scheme: light !important;
    }
    body { background-color: #ffffff !important; min-height: 100vh; }
    img, picture, video, canvas {
        filter: contrast(1.1494252874) hue-rotate(180deg) invert(1) !important;
    }
    picture img { filter: none !important; }
    /* The viewport scrollbar is outside the page filter. */
    html {
        scrollbar-width: thin;
        scrollbar-color: #555555 #111111;
    }
    /* Nested scrollbars are inverted with their content: use light source colors. */
    body, body * {
        scrollbar-width: thin;
        scrollbar-color: #b0b0b0 #ffffff;
    }
`;
function applyDictionaryAppearance() {
    const contents = dictionaryContents;
    if (!contents || contents.isDestroyed()) return;
    dictionaryView.setBackgroundColor(darkTheme ? '#111111' : '#ffffff');
    const css = '.top-banner-wrap { display: none !important; }\n' + (darkTheme ? dictionaryDarkCSS : '');
    return contents.executeJavaScript(`(() => {
        let style = document.getElementById('capdio-dictionary-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'capdio-dictionary-style';
            (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = ${JSON.stringify(css)};
        // Flush the new styles without waiting for a hidden view to paint.
        getComputedStyle(document.documentElement).filter;
        return true;
    })()`).catch((error) => {
        if (!contents.isDestroyed()) console.error('Unable to apply dictionary appearance:', error);
    });
}
function disableMouseOverAutoPronounce() {
    const contents = dictionaryContents;
    if (!contents || contents.isDestroyed()) return;
    contents.executeJavaScript(`(() => {
        document.addEventListener("mouseover", (event) => {
            if (event.target.closest(".pronounce")) {
                event.stopPropagation()
            }
        }, true);
    })()`)
}

function setDictionaryTheme(dark) {
    darkTheme = Boolean(dark);
    if (youdaoWindow && !youdaoWindow.isDestroyed()) {
        youdaoWindow.webContents.send('dictionary-theme', darkTheme);
    }
    return applyDictionaryAppearance();
}
function toggleDictionaryTheme() {
    setDictionaryTheme(!darkTheme);
    if (lookupSender && !lookupSender.isDestroyed()) lookupSender.send('dictionary-theme-changed', darkTheme);
}

ipcMain.on('dictionary-control', (event, action) => {
    const win = youdaoWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    const history = dictionaryContents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    if (action === 'forward' && history.canGoForward()) history.goForward();
    if (action === 'theme') toggleDictionaryTheme();
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === 'close') win.close();
});
async function showDictionary(word, sender) {
    if (sender) lookupSender = sender;

    if (!youdaoWindow || youdaoWindow.isDestroyed()) {
        const win = new BrowserWindow({
            width: 1000,
            height: 700,
            show: false,
            frame: false,
            backgroundColor: darkTheme ? '#111827' : '#f4f6fb',
            icon: path.join(__dirname, 'assets', 'capdio-icon.png'),
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        youdaoWindow = win;
        win.setMenu(null);
        win.webContents.on('will-navigate', (event) => event.preventDefault());
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const view = new WebContentsView({
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
        });
        const contents = view.webContents;
        dictionaryContents = contents;
        dictionaryView = view;
        view.setBackgroundColor(darkTheme ? '#111111' : '#ffffff');
        // Cover new documents until the styled frame is ready to display.
        view.setVisible(false);
        let navigationVersion = 0;
        contents.on('did-start-navigation', (details) => {
            if (details.isMainFrame && !details.isSameDocument) {
                navigationVersion += 1;
                view.setVisible(false);
            }
        });
        contents.on('dom-ready', async () => {
            const version = navigationVersion;
            disableMouseOverAutoPronounce();
            await applyDictionaryAppearance();
            if (!contents.isDestroyed() && version === navigationVersion) {
                view.setVisible(true);
            }
        });
        win.contentView.addChildView(view);
        win.on('focus', () => {
            contents?.focus()
            contents?.executeJavaScript(`(() => {
                var search_input = document.getElementById("search_input");
                search_input.select();
                search_input.focus();
            })()`).catch(() => {});
        });
        const resize = () => {
            const [width, height] = win.getContentSize();
            view.setBounds({ x: 0, y: 42, width, height: Math.max(0, height - 42) });
        };
        win.on('resize', resize);
        resize();
        const updateNavigation = () => {
            if (!win.isDestroyed() && !contents.isDestroyed()) {
                win.webContents.send('dictionary-navigation', {
                    back: contents.navigationHistory.canGoBack(),
                    forward: contents.navigationHistory.canGoForward()
                });
            }
        };
        for (const event of ['did-navigate', 'did-navigate-in-page', 'did-stop-loading']) {
            contents.on(event, updateNavigation);
        }
        win.webContents.on('did-finish-load', () => {
            updateNavigation();
            win.webContents.send('dictionary-theme', darkTheme);
        });
        win.once('ready-to-show', () => win.show());
        const shellReady = win.loadFile(path.join(__dirname, 'dictionary.html'), { query: { theme: darkTheme ? 'dark' : 'light' } });
        // Keep the lifetime tied to Capdio without native child-window stacking.
        const parent = BrowserWindow.fromWebContents(lookupSender);
        const closeChild = () => { if (!win.isDestroyed()) win.destroy(); };
        parent.once('closed', closeChild);
        win.once('closed', () => {
            parent.removeListener('closed', closeChild);
            if (!contents.isDestroyed()) contents.close();
        });
        const handleShortcut = (event, input) => {
            if (input.type === 'keyDown' && input.control && input.shift && !input.alt && !input.meta && input.key.toLowerCase() === 't') {
                event.preventDefault();
                if (!input.isAutoRepeat) toggleDictionaryTheme();
                return;
            }
            if (input.type === 'keyDown' && input.alt && !input.control && !input.shift && !input.meta
                && (input.key === 'ArrowLeft' || input.key === 'ArrowRight')) {
                event.preventDefault();
                if (input.isAutoRepeat || contents.isDestroyed()) return;
                const history = contents.navigationHistory;
                if (input.key === 'ArrowLeft' && history.canGoBack()) history.goBack();
                if (input.key === 'ArrowRight' && history.canGoForward()) history.goForward();
                return;
            }
            if (input.type !== 'keyDown' || !input.control || input.shift || input.alt || input.meta) return;
            const key = input.key.toLowerCase();
            if (key !== 'd' && key !== 's') return;
            event.preventDefault();
            if (input.isAutoRepeat) return;
            if (key === 's') {
                contents.executeJavaScript(`(() => {
                    const selection = window.getSelection();
                    const word = selection?.toString().trim() || '';
                    if (word) selection.removeAllRanges();
                    return word;
                })()`).then((word) => {
                    if (!win.isDestroyed()) return lookup(word);
                }).catch((error) => console.error('Dictionary lookup failed:', error));
                return;
            }
            if (!lookupSender || lookupSender.isDestroyed()) return;
            const mainWindow = BrowserWindow.fromWebContents(lookupSender);
            if (!mainWindow || mainWindow.isDestroyed()) return;
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        };
        contents.on('before-input-event', handleShortcut);
        win.webContents.on('before-input-event', handleShortcut);
        win.on('closed', () => {
            if (youdaoWindow === win) {
                youdaoWindow = null;
                pageReady = null;
                dictionaryContents = null;
            }
        });
        // Every newly-created dictionary window begins at the home page. If a
        // lookup initiated it, replace that initial history entry afterwards so
        // Back does not lead to an unused blank/home lookup state.
        const firstLookupWord = word;
        pageReady = Promise.all([shellReady, contents.loadURL('https://dict.youdao.com/')]);
        await pageReady;
        if (firstLookupWord && !win.isDestroyed() && !contents.isDestroyed()) {
            await contents.executeJavaScript(`(() => {
                const word = ${JSON.stringify(firstLookupWord)};
                const url = new URL(location.href);
                url.pathname = '/result';
                url.searchParams.set('word', word);
                url.searchParams.set('lang', 'en');
                history.replaceState({ word }, '', url);
                window.dispatchEvent(new PopStateEvent('popstate', { state: { word } }));
            })()`, true);
        }
    } else if (word) {
        const win = youdaoWindow;
        await pageReady;
        if (win.isDestroyed()) return;
        // A caption lookup is a user action; keep its history entry traversable.
        await dictionaryContents.executeJavaScript(`(() => {
            const word = ${JSON.stringify(word)};
            const url = new URL(location.href);
            url.pathname = '/result';
            url.searchParams.set('word', word);
            url.searchParams.set('lang', 'en');
            history.pushState({ word }, '', url);
            window.dispatchEvent(new PopStateEvent('popstate', { state: { word } }));
        })()`, true);
        if (!win.isDestroyed() && dictionaryContents && !dictionaryContents.isDestroyed()) {
            win.webContents.send('dictionary-navigation', {
                back: dictionaryContents.navigationHistory.canGoBack(),
                forward: dictionaryContents.navigationHistory.canGoForward()
            });
        }
    }

    if (youdaoWindow && !youdaoWindow.isDestroyed()) {
        if (youdaoWindow.isMinimized()) youdaoWindow.restore();
        youdaoWindow.show();
        youdaoWindow.focus();
        dictionaryContents?.focus();
    }
}

function lookup(word, sender) {
    if (typeof word !== 'string' || !word.trim()) return;
    return showDictionary(word.trim(), sender);
}

function openDictionary(sender) {
    return showDictionary(null, sender);
}

module.exports = { lookup, openDictionary, setDictionaryTheme };
