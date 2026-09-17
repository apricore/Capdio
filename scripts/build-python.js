const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const python = process.env.CAPDIO_PYTHON || 'python';
const target = `${process.platform}-${process.arch}`;
const outputRoot = path.join(root, 'resources', 'bin', target);
const output = path.join(outputRoot, 'capdio-transcribe');
const build = path.join(root, 'build', 'cx-freeze');

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.rmSync(build, { recursive: true, force: true });

execFileSync(python, [
  path.join(root, 'python', 'setup.py'),
  'build_exe',
  `--build-exe=${output}`
], { cwd: root, stdio: 'inherit' });
