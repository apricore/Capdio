# Packaging Capdio for Windows

Capdio's Windows installer includes Electron, FFmpeg, a frozen Whisper
transcriber, and the Whisper `base` model. End users do not need Python,
Whisper, or FFmpeg installed.

Use Node.js 22.12 or newer. Build from an isolated Python environment so
PyInstaller does not accidentally include Anaconda or other development-only
packages:

```powershell
npm install
py -3.13 -m venv .venv-packaging
.\.venv-packaging\Scripts\python -m pip install --upgrade pip
.\.venv-packaging\Scripts\python -m pip install -r python\requirements-build.txt
$env:CAPDIO_PYTHON = (Resolve-Path .\.venv-packaging\Scripts\python.exe)
npm run dist:win
```

`dist:win` builds the React app, freezes `python/transcribe.py` with
PyInstaller, downloads/stages the Whisper `base` model, and creates an NSIS
installer in `release/`.

The generated runtime resources are intentionally ignored by Git:

- `resources/bin/win32-x64/capdio-transcribe/` — Python, Torch, and Whisper
- `resources/bin/win32-x64/ffmpeg.exe` — FFmpeg is sourced from `ffmpeg-static`
- `resources/models/base.pt` — Whisper model

Each target platform/architecture needs its own build. The included pipeline
targets Windows x64.

Installed projects are stored in Electron's user-data directory rather than
the installation folder, so imported media and captions remain writable.
