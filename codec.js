/* Shared by the page, its Blob worker, and the dependency-free Node tests. */
function LsbCodec() {
  'use strict';
  const layouts = ['紧凑打包', 'RGB 低位值', '通道分离', '位平面', '横向差分', '纵向差分', '默认值稀疏', '横向残差稀疏', '纵向残差稀疏'];
  const formats = ['raw', 'deflate-raw', 'deflate', 'gzip', 'brotli', 'zstd', 'deflate-js9', 'brotli-wasm5', 'lzma2-xz3'];
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
  // Sparse packets: three channel defaults, reserved zero, uint32 count,
  // an MSB-first per-channel mask, then tightly packed 3-bit exceptions.
  function sparsePack(symbols, w, h, layout) {
    const values = layout === 6 ? symbols : transform(symbols, w, h, layout === 7 ? 4 : 5), defaults = new Uint8Array(3);
    if (layout === 6) {
      const counts = new Uint32Array(24);
      for (let i = 0; i < values.length; i++) counts[(i % 3) * 8 + values[i]]++;
      for (let c = 0; c < 3; c++) for (let v = 1; v < 8; v++) if (counts[c * 8 + v] > counts[c * 8 + defaults[c]]) defaults[c] = v;
    }
    let count = 0;
    for (let i = 0; i < values.length; i++) if (values[i] !== defaults[i % 3]) count++;
    const maskLength = Math.ceil(values.length / 8), bytes = new Uint8Array(8 + maskLength + Math.ceil(count * 3 / 8));
    bytes.set(defaults); new DataView(bytes.buffer).setUint32(4, count); let bit = (8 + maskLength) * 8;
    for (let i = 0; i < values.length; i++) if (values[i] !== defaults[i % 3]) {
      bytes[8 + (i >>> 3)] |= 1 << (7 - (i & 7));
      for (let b = 2; b >= 0; b--, bit++) bytes[bit >>> 3] |= ((values[i] >>> b) & 1) << (7 - (bit & 7));
    }
    return bytes;
  }
  function sparseUnpack(bytes, w, h, layout) {
    const n = w * h * 3, maskLength = Math.ceil(n / 8);
    if (bytes.length < 8 + maskLength || bytes[3] || bytes.subarray(0, 3).some(v => v > 7) || layout !== 6 && bytes.subarray(0, 3).some(v => v !== 0)) throw new Error('低位稀疏头无效');
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
    if (count > n || bytes.length !== 8 + maskLength + Math.ceil(count * 3 / 8)) throw new Error('低位稀疏计数或长度无效');
    if (n % 8 && bytes[8 + maskLength - 1] & ((1 << (8 - n % 8)) - 1) || count * 3 % 8 && bytes[bytes.length - 1] & ((1 << (8 - count * 3 % 8)) - 1)) throw new Error('低位稀疏填充无效');
    const values = new Uint8Array(n); let bit = (8 + maskLength) * 8, actual = 0;
    for (let i = 0; i < n; i++) {
      values[i] = bytes[i % 3];
      if (bytes[8 + (i >>> 3)] & (1 << (7 - (i & 7)))) {
        if (++actual > count) throw new Error('低位稀疏掩码计数无效');
        let v = 0; for (let b = 0; b < 3; b++, bit++) v = (v << 1) | ((bytes[bit >>> 3] >>> (7 - (bit & 7))) & 1);
        if (v === values[i]) throw new Error('低位稀疏例外无变化'); values[i] = v;
      }
    }
    if (actual !== count) throw new Error('低位稀疏掩码计数无效');
    return layout === 6 ? values : reverse(values, w, h, layout === 7 ? 4 : 5);
  }
  function transform(symbols, w, h, layout) {
    if (layout >= 6) return sparsePack(symbols, w, h, layout);
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
    if (layout >= 6) return sparseUnpack(bytes, w, h, layout);
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
    if (format === 'deflate-js9' || format === 'brotli-wasm5' || format === 'brotli-wasm11' || format === 'lzma2-xz3') {
      if (!local) throw new Error('此分块需要新版 ImgSteg 内置编解码库');
      return local.run(bytes, format, decode, limit);
    }
    let codec;
    try { codec = decode ? new DecompressionStream(format) : new CompressionStream(format); }
    catch (error) {
      if (local && format === 'brotli') return local.run(bytes, 'brotli-wasm5', decode, limit);
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
    const expected = layout >= 6 ? 8 + Math.ceil(w * h * 3 / 8) + Math.ceil(w * h * 9 / 8) : layout === 0 || layout === 3 ? Math.ceil(w * h * 9 / 8) : w * h * 3;
    const payload = algorithm ? await stream(bytes.subarray(HEADER), formats[algorithm], true, expected) : bytes.subarray(HEADER);
    if ((layout < 6 && payload.length !== expected) || payload.length > expected || (!algorithm && layout !== 0 && layout < 6)) throw new Error('低位数据长度或编码无效');
    if (layout > 0 && layout < 6 && layout !== 3 && payload.some(v => v > 7)) throw new Error('低位值超出范围');
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
    let done = 0, tried = 0, legacy;
    for (let l = 0; l < layouts.length; l++) {
      if (l === 6) legacy = { bytes: best, method: `${layouts[bestLayout]} / ${bestAlgo ? formats[bestAlgo] : '原样存储'}` };
      const data = transform(symbols, w, h, l);
      if (l >= 6) {
        // Dense exception masks are unlikely to help; retain all original layouts.
        if (data.length >= packed.length) { done += supported.length; continue; }
        tried++;
        if (data.length + HEADER < best.length) { best = container(data, w, h, l, 0, checksum); bestLayout = l; bestAlgo = 0; }
      }
      for (const a of supported) {
        if ((a === 7 || a === 8) && data.length > 8 * 1024 * 1024 || a === 8 && best.length <= HEADER + 32) { done++; continue; }
        report({ progress: Math.round(15 + done / (layouts.length * supported.length) * 70), message: `正在比较 ${layouts[l]} / ${formats[a]}…` });
        const payload = await stream(data, formats[a]); tried++;
        if (payload.length + HEADER < best.length) { best = container(payload, w, h, l, a, checksum); bestLayout = l; bestAlgo = a; }
        done++;
      }
    }
    report({ progress: 90, message: '正在解压并逐字节验证低位数据…' });
    const restored = await decode(best);
    if (restored.packed.length !== packed.length || !packed.every((v, i) => v === restored.packed[i])) throw new Error('往返验证失败');
    return { bytes: best, method: `${layouts[bestLayout]} / ${bestAlgo ? formats[bestAlgo] : '原样存储'}`, legacy, candidates: tried + 1, algorithms: supported.map(a => formats[a]) };
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
