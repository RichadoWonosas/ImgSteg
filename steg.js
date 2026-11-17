/* ImgSteg v1/v2: restoration data, optional image files, UTF-8 text last. */
function ImgSteg() {
  'use strict';
  const low = LsbCodec(), MAGIC = [73, 77, 71, 83, 84, 69, 71, 49], HEADER = 48;
  const MAX_PIXELS = 40000000, MAX_REGIONS = 64, MAX_TEXT = 4 * 1024 * 1024;
  const MAX_ATTACHMENTS = 32, MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
  const diffCodec = typeof DiffCodec === 'function' ? DiffCodec() : null;
  const compressedCache = new Map(); let cachedOriginal, cachedCRC, compressedBytes = 0, cacheHits = 0;
  async function remembered(key, producer) {
    if (compressedCache.has(key)) { cacheHits++; return compressedCache.get(key); }
    const result = await producer(); compressedCache.set(key, result); compressedBytes += result.bytes.length;
    while (compressedCache.size > 48 || (compressedBytes > 32 * 1024 * 1024 && compressedCache.size > 1)) { const first = compressedCache.keys().next().value; compressedBytes -= compressedCache.get(first).bytes.length; compressedCache.delete(first); }
    return result;
  }
  const modes = ['mosaic', 'white', 'black'];
  const byteLayouts = ['逐像素', '通道分离', '横向差分', '纵向差分', '位平面'];
  const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  function validateAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) throw new Error('最多附加 32 张图片');
    let total = 0;
    for (const item of attachments) {
      dimensions(item.w, item.h);
      if (!(item.data instanceof Uint8Array) || !item.data.length) throw new Error('附加图片文件内容无效');
      total += item.data.length;
      if (total > MAX_ATTACHMENT_BYTES) throw new Error('附加图片原文件总大小最多为 32 MiB');
      if (typeof item.name !== 'string' || !item.name.length || new TextEncoder().encode(item.name).length > 1024 || typeof item.type !== 'string' || !/^image\/[a-zA-Z0-9.+-]+$/.test(item.type) || new TextEncoder().encode(item.type).length > 128) throw new Error('附加图片文件名或类型无效');
    }
  }
  function sameAttachments(a, b) {
    return a.length === b.length && a.every((item, i) => item.name === b[i].name && item.type === b[i].type && item.w === b[i].w && item.h === b[i].h && equal(item.data, b[i].data));
  }
  function dimensions(w, h) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > MAX_PIXELS) throw new Error('图片尺寸无效，最多支持 4000 万像素');
  }
  function validateRegions(regions, w, h) {
    if (!Array.isArray(regions) || regions.length > MAX_REGIONS) throw new Error('最多支持 64 个选区');
    let area = 0;
    for (const r of regions) {
      if (![r.x, r.y, r.w, r.h].every(Number.isInteger) || r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > w || r.y + r.h > h || !modes.includes(r.mode)) throw new Error('选区坐标或填充方式无效');
      area += r.w * r.h;
      if (area > MAX_PIXELS) throw new Error('所有选区累计面积最多为 4000 万像素（重叠区域重复计数）');
    }
  }
  function crop(rgba, w, r) {
    const out = new Uint8Array(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) out.set(rgba.subarray(((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4), y * r.w * 4);
    return out;
  }
  function paste(target, w, r, data) {
    for (let y = 0; y < r.h; y++) target.set(data.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((r.y + y) * w + r.x) * 4);
  }
  function fill(target, w, r, blockSize = 12) {
    if (r.mode !== 'mosaic') {
      const v = r.mode === 'white' ? 255 : 0;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const i = (y * w + x) * 4; target[i] = target[i + 1] = target[i + 2] = v; target[i + 3] = 255; }
      return;
    }
    for (let by = r.y; by < r.y + r.h; by += blockSize) for (let bx = r.x; bx < r.x + r.w; bx += blockSize) {
      const endY = Math.min(by + blockSize, r.y + r.h), endX = Math.min(bx + blockSize, r.x + r.w);
      let red = 0, green = 0, blue = 0;
      for (let y = by; y < endY; y++) for (let x = bx; x < endX; x++) { const i = (y * w + x) * 4; red += target[i]; green += target[i + 1]; blue += target[i + 2]; }
      const count = (endY - by) * (endX - bx); red = Math.round(red / count); green = Math.round(green / count); blue = Math.round(blue / count);
      for (let y = by; y < endY; y++) for (let x = bx; x < endX; x++) { const i = (y * w + x) * 4; target[i] = red; target[i + 1] = green; target[i + 2] = blue; target[i + 3] = 255; }
    }
  }
  function makeBase(original, w, h, regions, blockSize = 12) {
    dimensions(w, h); validateRegions(regions, w, h);
    if (original.length !== w * h * 4 || !Number.isInteger(blockSize) || blockSize < 2 || blockSize > 128) throw new Error('像素数据或马赛克块大小无效');
    const base = new Uint8Array(original);
    for (const region of regions) fill(base, w, region, blockSize);
    return base;
  }
  function byteTransform(data, w, h, channels, layout, inverse = false) {
    if (layout === 0) return data;
    const out = new Uint8Array(data.length), count = w * h;
    if (layout === 4) {
      let bitPos = 0;
      for (let c = 0; c < channels; c++) for (let bit = 7; bit >= 0; bit--) for (let p = 0; p < count; p++, bitPos++) {
        if (inverse) out[p * channels + c] |= ((data[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1) << bit;
        else out[bitPos >>> 3] |= ((data[p * channels + c] >>> bit) & 1) << (7 - (bitPos & 7));
      }
      return out;
    }
    for (let p = 0; p < count; p++) for (let c = 0; c < channels; c++) {
      const i = p * channels + c;
      if (layout === 1) { if (inverse) out[i] = data[c * count + p]; else out[c * count + p] = data[i]; }
      else {
        const neighbor = layout === 2 ? (p % w ? i - channels : -1) : (p >= w ? i - w * channels : -1);
        const source = inverse ? out : data, predicted = neighbor < 0 ? 0 : source[neighbor];
        out[i] = (data[i] + (inverse ? predicted : -predicted) + 256) & 255;
      }
    }
    return out;
  }
  function byteContainer(data, w, h, channels, layout, algorithm, crc) {
    const out = new Uint8Array(20 + data.length), v = viewOf(out);
    out.set([66, 56, 67, 49]); v.setUint32(4, w); v.setUint32(8, h);
    out.set([channels, layout, algorithm, 0], 12); v.setUint32(16, crc); out.set(data, 20); return out;
  }
  async function encodeBytes(data, w, h, channels, report = () => {}) {
    dimensions(w, h);
    if (![1, 3, 4].includes(channels) || data.length !== w * h * channels) throw new Error('全比特数据长度无效');
    const crc = low.crc(data);
    let best = byteContainer(data, w, h, channels, 0, 0, crc), method = '逐像素 / 原样存储';
    const algorithms = [];
    for (let a = 1; a < low.formats.length; a++) try { new CompressionStream(low.formats[a]); new DecompressionStream(low.formats[a]); algorithms.push(a); } catch { /* unavailable */ }
    let done = 0;
    for (let layout = 0; layout < byteLayouts.length; layout++) {
      const transformed = byteTransform(data, w, h, channels, layout);
      for (const a of algorithms) {
        report({ progress: 100 * done++ / (byteLayouts.length * algorithms.length), message: `${byteLayouts[layout]} / ${low.formats[a]}` });
        const compressed = await low.stream(transformed, low.formats[a]);
        if (compressed.length + 20 < best.length) { best = byteContainer(compressed, w, h, channels, layout, a, crc); method = `${byteLayouts[layout]} / ${low.formats[a]}`; }
      }
    }
    const decoded = await decodeBytes(best);
    if (!equal(decoded.data, data)) throw new Error('全比特压缩往返验证失败');
    return { bytes: best, method };
  }
  async function decodeBytes(bytes) {
    if (bytes.length < 20 || !equal(bytes.subarray(0, 4), new Uint8Array([66, 56, 67, 49]))) throw new Error('全比特压缩块文件头无效');
    const v = viewOf(bytes), w = v.getUint32(4), h = v.getUint32(8), channels = bytes[12], layout = bytes[13], algorithm = bytes[14];
    dimensions(w, h);
    if (![1, 3, 4].includes(channels) || layout >= byteLayouts.length || algorithm >= low.formats.length || bytes[15] || (!algorithm && layout !== 0)) throw new Error('全比特压缩块编码无效');
    const expected = w * h * channels;
    const payload = algorithm ? await low.stream(bytes.subarray(20), low.formats[algorithm], true, expected) : bytes.subarray(20);
    if (payload.length !== expected) throw new Error('全比特解压长度错误');
    const data = byteTransform(payload, w, h, channels, layout, true);
    if (low.crc(data) !== v.getUint32(16)) throw new Error('全比特数据校验失败');
    return { data, w, h, channels };
  }
  // Only the first requested bytes are read. No full-capacity allocation for detection.
  function readCarrier(rgba, byteLength) {
    if (byteLength * 8 > rgba.length / 4 * 9) throw new Error('隐写长度超出图片低位容量');
    const bytes = new Uint8Array(byteLength); let pos = 0;
    for (let i = 0; i < rgba.length && pos < byteLength * 8; i++) {
      if ((i & 3) === 3) continue;
      for (let bit = 2; bit >= 0 && pos < byteLength * 8; bit--, pos++) bytes[pos >>> 3] |= ((rgba[i] >>> bit) & 1) << (7 - (pos & 7));
    }
    return bytes;
  }
  function embed(base, bytes) {
    if (bytes.length * 8 > base.length / 4 * 9) throw new Error('隐写内容超过 9wh，无法写入');
    const carrier = new Uint8Array(base); let pos = 0;
    for (let i = 0; i < carrier.length; i++) {
      if ((i & 3) === 3) { carrier[i] = 255; continue; }
      let value = 0;
      for (let bit = 2; bit >= 0; bit--, pos++) if (pos < bytes.length * 8) value |= ((bytes[pos >>> 3] >>> (7 - (pos & 7))) & 1) << bit;
      carrier[i] = (carrier[i] & 248) | value;
    }
    return carrier;
  }
  function probe(rgba, w, h) {
    dimensions(w, h);
    if (rgba.length !== w * h * 4) throw new Error('载体像素长度无效');
    if (w * h * 9 < HEADER * 8) return { detected: false };
    const bytes = readCarrier(rgba, HEADER), v = viewOf(bytes);
    if (!equal(bytes.subarray(0, 7), new Uint8Array(MAGIC.slice(0, 7))) || ![49, 50, 51].includes(bytes[7])) return { detected: false };
    const version = bytes[7] - 48, header = version === 3 ? 64 : version === 2 ? 56 : HEADER;
    const length = v.getUint32(8), count = v.getUint32(20);
    if (length < header || length * 8 > w * h * 9 || v.getUint32(12) !== w || v.getUint32(16) !== h || count > MAX_REGIONS || v.getUint32(44) > MAX_TEXT + 20) throw new Error('发现 ImgSteg 标记，但文件头损坏或尺寸已改变');
    let attachmentCount = 0, attachmentLength = 0;
    let diffCount = 0, diffLength = 0;
    if (version >= 2) {
      const extra = viewOf(readCarrier(rgba, header)); attachmentCount = extra.getUint32(48); attachmentLength = extra.getUint32(52);
      if (attachmentCount > MAX_ATTACHMENTS || attachmentLength > length - header || (attachmentCount === 0) !== (attachmentLength === 0)) throw new Error('附加图片计数或长度无效');
      if (version === 3) { diffCount = extra.getUint32(56); diffLength = extra.getUint32(60); if (!diffCount || diffCount > 16 || diffCount * w * h > MAX_PIXELS || diffLength < 20 || diffLength > length - header) throw new Error('差分图区段长度或数量无效'); }
    }
    return { detected: true, length, count, version, header, attachmentCount, attachmentLength, diffCount, diffLength };
  }
  async function build(original, w, h, regions, text = '', blockSize = 12, report = () => {}, attachments = [], differences = []) {
    validateAttachments(attachments);
    if (differences.length && !diffCodec) throw new Error('当前环境未加载差分图解码器');
    const originalCRC = low.crc(original);
    if (cachedOriginal !== original || cachedCRC !== originalCRC) { compressedCache.clear(); compressedBytes = 0; cachedOriginal = original; cachedCRC = originalCRC; }
    cacheHits = 0;
    const header = differences.length ? 64 : attachments.length ? 56 : HEADER;
    const baseKey = `${w},${h},${blockSize}:` + JSON.stringify(regions);
    const base = makeBase(original, w, h, regions, blockSize);
    const textData = new TextEncoder().encode(text);
    if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(textData) !== text) throw new Error('附加文字包含无效的 Unicode 字符，请修改后重试');
    if (textData.length > MAX_TEXT) throw new Error('附加文字 UTF-8 长度最多为 4 MiB');
    const parts = [], methods = [];
    const stage = (index, label) => update => report({ progress: 5 + 80 * (index + update.progress / 100) / (regions.length + attachments.length + (differences.length ? 1 : 0) + 3), message: `${label}：${update.message}` });
    const lsb = await remembered(`low:${baseKey}`, () => low.encode(low.extract(base), w, h, stage(0, '压缩 i2 的低 3 位')));
    parts.push(lsb.bytes); methods.push({ label: 'i2 LSB3', method: lsb.method, bytes: lsb.bytes.length });
    let alpha = new Uint8Array(w * h); let opaque = true;
    for (let p = 0; p < alpha.length; p++) { alpha[p] = base[p * 4 + 3]; if (alpha[p] !== 255) opaque = false; }
    let alphaLength = 0;
    if (!opaque) {
      const block = await remembered(`alpha:${baseKey}`, () => encodeBytes(alpha, w, h, 1, stage(1, '压缩透明通道')));
      parts.push(block.bytes); alphaLength = block.bytes.length; methods.push({ label: 'i2 Alpha', method: block.method, bytes: alphaLength });
    }
    alpha = null;
    for (let index = 0; index < regions.length; index++) {
      const r = regions[index], data = crop(original, w, r);
      const block = await remembered(`region:${r.x},${r.y},${r.w},${r.h}`, () => encodeBytes(data, r.w, r.h, 4, stage(index + 2, `压缩选区 ${index + 1} 的完整 RGBA`)));
      const record = new Uint8Array(24), v = viewOf(record);
      v.setUint32(0, r.x); v.setUint32(4, r.y); v.setUint32(8, r.w); v.setUint32(12, r.h); record[16] = modes.indexOf(r.mode); v.setUint32(20, block.bytes.length);
      parts.push(record, block.bytes); methods.push({ label: `选区 ${index + 1}`, method: block.method, bytes: block.bytes.length });
    }
    let diffLength = 0;
    if (differences.length) {
      const block = await diffCodec.encode(differences, regions.length ? base : original, w, h, encodeBytes, stage(regions.length + 2, '压缩差分图'));
      parts.push(block.bytes); diffLength = block.bytes.length; methods.push(...block.methods);
    }
    let attachmentLength = 0;
    for (let index = 0; index < attachments.length; index++) {
      const item = attachments[index], name = new TextEncoder().encode(item.name), type = new TextEncoder().encode(item.type);
      const produce = () => encodeBytes(item.data, item.data.length, 1, 1, stage(regions.length + 2 + (differences.length ? 1 : 0) + index, `压缩附加图片 ${index + 1}`));
      const block = item.cacheId ? await remembered(`attachment:${item.cacheId}`, produce) : await produce();
      const record = new Uint8Array(16 + name.length + type.length), rv = viewOf(record);
      rv.setUint16(0, name.length); rv.setUint16(2, type.length); rv.setUint32(4, block.bytes.length); rv.setUint32(8, item.w); rv.setUint32(12, item.h);
      record.set(name, 16); record.set(type, 16 + name.length); parts.push(record, block.bytes); attachmentLength += record.length + block.bytes.length;
      methods.push({ label: `附加图片 ${index + 1} · ${item.name}`, method: block.method, bytes: block.bytes.length });
    }
    let textLength = 0;
    if (textData.length) {
      const block = await encodeBytes(textData, textData.length, 1, 1, stage(regions.length + attachments.length + 2, '压缩附加文字'));
      parts.push(block.bytes); textLength = block.bytes.length; methods.push({ label: '附加文字', method: block.method, bytes: textLength });
    }
    const length = header + parts.reduce((sum, p) => sum + p.length, 0), bytes = new Uint8Array(length), v = viewOf(bytes);
    bytes.set(MAGIC); v.setUint32(8, length); v.setUint32(12, w); v.setUint32(16, h); v.setUint32(20, regions.length);
    v.setUint32(24, lsb.bytes.length); v.setUint32(28, alphaLength); v.setUint32(32, low.crc(base)); v.setUint32(36, low.crc(original)); v.setUint32(44, textLength);
    if (attachments.length || differences.length) { bytes[7] = differences.length ? 51 : 50; v.setUint32(48, attachments.length); v.setUint32(52, attachmentLength); }
    if (differences.length) { v.setUint32(56, differences.length); v.setUint32(60, diffLength); }
    let offset = header;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    v.setUint32(40, low.crc(bytes.subarray(header)));
    const fits = length * 8 <= w * h * 9;
    let carrier;
    if (fits) {
      report({ progress: 88, message: '写入载荷，验证原图、底图 i2 和附加文字…' });
      carrier = embed(base, bytes);
      const restored = await restore(carrier, w, h);
      if (!equal(restored.original, original) || !equal(restored.base, base) || restored.text !== text || !sameAttachments(restored.attachments, attachments)) throw new Error('隐写端到端往返验证失败');
      if (differences.length !== restored.differences.length || differences.some((node, index) => !equal(node.rgba, restored.differences[index].rgba))) throw new Error('差分图往返验证失败');
    }
    return { fits, bytes, carrier, base, methods, w, h, textBytes: textData.length, attachmentCount: attachments.length, cacheHits };
  }
  async function restore(carrier, w, h, report = () => {}) {
    const info = probe(carrier, w, h);
    if (!info.detected) return { detected: false };
    const bytes = readCarrier(carrier, info.length), v = viewOf(bytes);
    if (low.crc(bytes.subarray(info.header)) !== v.getUint32(40)) throw new Error('隐写载荷校验失败：图片可能经过重压缩或编辑');
    let offset = info.header;
    function take(length) {
      if (!Number.isInteger(length) || length < 0 || length > bytes.length - offset) throw new Error('隐写分块长度无效');
      const result = bytes.subarray(offset, offset + length); offset += length; return result;
    }
    report({ progress: 20, message: '正在恢复底图 i2 的原始低位…' });
    const lsb = await low.decode(take(v.getUint32(24)));
    if (lsb.w !== w || lsb.h !== h) throw new Error('i2 低位尺寸不匹配');
    const base = new Uint8Array(carrier); let symbol = 0;
    for (let i = 0; i < base.length; i++) if ((i & 3) !== 3) base[i] = (base[i] & 248) | lsb.symbols[symbol++]; else base[i] = 255;
    const alphaLength = v.getUint32(28);
    if (alphaLength) {
      const alpha = await decodeBytes(take(alphaLength));
      if (alpha.w !== w || alpha.h !== h || alpha.channels !== 1) throw new Error('Alpha 通道尺寸不匹配');
      for (let p = 0; p < w * h; p++) base[p * 4 + 3] = alpha.data[p];
    }
    if (low.crc(base) !== v.getUint32(32)) throw new Error('底图 i2 校验失败：图片高位可能已被修改');
    const original = new Uint8Array(base), regions = [];
    for (let index = 0; index < info.count; index++) {
      report({ progress: 35 + 45 * index / Math.max(1, info.count), message: `正在恢复选区 ${index + 1}…` });
      const record = take(24), rv = viewOf(record);
      const r = { x: rv.getUint32(0), y: rv.getUint32(4), w: rv.getUint32(8), h: rv.getUint32(12), mode: modes[record[16]] };
      if (record[17] || record[18] || record[19]) throw new Error('选区记录保留字段无效');
      regions.push(r); validateRegions(regions, w, h);
      const block = await decodeBytes(take(rv.getUint32(20)));
      if (block.w !== r.w || block.h !== r.h || block.channels !== 4) throw new Error('选区 RGBA 数据尺寸不匹配');
      paste(original, w, r, block.data);
    }
    let differences = [];
    if (info.diffCount) {
      if (!diffCodec) throw new Error('当前环境未加载差分图解码器');
      report({ progress: 75, message: '正在沿父本路径恢复差分图…' });
      differences = await diffCodec.decode(take(info.diffLength), base, w, h, decodeBytes);
      if (differences.length !== info.diffCount) throw new Error('差分图计数不匹配');
    }
    const attachments = [], attachmentStart = offset;
    let attachmentBytes = 0;
    for (let index = 0; index < info.attachmentCount; index++) {
      report({ progress: 80 + 8 * index / info.attachmentCount, message: `正在提取附加图片 ${index + 1}…` });
      const record = take(16), rv = viewOf(record), nameLength = rv.getUint16(0), typeLength = rv.getUint16(2);
      if (!nameLength || nameLength > 1024 || !typeLength || typeLength > 128) throw new Error('附加图片名称或类型长度无效');
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const name = decoder.decode(take(nameLength)), type = decoder.decode(take(typeLength));
      const blockBytes = take(rv.getUint32(4));
      if (blockBytes.length < 20 || viewOf(blockBytes).getUint32(4) > MAX_ATTACHMENT_BYTES - attachmentBytes || viewOf(blockBytes).getUint32(8) !== 1 || blockBytes[12] !== 1) throw new Error('附加图片数据长度无效');
      const block = await decodeBytes(blockBytes); attachmentBytes += block.data.length;
      attachments.push({ name, type, w: rv.getUint32(8), h: rv.getUint32(12), data: block.data });
    }
    if (offset - attachmentStart !== info.attachmentLength) throw new Error('附加图片区段长度不匹配');
    validateAttachments(attachments);
    let text = '';
    const textLength = v.getUint32(44);
    if (textLength) {
      const block = await decodeBytes(take(textLength));
      if (block.channels !== 1 || block.h !== 1 || block.w > MAX_TEXT) throw new Error('文字分块尺寸无效');
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(block.data);
    }
    if (offset !== bytes.length) throw new Error('隐写内容包含未定义的尾部数据');
    if (low.crc(original) !== v.getUint32(36)) throw new Error('恢复的原图校验失败');
    report({ progress: 90, message: '原图、i2 和文字均已通过校验' });
    return { detected: true, original, base, text, regions, attachments, differences, version: info.version, w, h, length: bytes.length };
  }
  return { build, restore, probe, embed, readCarrier, makeBase, crop, fill, encodeBytes, decodeBytes, byteTransform, validateRegions, validateAttachments, sameAttachments, modes, equal };
}
if (typeof module !== 'undefined') module.exports = ImgSteg;
