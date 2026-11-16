/* Minimal lossless 8-bit RGB/RGBA PNG IO. No Canvas premultiplication on round trip. */
function PngCodec() {
  const low = LsbCodec(), signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = b => String.fromCharCode(...b);
  function chunk(type, data) {
    const out = new Uint8Array(data.length + 12), v = view(out);
    v.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8); v.setUint32(data.length + 8, low.crc(out.subarray(4, data.length + 8))); return out;
  }
  function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }
  async function encode(rgba, w, h) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > 40000000 || rgba.length !== w * h * 4) throw new Error('PNG 像素尺寸无效');
    const stride = w * 4, raw = new Uint8Array((stride + 1) * h);
    // PNG Sub filter preserves every byte and compresses flat/pixelated areas well.
    for (let y = 0; y < h; y++) {
      const row = y * (stride + 1); raw[row] = 1;
      for (let x = 0; x < stride; x++) raw[row + 1 + x] = (rgba[y * stride + x] - (x >= 4 ? rgba[y * stride + x - 4] : 0) + 256) & 255;
    }
    const ihdr = new Uint8Array(13); view(ihdr).setUint32(0, w); view(ihdr).setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
    const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', await low.stream(raw, 'deflate')), chunk('IEND', new Uint8Array())];
    return new Blob(parts, { type: 'image/png' });
  }
  async function decode(bytes) {
    if (bytes.length < 8 || !signature.every((v, i) => bytes[i] === v)) return null;
    let offset = 8, w, h, channels, ended = false; const idat = [];
    while (offset < bytes.length) {
      if (bytes.length - offset < 12) throw new Error('PNG 分块被截断');
      const length = view(bytes).getUint32(offset);
      if (length > bytes.length - offset - 12) throw new Error('PNG 分块长度无效');
      const type = ascii(bytes.subarray(offset + 4, offset + 8)), data = bytes.subarray(offset + 8, offset + 8 + length);
      if (low.crc(bytes.subarray(offset + 4, offset + 8 + length)) !== view(bytes).getUint32(offset + 8 + length)) throw new Error('PNG CRC 校验失败');
      if (offset === 8 && type !== 'IHDR') throw new Error('PNG 缺少 IHDR');
      if (type === 'IHDR') {
        if (length !== 13 || w !== undefined) throw new Error('PNG IHDR 无效');
        w = view(data).getUint32(0); h = view(data).getUint32(4);
        if (!w || !h || w * h > 40000000) throw new Error('PNG 尺寸超出上限');
        // Other bit depths, palette, grayscale and Adam7 use browser decoding.
        if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) return null;
        channels = data[9] === 6 ? 4 : 3;
      } else if (type === 'tRNS') return null; // RGB transparency needs browser expansion to RGBA.
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') { if (length) throw new Error('PNG IEND 无效'); ended = true; break; }
      else if ((bytes[offset + 4] & 32) === 0) return null;
      offset += length + 12;
    }
    if (!ended || !channels || !idat.length) throw new Error('PNG 文件不完整');
    const stride = w * channels, expected = (stride + 1) * h;
    const data = new Uint8Array(await new Blob(idat).arrayBuffer());
    const raw = await low.stream(data, 'deflate', true, expected);
    if (raw.length !== expected) throw new Error('PNG 解压长度无效');
    const pixels = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {
      const type = raw[y * (stride + 1)];
      if (type > 4) throw new Error('PNG 滤波类型无效');
      for (let x = 0; x < stride; x++) {
        const i = y * stride + x, left = x >= channels ? pixels[i - channels] : 0, up = y ? pixels[i - stride] : 0, corner = y && x >= channels ? pixels[i - stride - channels] : 0;
        const predicted = type === 0 ? 0 : type === 1 ? left : type === 2 ? up : type === 3 ? Math.floor((left + up) / 2) : paeth(left, up, corner);
        pixels[i] = (raw[y * (stride + 1) + x + 1] + predicted) & 255;
      }
    }
    if (channels === 4) return { rgba: pixels, w, h };
    const rgba = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) { rgba.set(pixels.subarray(p * 3, p * 3 + 3), p * 4); rgba[p * 4 + 3] = 255; }
    return { rgba, w, h };
  }
  return { encode, decode };
}
if (typeof module !== 'undefined') module.exports = PngCodec;
