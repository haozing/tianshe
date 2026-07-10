const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const inputPath = path.join(root, "assets", "icon-chihu.png");
const outputPath = path.join(root, "assets", "icon-chihu.ico");

function readPngSize(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("assets/icon-chihu.png is not a PNG file");
  }
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("assets/icon-chihu.png is missing PNG IHDR header");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function createIcoFromPng(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const directory = Buffer.alloc(16);
  directory.writeUInt8(0, 0); // 0 means 256px in ICO files.
  directory.writeUInt8(0, 1);
  directory.writeUInt8(0, 2);
  directory.writeUInt8(0, 3);
  directory.writeUInt16LE(1, 4);
  directory.writeUInt16LE(32, 6);
  directory.writeUInt32LE(png.length, 8);
  directory.writeUInt32LE(header.length + directory.length, 12);

  return Buffer.concat([header, directory, png]);
}

const png = fs.readFileSync(inputPath);
const { width, height } = readPngSize(png);
if (width !== height || width < 256) {
  throw new Error(`assets/icon-chihu.png must be a square PNG of at least 256px, got ${width}x${height}`);
}

fs.writeFileSync(outputPath, createIcoFromPng(png));
console.log(`[create-windows-icon] wrote ${path.relative(root, outputPath)} from ${width}x${height} PNG`);
