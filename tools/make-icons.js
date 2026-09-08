/**
 * Generates the home-screen icons (PNG) with zero dependencies — Node's zlib
 * is all a PNG needs. Run once: `node tools/make-icons.js`.
 *
 * The icon is the cash-out egg on the score-plate teal, so the app tile on an
 * iPhone matches the two things the player looks at most.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function mix(a, b, t) { return a + (b - a) * t; }

/** Signed distance-ish helpers so edges are anti-aliased, not jagged. */
function coverage(d, soft) { return Math.max(0, Math.min(1, 0.5 - d / soft)); }

function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const R = size * 0.5;
  const soft = Math.max(1, size / 180);

  // Egg geometry: an ellipse whose top is narrower than its bottom.
  const eggRx = size * 0.20, eggRy = size * 0.27, eggCy = cy + size * 0.02;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;

      // Plate background with a subtle top-to-bottom shade
      let r = 47, g = 85, b = 102;
      const shadeT = y / size;
      r = mix(r + 10, r - 8, shadeT); g = mix(g + 10, g - 8, shadeT); b = mix(b + 10, b - 8, shadeT);

      // Cream ring inset from the edge (iOS masks the corners itself)
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ringOuter = R * 0.98, ringInner = R * 0.88;
      const ringCov = coverage(Math.abs(dist - (ringOuter + ringInner) / 2) - (ringOuter - ringInner) / 2, soft);
      r = mix(r, 243, ringCov); g = mix(g, 234, ringCov); b = mix(b, 216, ringCov);

      // Egg
      const ey = (y + 0.5 - eggCy) / eggRy;
      const taper = 1 - 0.18 * Math.max(0, -ey);            // narrower up top
      const ex = (x + 0.5 - cx) / (eggRx * taper);
      const eggD = (Math.sqrt(ex * ex + ey * ey) - 1) * eggRy;
      const eggCov = coverage(eggD, soft * 1.2);
      if (eggCov > 0) {
        // Warm white with a highlight up-left and a shadow down-right
        const hx = (x + 0.5 - (cx - eggRx * 0.35)) / eggRx;
        const hy = (y + 0.5 - (eggCy - eggRy * 0.40)) / eggRy;
        const hl = Math.max(0, 1 - Math.sqrt(hx * hx + hy * hy) * 0.9);
        const sh = Math.max(0, (ex * 0.6 + ey * 0.8));
        let er = mix(244, 255, hl), eg = mix(237, 255, hl), eb = mix(224, 255, hl);
        er = mix(er, 205, sh * 0.45); eg = mix(eg, 190, sh * 0.45); eb = mix(eb, 165, sh * 0.45);
        // Ink outline around the egg
        const outline = coverage(Math.abs(eggD) - soft * 2.2, soft);
        er = mix(er, 26, outline * 0.8); eg = mix(eg, 35, outline * 0.8); eb = mix(eb, 44, outline * 0.8);
        r = mix(r, er, eggCov); g = mix(g, eg, eggCov); b = mix(b, eb, eggCov);
      }

      px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b); px[i + 3] = 255;
    }
  }
  return encodePNG(size, size, px);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  fs.writeFileSync(path.join(outDir, name), renderIcon(size));
  console.log('wrote', name, size + 'x' + size);
}
