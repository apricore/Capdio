const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') {
    throw new Error('The macOS universal resource build must run on macOS.');
}

const root = path.resolve(__dirname, '..');
const pythonByArchitecture = {
    x64: process.env.CAPDIO_PYTHON_X64,
    arm64: process.env.CAPDIO_PYTHON_ARM64
};
const ffmpegByArchitecture = {
    x64: process.env.CAPDIO_FFMPEG_X64,
    arm64: process.env.CAPDIO_FFMPEG_ARM64
};
const license = process.env.CAPDIO_FFMPEG_LICENSE;

for (const architecture of Object.keys(pythonByArchitecture)) {
    if (!pythonByArchitecture[architecture]) {
        throw new Error(`Set CAPDIO_PYTHON_${architecture.toUpperCase()} to an architecture-matching Python executable.`);
    }
    if (!ffmpegByArchitecture[architecture]) {
        throw new Error(`Set CAPDIO_FFMPEG_${architecture.toUpperCase()} to an architecture-matching FFmpeg binary.`);
    }
}
if (!license) {
    throw new Error('Set CAPDIO_FFMPEG_LICENSE to the FFmpeg license file.');
}

for (const [architecture, python] of Object.entries(pythonByArchitecture)) {
    const outputRoot = path.join(root, 'resources', 'bin', `darwin-${architecture}`);
    fs.rmSync(outputRoot, { recursive: true, force: true });
    execFileSync(python, [
        path.join(root, 'python', 'setup.py'),
        'build_exe',
        `--build-exe=${path.join(outputRoot, 'capdio-transcribe')}`
    ], { cwd: root, stdio: 'inherit' });

    const ffmpeg = ffmpegByArchitecture[architecture];
    const ffmpegTarget = path.join(outputRoot, 'ffmpeg');
    fs.copyFileSync(ffmpeg, ffmpegTarget);
    fs.chmodSync(ffmpegTarget, 0o755);
}
const licenseDirectory = path.join(root, 'resources', 'licenses');
fs.mkdirSync(licenseDirectory, { recursive: true });
fs.copyFileSync(license, path.join(licenseDirectory, 'ffmpeg-static.LICENSE'));