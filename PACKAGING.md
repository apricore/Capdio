# Packaging Capdio for Windows

Capdio's Windows installer includes Electron, FFmpeg, a bundled Whisper
transcriber, and the Whisper `base` model. End users do not need Python,
Whisper, or FFmpeg installed.

Use Git, Node.js 22.12 or newer, and Python 3.13 x64. Build from an isolated
Python environment so the bundled runtime does not depend on packages from
another Python installation. From a fresh clone:

```powershell
git clone <repository-url>
cd Capdio
npm ci
```

Before building the installer, start the development app once so Electron can
finish setting up its local runtime files. Run these commands from the project
directory in separate terminals:

```powershell
npm run dev
npm start
```

Stop both processes after the app opens, then continue with the packaging
commands below:

```powershell
py -3.13 -m venv .venv-packaging
.\.venv-packaging\Scripts\python -m pip install --upgrade pip
.\.venv-packaging\Scripts\python -m pip install -r python\requirements-build.txt
$env:CAPDIO_PYTHON = (Resolve-Path .\.venv-packaging\Scripts\python.exe)
npm run dist:win
```

`dist:win` builds the React app, bundles `python/transcribe.py` with cx_Freeze,
downloads/stages the Whisper `base` model, and creates an NSIS
installer in `release/`.

The generated runtime resources are intentionally ignored by Git:

- `resources/bin/win32-x64/capdio-transcribe/` — Python, Torch, and Whisper
- `resources/bin/win32-x64/ffmpeg.exe` — FFmpeg is sourced from `ffmpeg-static`
- `resources/models/base.pt` — Whisper model

The build regenerates all ignored packaging resources, so a fresh clone does
not need the `resources/` or `release/` directories from another machine.
Each target platform/architecture needs its own build. The included pipeline
targets Windows x64.

Installed projects are stored in Electron's user-data directory rather than
the installation folder, so imported media and captions remain writable.
