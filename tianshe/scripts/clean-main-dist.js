const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const targets = ['dist/main', 'dist/core', 'dist/preload', 'dist/types'];

for (const relativePath of targets) {
  const targetPath = path.join(root, relativePath);
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    console.log(`[clean-main-dist] removed ${relativePath}`);
  } catch (error) {
    console.warn(
      `[clean-main-dist] failed to remove ${relativePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
