# Packaging Capdio

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
- `resources/bin/win32-x64/yt-dlp.exe` — staged from the official yt-dlp release by `npm run download:yt-dlp`
- `resources/models/base.pt` — Whisper model

The build regenerates all ignored packaging resources, so a fresh clone does
not need the `resources/` or `release/` directories from another machine.

## macOS universal installer

Build on macOS with one native Python environment for each architecture. Each
environment must contain the requirements in `python/requirements-build.txt`,
and each FFmpeg binary must match its architecture:

```sh
export CAPDIO_PYTHON_X64=/path/to/x64/.venv/bin/python
export CAPDIO_PYTHON_ARM64=/path/to/arm64/.venv/bin/python
export CAPDIO_FFMPEG_X64=/path/to/x64/ffmpeg
export CAPDIO_FFMPEG_ARM64=/path/to/arm64/ffmpeg
export CAPDIO_FFMPEG_LICENSE=/path/to/ffmpeg-static.LICENSE
export CAPDIO_PYTHON=$CAPDIO_PYTHON_ARM64
npm run dist:mac
```

The command creates a universal `Capdio.dmg` in `release/`. Both native
transcribers and FFmpeg binaries are included; the app selects the matching
one at runtime. Build the two environments using native Node/Python processes
or under Rosetta for x64 so Torch and cx_Freeze produce the correct binaries.

Installed projects are stored in Electron's user-data directory rather than
the installation folder, so imported media and captions remain writable.
