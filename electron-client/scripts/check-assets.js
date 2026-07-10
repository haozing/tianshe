const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const appIconPng = path.join(root, "assets", "icon-chihu.png");
const appIconIco = path.join(root, "assets", "icon-chihu.ico");

function fail(message) {
  console.error(`[check-assets] ${message}`);
  process.exitCode = 1;
}

function readPngSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    throw new Error("icon-chihu.png is not a PNG file");
  }
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("icon-chihu.png is missing PNG IHDR header");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

try {
  if (!fs.existsSync(appIconPng)) {
    fail("assets/icon-chihu.png is missing");
  } else {
    const { width, height } = readPngSize(appIconPng);
    if (width !== height || width < 256) {
      fail(`assets/icon-chihu.png must be a square PNG of at least 256px, got ${width}x${height}`);
    }
  }
  if (!fs.existsSync(appIconIco)) {
    fail("assets/icon-chihu.ico is missing; run npm run prepare:icons");
  } else {
    const icon = fs.readFileSync(appIconIco);
    if (icon.length < 22 || icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1 || icon.readUInt16LE(4) < 1) {
      fail("assets/icon-chihu.ico is not a valid ICO file");
    }
  }
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}

if (!process.exitCode) {
  console.log("[check-assets] ok");
}
