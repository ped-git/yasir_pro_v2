// Minimal PNG reader/writer for screenshot comparison: 8-bit, non-interlaced, colour type 2 or 6.
// Implemented locally so that visual checks add no dependency beyond Playwright.
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(SIGNATURE), 'Not a PNG buffer');
  let offset = 8;
  let width, height, bitDepth, colorType, interlace;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      colorType = buffer[start + 9];
      interlace = buffer[start + 12];
    } else if (type === 'IDAT') idat.push(buffer.subarray(start, start + length));
    else if (type === 'IEND') break;
    offset = start + length + 4;
  }
  assert.equal(bitDepth, 8, `Unsupported PNG bit depth ${bitDepth}`);
  assert.equal(interlace, 0, 'Interlaced PNG is not supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : assert.fail(`Unsupported PNG colour type ${colorType}`) || 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const current = data.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous ? previous[x] : 0;
      const c = previous && x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else assert.ok(filter === 0, `Unsupported PNG filter ${filter}`);
      current[x] = value & 0xff;
    }
  }
  return { width, height, channels, data };
}

export function encodePng({ width, height, channels, data }) {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])) >>> 0);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

let crcTable;
function crc32(buffer) {
  crcTable ??= (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return crc ^ -1;
}

// Reads only the IHDR header, so an identical pair still reports its dimensions.
export function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Byte-exact first, then a per-pixel measurement. No tolerance is applied.
export function comparePngs(expected, actual) {
  if (expected.equals(actual)) {
    const { width, height } = pngSize(expected);
    return { identical: true, differingPixels: 0, totalPixels: width * height, differingPercentage: 0, maxChannelDifference: 0, width, height, diffPng: null };
  }
  const a = decodePng(expected);
  const b = decodePng(actual);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      identical: false, sizeMismatch: true, differingPixels: Math.max(a.width * a.height, b.width * b.height),
      totalPixels: Math.max(a.width * a.height, b.width * b.height), differingPercentage: 100, maxChannelDifference: 255,
      widthA: a.width, heightA: a.height, widthB: b.width, heightB: b.height, diffPng: null,
    };
  }
  const stride = a.width * a.channels;
  const diff = Buffer.alloc(a.height * stride);
  let differing = 0;
  let maxChannel = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < stride; x += 1) {
      const i = y * stride + x;
      const delta = Math.abs(a.data[i] - b.data[i]);
      diff[i] = delta > 0 ? 255 : 0;
      if (delta > maxChannel) maxChannel = delta;
      if (x % a.channels === 0 && delta > 0) differing += 1;
    }
  }
  const total = a.width * a.height;
  return {
    identical: false, differingPixels: differing, totalPixels: total,
    differingPercentage: total ? (differing / total) * 100 : 0, maxChannelDifference: maxChannel,
    width: a.width, height: a.height, diffPng: encodePng({ width: a.width, height: a.height, channels: a.channels, data: diff }),
  };
}
