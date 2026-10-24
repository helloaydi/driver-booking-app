// Draws the app icon as PNGs (no image libraries needed). Run: node scripts/make-icons.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';

function png(size) {
  const s = size / 512;
  const teal = [15, 118, 110], white = [255, 255, 255];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / s, py = (y + 0.5) / s;
      const d = Math.hypot(px - 256, py - 256);
      const ring = Math.abs(d - 150) < 20;
      const hub = d < 34;
      const bar = Math.abs(py - 230) < 20 && px > 98 && px < 414 && d < 170;
      const stem = Math.abs(px - 256) < 20 && py > 270 && py < 428 && d < 170;
      const c = ring || hub || bar || stem ? white : teal;
      raw.set([...c, 255], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) fs.writeFileSync(`web/public/icon-${size}.png`, png(size));
