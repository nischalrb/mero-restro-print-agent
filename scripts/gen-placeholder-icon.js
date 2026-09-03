// One-off generator for a PLACEHOLDER app icon (build/icon.png) — no
// external dependencies (no sharp/canvas/etc.), just Node's built-in zlib,
// so this runs anywhere `node` runs, including a sandbox with no npm
// registry access. Produces a simple, recognizable-enough 1024x1024 PNG
// (orange rounded square, white "receipt" shape with a few text-line bars)
// so electron-builder has something valid to derive .icns/.ico from.
//
// THIS IS NOT FINAL BRANDING. Replace build/icon.png with real Mero Restro
// artwork (a proper 1024x1024 PNG, ideally designed by hand/a designer)
// before shipping an installer to actual customers — see DEPLOYMENT.md.
//
// Run with: node scripts/gen-placeholder-icon.js
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 1024;

// ── Minimal CRC32 (PNG chunk checksums) ──────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── Pixel drawing (plain RGBA buffer, no drawing library) ────────────
const ORANGE = [249, 115, 22]; // tailwind orange-500 — matches the app's existing brand accent
const WHITE = [255, 255, 255];
const DARK = [124, 45, 4]; // orange-900-ish, for the "text line" bars

const pixels = Buffer.alloc(SIZE * SIZE * 4);

function setPixel(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
  pixels[i + 3] = a;
}

const CORNER_RADIUS = 180;

function insideRoundedSquare(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// Background: rounded square, orange, transparent outside the rounding.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (insideRoundedSquare(x, y, SIZE, CORNER_RADIUS)) {
      setPixel(x, y, ORANGE);
    } else {
      setPixel(x, y, ORANGE, 0);
    }
  }
}

// Foreground: a simple white "receipt" rounded rectangle, centered, plus a
// few dark horizontal bars suggesting printed text lines — recognizable at
// a glance as "this is the printer/receipt thing" even at tray-icon size.
const receipt = { x: 300, y: 220, w: 424, h: 584, r: 40 };
for (let y = receipt.y; y < receipt.y + receipt.h; y++) {
  for (let x = receipt.x; x < receipt.x + receipt.w; x++) {
    if (insideRoundedSquare(x - receipt.x, y - receipt.y, Math.max(receipt.w, receipt.h), receipt.r) || (x - receipt.x < receipt.w && y - receipt.y < receipt.h)) {
      // Rounded corners only need to matter near the actual corners; for
      // the bulk of the rectangle this just fills it solid white.
      const nearLeftEdge = x - receipt.x < receipt.r;
      const nearRightEdge = receipt.x + receipt.w - x < receipt.r;
      const nearTopEdge = y - receipt.y < receipt.r;
      const nearBottomEdge = receipt.y + receipt.h - y < receipt.r;
      if ((nearLeftEdge || nearRightEdge) && (nearTopEdge || nearBottomEdge)) {
        const cx = nearLeftEdge ? receipt.x + receipt.r : receipt.x + receipt.w - receipt.r;
        const cy = nearTopEdge ? receipt.y + receipt.r : receipt.y + receipt.h - receipt.r;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > receipt.r * receipt.r) continue;
      }
      setPixel(x, y, WHITE);
    }
  }
}

// Text-line bars.
const barLeft = receipt.x + 70;
const barRight = receipt.x + receipt.w - 70;
const barHeight = 26;
const barGap = 56;
let barY = receipt.y + 110;
const barWidths = [1, 1, 0.7, 1, 1, 0.55]; // last bar per "paragraph" a bit shorter, like real receipt lines
for (const widthFraction of barWidths) {
  const right = barLeft + Math.round((barRight - barLeft) * widthFraction);
  for (let y = barY; y < barY + barHeight; y++) {
    for (let x = barLeft; x < right; x++) {
      setPixel(x, y, DARK);
    }
  }
  barY += barGap;
}

// ── Assemble the PNG file ─────────────────────────────────────────────
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.writeUInt8(8, 8); // bit depth
ihdr.writeUInt8(6, 9); // color type 6 = RGBA
ihdr.writeUInt8(0, 10); // compression
ihdr.writeUInt8(0, 11); // filter
ihdr.writeUInt8(0, 12); // interlace

// Each scanline needs a leading filter-type byte (0 = "None").
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idatData = zlib.deflateSync(raw, { level: 9 });

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idatData), chunk("IEND", Buffer.alloc(0))]);

const outDir = path.join(__dirname, "..", "build");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "icon.png");
fs.writeFileSync(outPath, png);
// eslint-disable-next-line no-console
console.log(`Wrote placeholder icon: ${outPath} (${png.length} bytes)`);
