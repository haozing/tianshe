const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const appIconPng = path.join(root, "assets", "icon-chihu.png");
const appIconIco = path.join(root, "assets", "icon-chihu.ico");
const expectedIconSizes = new Set([16, 24, 32, 48, 64, 128, 256]);

function fail(message) {
  console.error(`[check-assets] ${message}`);
  process.exitCode = 1;
}

function readPngSize(buffer, label) {
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    throw new Error(`${label} is not a PNG file`);
  }
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error(`${label} is missing PNG IHDR header`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function validateIco(buffer) {
  if (buffer.length < 22 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    fail("assets/icon-chihu.ico is not a valid ICO file");
    return;
  }

  const count = buffer.readUInt16LE(4);
  if (count < expectedIconSizes.size) {
    fail(`assets/icon-chihu.ico should contain ${expectedIconSizes.size} icon sizes, got ${count}`);
    return;
  }

  const foundSizes = new Set();
  for (let index = 0; index < count; index += 1) {
    const directoryOffset = 6 + index * 16;
    const declaredWidth = buffer[directoryOffset] || 256;
    const declaredHeight = buffer[directoryOffset + 1] || 256;
    const bytes = buffer.readUInt32LE(directoryOffset + 8);
    const imageOffset = buffer.readUInt32LE(directoryOffset + 12);
    if (declaredWidth !== declaredHeight || imageOffset + bytes > buffer.length) {
      fail(`assets/icon-chihu.ico has an invalid entry at index ${index}`);
      continue;
    }

    const png = buffer.subarray(imageOffset, imageOffset + bytes);
    const actualSize = readPngSize(png, `assets/icon-chihu.ico entry ${index}`);
    if (actualSize.width !== declaredWidth || actualSize.height !== declaredHeight) {
      fail(`assets/icon-chihu.ico entry ${index} declares ${declaredWidth}x${declaredHeight} but contains ${actualSize.width}x${actualSize.height}`);
    }
    foundSizes.add(declaredWidth);
  }

  for (const size of expectedIconSizes) {
    if (!foundSizes.has(size)) {
      fail(`assets/icon-chihu.ico is missing ${size}x${size} icon size`);
    }
  }
}

try {
  if (!fs.existsSync(appIconPng)) {
    fail("assets/icon-chihu.png is missing");
  } else {
    const { width, height } = readPngSize(fs.readFileSync(appIconPng), "assets/icon-chihu.png");
    if (width !== height || width < 256) {
      fail(`assets/icon-chihu.png must be a square PNG of at least 256px, got ${width}x${height}`);
    }
  }
  if (!fs.existsSync(appIconIco)) {
    fail("assets/icon-chihu.ico is missing; run npm run prepare:icons");
  } else {
    validateIco(fs.readFileSync(appIconIco));
  }
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}

if (!process.exitCode) {
  console.log("[check-assets] ok");
}
