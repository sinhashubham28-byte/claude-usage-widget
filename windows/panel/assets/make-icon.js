// One-off generator for the app's icons (no external assets/deps needed).
// Run with: node make-icon.js
// Produces:
//   tray-icon.png  (32x32)  — system tray icon
//   app-icon.ico   (256x256) — window/installer/Start-Menu/uninstaller icon
// Both are a solid rounded dot in Anthropic's coral, since there's no
// existing brand asset to draw from in this repo.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(width, height, pixelFn) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  const ihdr = chunk('IHDR', ihdrData);

  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// Modern ICO files can embed a PNG directly per image entry (no need to
// hand-encode BMP/DIB data) — every current Windows version supports this.
function makeIco(pngBuffers) {
  const count = pngBuffers.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(count, 4);

  let offset = 6 + 16 * count;
  const entries = [];
  const datas = [];
  for (const { width, png } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(width >= 256 ? 0 : width, 0); // 0 means 256
    entry.writeUInt8(width >= 256 ? 0 : width, 1);
    entry.writeUInt8(0, 2); // color palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
    datas.push(png);
  }
  return Buffer.concat([dir, ...entries, ...datas]);
}

function drawDot(size) {
  const center = size / 2;
  const radius = size / 2 - Math.max(1, size * 0.09);
  return (x, y) => {
    const dx = x + 0.5 - center;
    const dy = y + 0.5 - center;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > radius + 1) return [0, 0, 0, 0];
    const edge = Math.max(0, Math.min(1, radius + 1 - dist));
    const alpha = Math.round(255 * edge);
    return [217, 119, 87, alpha]; // #D97757 — Anthropic coral
  };
}

const trayPng = makePng(32, 32, drawDot(32));
fs.writeFileSync(path.join(__dirname, 'tray-icon.png'), trayPng);
console.log('wrote tray-icon.png (32x32)');

const appPng = makePng(256, 256, drawDot(256));
const ico = makeIco([{ width: 256, png: appPng }]);
fs.writeFileSync(path.join(__dirname, 'app-icon.ico'), ico);
console.log('wrote app-icon.ico (256x256)');
