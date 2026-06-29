#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const repoRoot = path.resolve(__dirname, '..');
const fromRoot = (...parts) => path.join(repoRoot, ...parts);

const iconSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icnsTypes = new Map([
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10'],
]);

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

const writeIco = (entries, outputPath) => {
  const headerSize = 6;
  const directorySize = entries.length * 16;
  let imageOffset = headerSize + directorySize;
  const header = Buffer.alloc(headerSize + directorySize);

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  entries.forEach((entry, index) => {
    const offset = headerSize + index * 16;
    header.writeUInt8(entry.size >= 256 ? 0 : entry.size, offset);
    header.writeUInt8(entry.size >= 256 ? 0 : entry.size, offset + 1);
    header.writeUInt8(0, offset + 2);
    header.writeUInt8(0, offset + 3);
    header.writeUInt16LE(1, offset + 4);
    header.writeUInt16LE(32, offset + 6);
    header.writeUInt32LE(entry.buffer.length, offset + 8);
    header.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += entry.buffer.length;
  });

  fs.writeFileSync(outputPath, Buffer.concat([header, ...entries.map((entry) => entry.buffer)]));
};

const writeIcns = (entries, outputPath) => {
  const chunks = entries.map((entry) => {
    const type = icnsTypes.get(entry.size);
    if (!type) {
      throw new Error(`Unsupported ICNS size: ${entry.size}`);
    }
    const chunk = Buffer.alloc(8 + entry.buffer.length);
    chunk.write(type, 0, 4, 'ascii');
    chunk.writeUInt32BE(chunk.length, 4);
    entry.buffer.copy(chunk, 8);
    return chunk;
  });

  const totalSize = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(totalSize, 4);
  fs.writeFileSync(outputPath, Buffer.concat([header, ...chunks]));
};

const renderPng = async (svgBuffer, size, outputPath) => {
  await sharp(svgBuffer)
    .resize(size, size, { fit: 'contain' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);
};

const renderHorizontalPng = async (inputPath, outputPath) => {
  await sharp(inputPath)
    .resize(1600, 480, { fit: 'contain' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);
};

async function main() {
  const brandDir = fromRoot('assets', 'brand');
  const docsBrandDir = fromRoot('docs', 'assets', 'brand');
  const iconsDir = fromRoot('assets', 'icons');

  ensureDir(brandDir);
  ensureDir(docsBrandDir);
  ensureDir(iconsDir);
  ensureDir(fromRoot('build'));

  const markPath = fromRoot('assets', 'brand', 'tianshe-mark.svg');
  const lightLogoPath = fromRoot('assets', 'brand', 'tianshe-logo-horizontal-light.svg');
  const darkLogoPath = fromRoot('assets', 'brand', 'tianshe-logo-horizontal-dark.svg');
  const markSvg = fs.readFileSync(markPath);

  fs.copyFileSync(markPath, fromRoot('assets', 'icon.svg'));
  fs.copyFileSync(markPath, fromRoot('docs', 'assets', 'brand', 'tianshe-mark.svg'));
  fs.copyFileSync(lightLogoPath, fromRoot('docs', 'assets', 'brand', 'tianshe-logo-horizontal-light.svg'));
  fs.copyFileSync(darkLogoPath, fromRoot('docs', 'assets', 'brand', 'tianshe-logo-horizontal-dark.svg'));

  const rendered = new Map();
  for (const size of iconSizes) {
    const outputPath = fromRoot('assets', 'icons', `${size}x${size}.png`);
    await renderPng(markSvg, size, outputPath);
    rendered.set(size, fs.readFileSync(outputPath));
  }

  fs.copyFileSync(fromRoot('assets', 'icons', '1024x1024.png'), fromRoot('assets', 'icon.png'));
  fs.copyFileSync(fromRoot('assets', 'icons', '512x512.png'), fromRoot('build', 'icon.png'));
  fs.copyFileSync(fromRoot('assets', 'icons', '1024x1024.png'), fromRoot('docs', 'assets', 'brand', 'tianshe-mark-1024.png'));

  writeIco(
    icoSizes.map((size) => ({ size, buffer: rendered.get(size) })),
    fromRoot('assets', 'icon.ico')
  );
  fs.copyFileSync(fromRoot('assets', 'icon.ico'), fromRoot('build', 'icon.ico'));

  writeIcns(
    [16, 32, 64, 128, 256, 512, 1024].map((size) => ({ size, buffer: rendered.get(size) })),
    fromRoot('assets', 'icon.icns')
  );
  fs.copyFileSync(fromRoot('assets', 'icon.icns'), fromRoot('build', 'icon.icns'));

  await renderHorizontalPng(
    lightLogoPath,
    fromRoot('docs', 'assets', 'brand', 'tianshe-logo-horizontal-light.png')
  );
  await renderHorizontalPng(
    darkLogoPath,
    fromRoot('docs', 'assets', 'brand', 'tianshe-logo-horizontal-dark.png')
  );

  console.log('[logo-assets] generated icon and brand assets');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
