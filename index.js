const fs = require('node:fs');
const path = require('node:path');

const mainEntry = path.join(__dirname, 'dist', 'main', 'index.js');

if (!fs.existsSync(mainEntry)) {
  throw new Error(
    [
      'Missing Electron main build at dist/main/index.js.',
      'Run `npm run build:main` or `npm run build:open` before launching Electron from the repository root.',
    ].join(' ')
  );
}

require(mainEntry);
