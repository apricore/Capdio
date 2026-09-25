const fs = require('node:fs');
const path = require('node:path');

exports = module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== 'darwin' || path.basename(context.appOutDir) !== 'mac-universal') return;

    const resourcesDirectory = path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources'
    );
    const root = path.resolve(__dirname, '..');

    fs.cpSync(path.join(root, 'resources', 'bin', 'darwin-x64'), path.join(resourcesDirectory, 'bin', 'darwin-x64'), { recursive: true });
    fs.cpSync(path.join(root, 'resources', 'bin', 'darwin-arm64'), path.join(resourcesDirectory, 'bin', 'darwin-arm64'), { recursive: true });
    fs.cpSync(path.join(root, 'resources', 'models'), path.join(resourcesDirectory, 'models'), { recursive: true });
    fs.mkdirSync(path.join(resourcesDirectory, 'licenses'), { recursive: true });
    fs.copyFileSync(
        path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.LICENSE'),
        path.join(resourcesDirectory, 'licenses', 'ffmpeg-static.LICENSE')
    );
};