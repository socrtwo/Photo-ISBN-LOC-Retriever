// Generate the app icons (a row of book spines) as PNGs with no dependencies —
// raw RGBA pixels, zlib-compressed into a valid PNG by hand.
// Run: node scripts/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- draw the icon: warm background, five book spines of varying height ---
const SPINES = [
  { x0: 0.10, x1: 0.24, top: 0.16, color: [140, 63, 47] },   // brick red
  { x0: 0.26, x1: 0.38, top: 0.22, color: [46, 87, 122] },   // steel blue
  { x0: 0.40, x1: 0.56, top: 0.12, color: [122, 77, 31] },   // leather brown
  { x0: 0.58, x1: 0.72, top: 0.26, color: [58, 104, 58] },   // forest green
  { x0: 0.74, x1: 0.90, top: 0.18, color: [163, 128, 46] },  // mustard
];
const BG = [250, 246, 240];
const SHELF = [92, 58, 21];

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const shelfTop = 0.86;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x / size, fy = y / size;
      let c = BG, a = 255;
      if (fy >= shelfTop && fy < shelfTop + 0.06) c = SHELF;
      else {
        for (const s of SPINES) {
          if (fx >= s.x0 && fx < s.x1 && fy >= s.top && fy < shelfTop) {
            c = s.color;
            // light left edge + a pale title band across the spine
            if (fx - s.x0 < 0.015) c = c.map((v) => Math.min(255, v + 55));
            const bandY = s.top + (shelfTop - s.top) * 0.28;
            if (Math.abs(fy - bandY) < 0.02) c = [244, 238, 222];
            break;
          }
        }
      }
      const o = (y * size + x) * 4;
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = a;
    }
  }
  return png(size, size, rgba);
}

mkdirSync(new URL("../app/icons/", import.meta.url), { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(
    new URL(`../app/icons/icon-${size}.png`, import.meta.url),
    drawIcon(size)
  );
  console.log(`wrote app/icons/icon-${size}.png`);
}
