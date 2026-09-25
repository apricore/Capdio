const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const python = process.env.CAPDIO_PYTHON || process.env.CAPDIO_PYTHON_ARM64 || 'python';

execFileSync(python, [path.join(root, 'python', 'download_model.py')], {
  cwd: root,
  stdio: 'inherit'
});
