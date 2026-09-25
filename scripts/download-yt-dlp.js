const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const root = path.join(__dirname, '..');
const isMac = process.argv.includes('--mac');
const releaseUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${isMac ? 'yt-dlp_macos' : 'yt-dlp.exe'}`;
const destinations = isMac
    ? [
        path.join(root, 'resources', 'bin', 'darwin-x64', 'yt-dlp'),
        path.join(root, 'resources', 'bin', 'darwin-arm64', 'yt-dlp')
    ]
    : [path.join(root, 'resources', 'bin', 'win32-x64', 'yt-dlp.exe')];

function download(url, destination, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 8) {
            reject(new Error('Too many redirects while downloading yt-dlp.'));
            return;
        }
        https.get(url, { headers: { 'User-Agent': 'Capdio packaging' } }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                download(new URL(response.headers.location, url).href, destination, redirects + 1)
                    .then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`yt-dlp download failed with HTTP ${response.statusCode}.`));
                return;
            }
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            const temporary = `${destination}.download`;
            const output = fs.createWriteStream(temporary);
            response.pipe(output);
            output.on('finish', () => {
                output.close();
                fs.rmSync(destination, { force: true });
                fs.renameSync(temporary, destination);
                if (isMac) fs.chmodSync(destination, 0o755);
                console.log(`Staged yt-dlp at ${destination}`);
                resolve();
            });
            output.on('error', (error) => {
                fs.rmSync(temporary, { force: true });
                reject(error);
            });
        }).on('error', reject);
    });
}

async function main() {
    const existing = destinations.every((destination) =>
        fs.existsSync(destination) && fs.statSync(destination).size > 1_000_000
    );
    if (existing) {
        console.log(`Using existing yt-dlp at ${destinations.join(', ')}`);
        return;
    }

    await download(releaseUrl, destinations[0]);
    for (const destination of destinations.slice(1)) {
        fs.copyFileSync(destinations[0], destination);
        fs.chmodSync(destination, 0o755);
        console.log(`Staged yt-dlp at ${destination}`);
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
