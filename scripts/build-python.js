const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const python = process.env.CAPDIO_PYTHON || 'python';
const target = `${process.platform}-${process.arch}`;
const output = path.join(root, 'resources', 'bin', target);
const build = path.join(root, 'build', 'pyinstaller');

execFileSync(python, [
  '-m', 'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onedir',
  '--name', 'capdio-transcribe',
  '--distpath', output,
  '--workpath', build,
  '--specpath', build,
  '--collect-data', 'whisper',
  '--collect-data', 'tiktoken',
  '--collect-binaries', 'tiktoken',
  '--exclude-module', 'PyQt5',
  '--exclude-module', 'PyQt6',
  '--exclude-module', 'PySide2',
  '--exclude-module', 'PySide6',
  path.join(root, 'python', 'transcribe.py')
], { cwd: root, stdio: 'inherit' });
