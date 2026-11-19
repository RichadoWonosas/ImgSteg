/* Shared by the page, its Blob worker, and the dependency-free Node tests. */
function LsbCodec() {
  'use strict';
  const layouts = ['紧凑打包', 'RGB 低位值', '通道分离', '位平面', '横向差分', '纵向差分'];
  const formats = ['raw', 'deflate-raw', 'deflate', 'gzip', 'brotli', 'zstd', 'deflate-js9', 'brotli-wasm11'];
  const local = typeof LocalCodecs === 'function' ? LocalCodecs() : null;
  let algorithmPromise;
  function supportedAlgorithms() {
    if (!algorithmPromise) algorithmPromise = (async () => {
      const result = [];
      for (let a = 1; a < formats.length; a++) {
        if (a >= 6) { if (local && await local.available(formats[a])) result.push(a); }
        else try { new CompressionStream(formats[a]); new DecompressionStream(formats[a]); result.push(a); } catch {}
      }
      return result;
    })();
    return algorithmPromise;
  }
  const HEADER = 20;
  function extract(rgba) {
    if (rgba.length % 4) throw new Error('RGBA 数据长度无效');
    const symbols = new Uint8Array(rgba.length / 4 * 3);
    for (let src = 0, dst = 0; src < rgba.length; src += 4) {
      symbols[dst++] = rgba[src] & 7; symbols[dst++] = rgba[src + 1] & 7; symbols[dst++] = rgba[src + 2] & 7;
    }
    return symbols;
  }
  function pack(symbols) {
    const out = new Uint8Array(Math.ceil(symbols.length * 3 / 8));
    let pos = 0;
    for (const value of symbols) for (let bit = 2; bit >= 0; bit--, pos++) out[pos >>> 3] |= ((value >>> bit) & 1) << (7 - (pos & 7));
    return out;
  }
  function unpack(bytes, count) {
    const out = new Uint8Array(count);
    let pos = 0;
    for (let i = 0; i < count; i++) for (let bit = 2; bit >= 0; bit--, pos++) out[i] |= ((bytes[pos >>> 3] >>> (7 - (pos & 7))) & 1) << bit;
    return out;
  }
  function transform(symbols, w, h, layout) {
    if (layout === 0) return pack(symbols);
    if (layout === 1) return symbols;
    const count = w * h;
    const out = new Uint8Array(layout === 3 ? Math.ceil(count * 9 / 8) : symbols.length);
    if (layout === 3) {
      let pos = 0;
      for (let channel = 0; channel < 3; channel++) for (let bit = 2; bit >= 0; bit--) for (let p = 0; p < count; p++, pos++) out[pos >>> 3] |= ((symbols[p * 3 + channel] >>> bit) & 1) << (7 - (pos & 7));
    } else {
      for (let p = 0; p < count; p++) for (let c = 0; c < 3; c++) {
        const i = p * 3 + c;
        if (layout === 2) out[c * count + p] = symbols[i];
        else { const neighbor = layout === 4 ? (p % w ? i - 3 : -1) : (p >= w ? i - w * 3 : -1); out[i] = (symbols[i] - (neighbor < 0 ? 0 : symbols[neighbor]) + 8) & 7; }
      }
    }
    return out;
  }
  function reverse(bytes, w, h, layout) {
    const count = w * h;
    if (layout === 0) return unpack(bytes, count * 3);
    if (layout === 1) return bytes;
    const out = new Uint8Array(count * 3);
    if (layout === 3) {
      let pos = 0;
      for (let c = 0; c < 3; c++) for (let bit = 2; bit >= 0; bit--) for (let p = 0; p < count; p++, pos++) out[p * 3 + c] |= ((bytes[pos >>> 3] >>> (7 - (pos & 7))) & 1) << bit;
    } else for (let p = 0; p < count; p++) for (let c = 0; c < 3; c++) {
      const i = p * 3 + c;
      if (layout === 2) out[i] = bytes[c * count + p];
      else { const neighbor = layout === 4 ? (p % w ? i - 3 : -1) : (p >= w ? i - w * 3 : -1); out[i] = (bytes[i] + (neighbor < 0 ? 0 : out[neighbor])) & 7; }
    }
    return out;
  }
  // CRC-32 of the canonical packed bits, including zero padding.
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  function crc(bytes) { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  async function stream(bytes, format, decode = false, limit = Infinity) {
    if (format === 'deflate-js9' || format === 'brotli-wasm11') {
      if (!local) throw new Error('此分块需要新版 ImgSteg 内置编解码库');
      return local.run(bytes, format, decode, limit);
    }
    let codec;
    try { codec = decode ? new DecompressionStream(format) : new CompressionStream(format); }
    catch (error) {
      if (local && format === 'brotli') return local.run(bytes, 'brotli-wasm11', decode, limit);
      if (local && format === 'deflate-raw') return local.run(bytes, 'deflate-js9', decode, limit);
      throw error;
    }
    const reader = new Blob([bytes]).stream().pipeThrough(codec).getReader();
    const chunks = []; let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > limit) { await reader.cancel(); throw new Error('解压数据超过预期长度'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const out = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }
  function container(payload, w, h, layout, algorithm, checksum) {
    const out = new Uint8Array(HEADER + payload.length), view = new DataView(out.buffer);
    out.set([76, 51, 66, 49, layout, algorithm, 0, 0]);
    view.setUint32(8, w); view.setUint32(12, h); view.setUint32(16, checksum); out.set(payload, HEADER);
    return out;
  }
  async function decode(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < HEADER || bytes[0] !== 76 || bytes[1] !== 51 || bytes[2] !== 66 || bytes[3] !== 49 || bytes[4] >= layouts.length || bytes[5] >= formats.length || bytes[6] || bytes[7]) throw new Error('无效的 L3B1 文件头');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), w = view.getUint32(8), h = view.getUint32(12);
    if (!w || !h || w * h > 40000000) throw new Error('图片尺寸无效或超过 4000 万像素的内存保护上限');
    const layout = bytes[4], algorithm = bytes[5];
    const expected = layout === 0 || layout === 3 ? Math.ceil(w * h * 9 / 8) : w * h * 3;
    const payload = algorithm ? await stream(bytes.subarray(HEADER), formats[algorithm], true, expected) : bytes.subarray(HEADER);
    if (payload.length !== expected || (!algorithm && layout !== 0)) throw new Error('低位数据长度或编码无效');
    if (layout !== 0 && layout !== 3 && payload.some(v => v > 7)) throw new Error('低位值超出范围');
    const symbols = reverse(payload, w, h, layout), packed = pack(symbols);
    if (crc(packed) !== view.getUint32(16)) throw new Error('低位数据校验失败');
    return { w, h, symbols, packed, bitLength: w * h * 9 };
  }
  async function encode(symbols, w, h, report = () => {}) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w * h > 40000000 || symbols.length !== w * h * 3 || symbols.some(v => v > 7)) throw new Error('低位数据或尺寸无效');
    const packed = pack(symbols), checksum = crc(packed);
    let best = container(packed, w, h, 0, 0, checksum), bestLayout = 0, bestAlgo = 0;
    const supported = await supportedAlgorithms();
    if (!supported.length) throw new Error('此浏览器不支持原生压缩，请使用新版 Chrome、Edge、Firefox 或 Safari');
    let done = 0, tried = 0;
    for (let l = 0; l < layouts.length; l++) {
      const data = transform(symbols, w, h, l);
      for (const a of supported) {
        if (a === 7 && data.length > 8 * 1024 * 1024) { done++; continue; }
        report({ progress: Math.round(15 + done / (layouts.length * supported.length) * 70), message: `正在比较 ${layouts[l]} / ${formats[a]}…` });
        const payload = await stream(data, formats[a]); tried++;
        if (payload.length + HEADER < best.length) { best = container(payload, w, h, l, a, checksum); bestLayout = l; bestAlgo = a; }
        done++;
      }
    }
    report({ progress: 90, message: '正在解压并逐字节验证低位数据…' });
    const restored = await decode(best);
    if (restored.packed.length !== packed.length || !packed.every((v, i) => v === restored.packed[i])) throw new Error('往返验证失败');
    return { bytes: best, method: `${layouts[bestLayout]} / ${bestAlgo ? formats[bestAlgo] : '原样存储'}`, candidates: tried + 1, algorithms: supported.map(a => formats[a]) };
  }
  function metrics(w, h, byteLength) {
    const original = 9n * BigInt(w) * BigInt(h), n = BigInt(byteLength) * 8n, r = original - n, b = r >> 3n;
    const pixels = b >= 0n ? b / 3n : (b - 2n) / 3n;
    return { original, n, r, b, pixels };
  }
  function rawSizes(pixelCapacity) {
    const capacity = BigInt(pixelCapacity) > 0n ? BigInt(pixelCapacity) : 0n;
    return [[1n, 1n], [4n, 3n], [16n, 9n]].map(([a, b]) => {
      const limit = capacity / (a * b);
      // Integer square root: exact even beyond Number.MAX_SAFE_INTEGER.
      let low = 0n, high = limit + 1n;
      while (high - low > 1n) {
        const middle = (low + high) / 2n;
        if (middle * middle <= limit) low = middle; else high = middle;
      }
      const width = a * low, height = b * low;
      return { ratio: `${a}:${b}`, width, height, pixels: width * height };
    });
  }
  return { encode, decode, metrics, rawSizes, extract, pack, unpack, transform, reverse, layouts, formats, crc, stream, supportedAlgorithms };
}
if (typeof module !== 'undefined') module.exports = LsbCodec;
