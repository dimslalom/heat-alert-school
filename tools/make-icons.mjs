#!/usr/bin/env node
// Generates icon-192.png, icon-512.png (maskable) and apple-touch-icon.png.
//
// WHY HAND-ROLLED
// This project has no build step and no npm dependencies, and the machine it was
// authored on had no ImageMagick, no PIL and no librsvg. A PNG is just a few
// length-prefixed, CRC'd chunks wrapping zlib-compressed scanlines, and Node
// ships zlib — so encoding one directly is less machinery than adding a toolchain.
//
// The art echoes the logo: three concentric semicircular arcs radiating from
// orange to red on an ink background, i.e. heat rising off a horizon line.
//
// Run:  node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------- PNG codec */

// Standard CRC-32 (PNG spec annex D), table built once.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Encodes 8-bit truecolour RGB (colour type 2). The icons are fully opaque —
// maskable icons must fill their canvas, and iOS composites apple-touch-icon on
// black if it carries alpha — so there is no reason to pay for an alpha channel.
function encodePNG(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline, then the raw RGB triples.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------- paint */

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const INK    = hex('#16160F');
const CREAM  = hex('#FDFBEA');
const ORANGE = hex('#F5921E');
const MID    = hex('#F04E23');
const RED    = hex('#D91E18');

// Geometry is expressed in fractions of the canvas so every size is identical
// art. The arc centre sits below the canvas centre so the lockup — arcs plus
// horizon — is optically centred rather than floating high.
//
// Everything stays inside the maskable safe zone. The farthest painted pixels
// are the horizon bar's corners at (±0.32, +0.158) from centre, i.e. 0.357 out —
// comfortably inside the 0.40 radius Android's maskable crop guarantees to keep.
const CX = 0.5, CY = 0.60;
const ARCS = [
  { inner: 0.060, outer: 0.135, colour: ORANGE },
  { inner: 0.160, outer: 0.235, colour: MID },
  { inner: 0.260, outer: 0.320, colour: RED },
];
const BASE_TOP = 0.020, BASE_BOTTOM = 0.058, BASE_HALF_WIDTH = 0.32;

// Returns the colour at a point in unit space, or null for background.
function sample(u, v) {
  const dx = u - CX, dy = v - CY;

  // Horizon line under the arcs.
  if (dy >= BASE_TOP && dy <= BASE_BOTTOM && Math.abs(dx) <= BASE_HALF_WIDTH) return CREAM;

  // Arcs are the upper half only.
  if (dy > 0) return null;
  const r = Math.hypot(dx, dy);
  for (const a of ARCS) if (r >= a.inner && r <= a.outer) return a.colour;
  return null;
}

// 4x4 supersampling. Without it the arcs alias badly at 192px, which reads as
// sloppy on a home screen.
const SS = 4;

function render(size) {
  const out = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const c = sample(u, v) || INK;
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS, i = (y * size + x) * 3;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
    }
  }
  return out;
}

for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  const png = encodePNG(size, size, render(size));
  writeFileSync(join(ROOT, name), png);
  console.log(`wrote ${name.padEnd(21)} ${size}x${size}  ${png.length} bytes`);
}
