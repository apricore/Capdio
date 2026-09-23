const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const destination = path.join(__dirname, '..', 'resources', 'bin', 'win32-x64', 'yt-dlp.exe');
const releaseUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

function download(url, redirects = 0) {
    if (redirects > 8) throw new Error('Too many redirects while downloading yt-dlp.');
    https.get(url, { headers: { 'User-Agent': 'Capdio packaging' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            download(new URL(response.headers.location, url).href, redirects + 1);
            return;
        }
        if (response.statusCode !== 200) {
            response.resume();
            throw new Error(`yt-dlp download failed with HTTP ${response.statusCode}.`);
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.download`;
        const output = fs.createWriteStream(temporary);
        response.pipe(output);
        output.on('finish', () => {
            output.close();
            fs.rmSync(destination, { force: true });
            fs.renameSync(temporary, destination);
            console.log(`Staged yt-dlp at ${destination}`);
        });
        output.on('error', (error) => {
            fs.rmSync(temporary, { force: true });
            throw error;
        });
    }).on('error', (error) => { throw error; });
}

if (fs.existsSync(destination) && fs.statSync(destination).size > 1_000_000) {
    console.log(`Using existing yt-dlp at ${destination}`);
} else {
    download(releaseUrl);
}
