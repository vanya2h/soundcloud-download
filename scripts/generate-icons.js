#!/usr/bin/env node
// Generates PNG icons for the extension using only Node.js built-ins.
// Produces orange-on-dark SC-style waveform icons at 16, 48, and 128px.

import { createWriteStream, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../extension/public/icons');
mkdirSync(OUT_DIR, { recursive: true });

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createPng(size) {
  // Draw a simple waveform icon
  const pixels = new Uint8Array(size * size * 4);

  // Background: dark
  const bgR = 0x11, bgG = 0x11, bgB = 0x11;
  // Accent: SoundCloud orange
  const acR = 0xff, acG = 0x55, acB = 0x00;

  // Fill background
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4]     = bgR;
    pixels[i * 4 + 1] = bgG;
    pixels[i * 4 + 2] = bgB;
    pixels[i * 4 + 3] = 255;
  }

  // Draw a simple waveform bar pattern
  const bars = size <= 16 ? 4 : size <= 48 ? 8 : 14;
  const barW = Math.max(1, Math.floor(size * 0.055));
  const gap  = Math.max(1, Math.floor(size * 0.03));
  const totalW = bars * barW + (bars - 1) * gap;
  const startX = Math.floor((size - totalW) / 2);
  const centerY = Math.floor(size / 2);

  // Bar heights (normalized 0–1, waveform shape)
  const heights = Array.from({ length: bars }, (_, i) => {
    const t = i / (bars - 1);
    return 0.25 + 0.6 * Math.sin(Math.PI * t) + 0.15 * Math.sin(Math.PI * 3 * t);
  });

  for (let b = 0; b < bars; b++) {
    const x0 = startX + b * (barW + gap);
    const halfH = Math.floor(heights[b] * size * 0.4);
    for (let x = x0; x < x0 + barW && x < size; x++) {
      for (let y = centerY - halfH; y <= centerY + halfH; y++) {
        if (y >= 0 && y < size) {
          const idx = (y * size + x) * 4;
          pixels[idx]     = acR;
          pixels[idx + 1] = acG;
          pixels[idx + 2] = acB;
          pixels[idx + 3] = 255;
        }
      }
    }
  }

  // Build PNG raw data (filter byte 0 per row)
  let raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * (size * 4 + 1) + 1 + x * 4;
      raw[dst]     = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
      raw[dst + 3] = pixels[src + 3];
    }
  }

  const compressed = zlib.deflateSync(raw);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  const dest = join(OUT_DIR, `icon${size}.png`);
  createWriteStream(dest).end(createPng(size));
  console.log(`✓ ${dest}`);
}

console.log('Icons generated.');
