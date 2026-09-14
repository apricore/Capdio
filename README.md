# Capdio

Capdio is a local media library, transcription, and caption playback app built
with Electron, React, OpenAI Whisper, and FFmpeg.

The Windows installer is self-contained: users do not need Python, Whisper, or
FFmpeg installed separately.

## Development

Install JavaScript dependencies:

```powershell
npm install
```

Run the Vite renderer in one terminal:

```powershell
npm run dev
```

Run Electron in another terminal:

```powershell
npm start
```

For local transcription during development, Python, OpenAI Whisper, and FFmpeg
must be available on your machine.

## Build the Windows installer

Requirements:

- Node.js 22.12 or newer
- Python 3.13

Create the isolated Python build environment once:

```powershell
py -3.13 -m venv .venv-packaging
.\.venv-packaging\Scripts\python -m pip install --upgrade pip
.\.venv-packaging\Scripts\python -m pip install -r python\requirements-build.txt
```

Each time you open a new PowerShell terminal, select that environment for the
packaging scripts:

```powershell
$env:CAPDIO_PYTHON = (Resolve-Path .\.venv-packaging\Scripts\python.exe)
```

Then build everything:

```powershell
npm run dist:win
```

This command:

1. Builds the React application.
2. Freezes `python/transcribe.py` into a Windows executable with PyInstaller.
3. Stages the offline Whisper `base` model.
4. Bundles FFmpeg.
5. Creates the NSIS installer.

The installer is written to:

```text
release\Capdio Setup <version>.exe
```

## Rebuilding after Python changes

After editing `python/transcribe.py`, run:

```powershell
$env:CAPDIO_PYTHON = (Resolve-Path .\.venv-packaging\Scripts\python.exe)
npm run dist:win
```

This rebuilds the frozen transcriber and produces a new installer.

## Rebuild only the Electron installer

When the existing bundled Python transcriber and Whisper model are still valid,
for example after a React, CSS, Electron, or Vite change, run:

```powershell
npm run repackage:win
```

This rebuilds the web application and NSIS installer while reusing
`resources/bin/` and `resources/models/`.

## Useful commands

```powershell
npm run build              # Build the React application only
npm run build:python       # Freeze the Python transcriber only
npm run download:model     # Stage the Whisper base model only
npm run dist:win           # Build the complete Windows installer
npm run repackage:win      # Rebuild installer without rebuilding Python/Whisper
```

Generated Python binaries, Whisper models, installers, and the local media
library are ignored by Git.
