const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(file) : entry.name.endsWith('.js') ? [file] : [];
  });
}

const files = [
  path.join(root, 'server.js'),
  __filename,
  ...['src', 'lib', 'public'].flatMap((directory) => javascriptFiles(path.join(root, directory))),
  ...['set-password.js', 'generate-signing-key.js', 'generate-content-library.js', 'generate-companion-content-pack.js', 'import-release.js', 'migrate.js']
    .map((file) => path.join(__dirname, file))
];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    console.error(result.error || result.stderr || `${file}: syntax check failed`);
    process.exit(1);
  }
}
console.log(`Syntax checks passed for ${files.length} JavaScript files (including the current admin directory).`);
