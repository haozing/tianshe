const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.join(__dirname, "..");
const inputPath = path.join(root, "assets", "icon-chihu.png");
const outputPath = path.join(root, "assets", "icon-chihu.ico");
const iconSizes = [16, 24, 32, 48, 64, 128, 256];
const outputPaddingRatio = 0.03;

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
}

const crc32Table = createCrc32Table();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function paeth(a, b, c) {
  const predictor = a + b - c;
  const pa = Math.abs(predictor - a);
  const pb = Math.abs(predictor - b);
  const pc = Math.abs(predictor - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

function readPng(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("assets/icon-chihu.png is not a PNG file");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  let position = 8;
  while (position < buffer.length) {
    const length = buffer.readUInt32BE(position);
    const type = buffer.subarray(position + 4, position + 8).toString("ascii");
    const data = buffer.subarray(position + 8, position + 8 + length);
    position += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!width || !height || !idatChunks.length) {
    throw new Error("assets/icon-chihu.png is missing PNG image data");
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
    throw new Error(`assets/icon-chihu.png must be an 8-bit non-interlaced RGB/RGBA PNG, got bit=${bitDepth} color=${colorType} interlace=${interlace}`);
  }

  const sourceBytesPerPixel = colorType === 6 ? 4 : 3;
  const sourceStride = width * sourceBytesPerPixel;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const decoded = Buffer.alloc(height * sourceStride);
  let rawPosition = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawPosition];
    rawPosition += 1;
    const row = raw.subarray(rawPosition, rawPosition + sourceStride);
    rawPosition += sourceStride;
    const outputRow = decoded.subarray(y * sourceStride, (y + 1) * sourceStride);
    const previousRow = y > 0 ? decoded.subarray((y - 1) * sourceStride, y * sourceStride) : null;

    for (let x = 0; x < sourceStride; x += 1) {
      const left = x >= sourceBytesPerPixel ? outputRow[x - sourceBytesPerPixel] : 0;
      const up = previousRow ? previousRow[x] : 0;
      const upLeft = previousRow && x >= sourceBytesPerPixel ? previousRow[x - sourceBytesPerPixel] : 0;
      let value = row[x];

      if (filter === 1) {
        value = (value + left) & 0xff;
      } else if (filter === 2) {
        value = (value + up) & 0xff;
      } else if (filter === 3) {
        value = (value + Math.floor((left + up) / 2)) & 0xff;
      } else if (filter === 4) {
        value = (value + paeth(left, up, upLeft)) & 0xff;
      } else if (filter !== 0) {
        throw new Error(`assets/icon-chihu.png uses unsupported PNG filter ${filter}`);
      }

      outputRow[x] = value;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < decoded.length; i += sourceBytesPerPixel, j += 4) {
    rgba[j] = decoded[i];
    rgba[j + 1] = decoded[i + 1];
    rgba[j + 2] = decoded[i + 2];
    rgba[j + 3] = colorType === 6 ? decoded[i + 3] : 255;
  }

  return {
    width,
    height,
    data: rgba
  };
}

function findAlphaBounds(image) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * 4 + 3];
      if (alpha > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < 0) {
    throw new Error("assets/icon-chihu.png has no visible pixels");
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function createSquareCrop(bounds, image) {
  const side = Math.max(bounds.width, bounds.height);
  const centerX = (bounds.minX + bounds.maxX + 1) / 2;
  const centerY = (bounds.minY + bounds.maxY + 1) / 2;
  return {
    x: Math.max(0, Math.min(image.width - side, centerX - side / 2)),
    y: Math.max(0, Math.min(image.height - side, centerY - side / 2)),
    size: side
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sampleBilinear(image, sourceX, sourceY) {
  const x0 = clamp(Math.floor(sourceX), 0, image.width - 1);
  const y0 = clamp(Math.floor(sourceY), 0, image.height - 1);
  const x1 = clamp(x0 + 1, 0, image.width - 1);
  const y1 = clamp(y0 + 1, 0, image.height - 1);
  const tx = clamp(sourceX - x0, 0, 1);
  const ty = clamp(sourceY - y0, 0, 1);
  const samples = [
    { x: x0, y: y0, weight: (1 - tx) * (1 - ty) },
    { x: x1, y: y0, weight: tx * (1 - ty) },
    { x: x0, y: y1, weight: (1 - tx) * ty },
    { x: x1, y: y1, weight: tx * ty }
  ];

  let alpha = 0;
  let red = 0;
  let green = 0;
  let blue = 0;

  for (const sample of samples) {
    const offset = (sample.y * image.width + sample.x) * 4;
    const sampleAlpha = image.data[offset + 3] / 255;
    const weightedAlpha = sampleAlpha * sample.weight;
    alpha += weightedAlpha;
    red += image.data[offset] * weightedAlpha;
    green += image.data[offset + 1] * weightedAlpha;
    blue += image.data[offset + 2] * weightedAlpha;
  }

  if (alpha <= 0) {
    return [0, 0, 0, 0];
  }

  return [
    Math.round(red / alpha),
    Math.round(green / alpha),
    Math.round(blue / alpha),
    Math.round(alpha * 255)
  ];
}

function resizeImage(image, crop, size) {
  const output = Buffer.alloc(size * size * 4);
  const padding = Math.max(1, Math.round(size * outputPaddingRatio));
  const contentSize = size - padding * 2;

  for (let y = 0; y < contentSize; y += 1) {
    for (let x = 0; x < contentSize; x += 1) {
      const sourceX = crop.x + ((x + 0.5) / contentSize) * crop.size - 0.5;
      const sourceY = crop.y + ((y + 0.5) / contentSize) * crop.size - 0.5;
      const pixel = sampleBilinear(image, sourceX, sourceY);
      const outputOffset = ((y + padding) * size + x + padding) * 4;
      output[outputOffset] = pixel[0];
      output[outputOffset + 1] = pixel[1];
      output[outputOffset + 2] = pixel[2];
      output[outputOffset + 3] = pixel[3];
    }
  }

  return {
    width: size,
    height: size,
    data: output
  };
}

function encodePng(image) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const rawOffset = y * (stride + 1);
    raw[rawOffset] = 0;
    image.data.copy(raw, rawOffset + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    createPngChunk("IHDR", ihdr),
    createPngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    createPngChunk("IEND", Buffer.alloc(0))
  ]);
}

function createIcoFromPngEntries(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const directoryOffset = index * 16;
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, directoryOffset);
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, directoryOffset + 1);
    directory.writeUInt8(0, directoryOffset + 2);
    directory.writeUInt8(0, directoryOffset + 3);
    directory.writeUInt16LE(1, directoryOffset + 4);
    directory.writeUInt16LE(32, directoryOffset + 6);
    directory.writeUInt32LE(entry.png.length, directoryOffset + 8);
    directory.writeUInt32LE(offset, directoryOffset + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

const sourcePng = fs.readFileSync(inputPath);
const sourceImage = readPng(sourcePng);
if (sourceImage.width !== sourceImage.height || sourceImage.width < 256) {
  throw new Error(`assets/icon-chihu.png must be a square PNG of at least 256px, got ${sourceImage.width}x${sourceImage.height}`);
}

const visibleBounds = findAlphaBounds(sourceImage);
const crop = createSquareCrop(visibleBounds, sourceImage);
const entries = iconSizes.map((size) => ({
  size,
  png: encodePng(resizeImage(sourceImage, crop, size))
}));

fs.writeFileSync(outputPath, createIcoFromPngEntries(entries));
console.log(
  `[create-windows-icon] wrote ${path.relative(root, outputPath)} from ${sourceImage.width}x${sourceImage.height} PNG; ` +
    `visible ${visibleBounds.width}x${visibleBounds.height}; generated ${iconSizes.join(", ")}px`
);
