/* Native-JS difference masks, bounded auto boxes, DAGs and XOR patch packets. */
function DiffCodec() {
  'use strict';
  const low = LsbCodec(), MAX_NODES = 16, MAX_PIXELS = 40000000;
  const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const area = r => r.w * r.h;
  const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
  const identities = new WeakMap(); let sequence = 0, cacheBytes = 0;
  const patches = new Map(), masks = new Map();
  const identity = object => { if (!identities.has(object)) identities.set(object, ++sequence); return identities.get(object); };
  function graph(nodes) {
    if (!Array.isArray(nodes) || nodes.length > MAX_NODES) throw new Error('最多支持 16 张差分图');
    const byId = new Map(), state = new Map(), order = [];
    nodes.forEach((node, index) => { if (!node.id || node.id === 'base' || byId.has(node.id)) throw new Error('差分图 ID 无效或重复'); byId.set(node.id, index); });
    function visit(index) {
      const node = nodes[index];
      if (state.get(node.id) === 1) throw new Error('差分父本关系不能形成循环');
      if (state.get(node.id) === 2) return;
      state.set(node.id, 1);
      if (node.parentId !== 'base') {
        if (!byId.has(node.parentId)) throw new Error('每张差分图必须能沿父本路径到达基底图');
        visit(byId.get(node.parentId));
      }
      state.set(node.id, 2); order.push(index);
    }
    nodes.forEach((_, index) => visit(index)); return order;
  }
  function boxesValid(boxes, w, h) {
    if (!Array.isArray(boxes) || boxes.length > 64) throw new Error('每张差分图最多支持 64 个手动选框');
    for (const r of boxes) if (![r.x, r.y, r.w, r.h].every(Number.isInteger) || r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > w || r.y + r.h > h) throw new Error('差分选框超出图像或尺寸无效');
  }
  function morton(x, y) { let value = 0; for (let bit = 0; bit < 8; bit++) value |= ((x >>> bit) & 1) << (bit * 2) | ((y >>> bit) & 1) << (bit * 2 + 1); return value; }
  function autoBoxes(mask, w, h) {
    // Adaptive tiles bound connected-component storage to 256 × 256 cells.
    // Each cell retains exact extrema of changed pixels, so coverage is exact.
    const size = Math.max(1, Math.ceil(Math.max(w, h) / 256)), cols = Math.ceil(w / size), rows = Math.ceil(h / size), cells = new Map();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
      const key = Math.floor(y / size) * cols + Math.floor(x / size), existing = cells.get(key);
      if (!existing) cells.set(key, { x, y, w: 1, h: 1 });
      else { const right = Math.max(existing.x + existing.w, x + 1), bottom = Math.max(existing.y + existing.h, y + 1); existing.x = Math.min(existing.x, x); existing.y = Math.min(existing.y, y); existing.w = right - existing.x; existing.h = bottom - existing.y; }
    }
    const seen = new Uint8Array(cols * rows), queue = new Int32Array(cols * rows); let components = [];
    for (const [key, initial] of cells) {
      if (seen[key]) continue;
      let head = 0, tail = 1, bounds = initial; queue[0] = key; seen[key] = 1;
      while (head < tail) {
        const cell = queue[head++], cx = cell % cols, cy = Math.floor(cell / cols); bounds = union(bounds, cells.get(cell));
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy, next = ny * cols + nx;
          if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !seen[next] && cells.has(next)) { seen[next] = 1; queue[tail++] = next; }
        }
      }
      components.push(bounds);
    }
    // Spatial grouping keeps greedy pair merging bounded on noisy masks.
    if (components.length > 128) {
      components.sort((a, b) => morton(Math.min(255, Math.floor((a.x + a.w / 2) / w * 256)), Math.min(255, Math.floor((a.y + a.h / 2) / h * 256))) - morton(Math.min(255, Math.floor((b.x + b.w / 2) / w * 256)), Math.min(255, Math.floor((b.y + b.h / 2) / h * 256))));
      const grouped = [], groupSize = Math.ceil(components.length / 128);
      for (let i = 0; i < components.length; i += groupSize) grouped.push(components.slice(i, i + groupSize).reduce(union));
      components = grouped;
    }
    while (components.length > 10) {
      let bestA = 0, bestB = 1, bestCost = Infinity, merged;
      for (let a = 0; a < components.length; a++) for (let b = a + 1; b < components.length; b++) {
        const ra = components[a], rb = components[b], combined = union(ra, rb);
        const overlap = Math.max(0, Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x)) * Math.max(0, Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y));
        const cost = area(combined) - area(ra) - area(rb) + overlap;
        if (cost < bestCost) { bestA = a; bestB = b; bestCost = cost; merged = combined; }
      }
      components[bestA] = merged; components.splice(bestB, 1);
    }
    return components.sort((a, b) => a.y - b.y || a.x - b.x);
  }
  function analyze(parent, child, w, h) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > MAX_PIXELS || parent.length !== w * h * 4 || child.length !== parent.length) throw new Error('差分图与父本必须具有相同像素尺寸');
    const key = `${identity(parent)}:${identity(child)}:${w}:${h}`;
    if (masks.has(key)) return masks.get(key);
    const mask = new Uint8Array(w * h); let count = 0;
    for (let p = 0; p < mask.length; p++) { const i = p * 4; if (parent[i] !== child[i] || parent[i + 1] !== child[i + 1] || parent[i + 2] !== child[i + 2] || parent[i + 3] !== child[i + 3]) { mask[p] = 1; count++; } }
    const result = { mask, count, boxes: autoBoxes(mask, w, h) };
    masks.set(key, result); while (masks.size > 2) masks.delete(masks.keys().next().value); return result;
  }
  function coverage(mask, w, h, boxes) {
    boxesValid(boxes, w, h); const covered = new Uint8Array(w * h); let missing = 0;
    for (let y = 0; y < h; y++) {
      const spans = boxes.filter(r => y >= r.y && y < r.y + r.h).map(r => [r.x, r.x + r.w]).sort((a, b) => a[0] - b[0]);
      let start = -1, end = -1;
      for (const [left, right] of spans) {
        if (left > end) { if (start >= 0) covered.fill(1, y * w + start, y * w + end); start = left; end = right; } else end = Math.max(end, right);
      }
      if (start >= 0) covered.fill(1, y * w + start, y * w + end);
      for (let x = 0; x < w; x++) if (mask[y * w + x] && !covered[y * w + x]) missing++;
    }
    return { covered, missing };
  }
  function preview(child, analysis, w, h, boxes) {
    const { covered, missing } = coverage(analysis.mask, w, h, boxes), rgba = new Uint8Array(child.length);
    for (let p = 0; p < w * h; p++) {
      const i = p * 4; rgba[i + 3] = 255;
      if (analysis.mask[p]) { rgba[i] = 255; rgba[i + 1] = rgba[i + 2] = boxes.length && !covered[p] ? 221 : 255; }
      else { rgba[i] = Math.round(child[i] / 2); rgba[i + 1] = Math.round(child[i + 1] / 2); rgba[i + 2] = Math.round(child[i + 2] / 2); }
    }
    return { rgba, missing };
  }
  async function encode(nodes, base, w, h, encodeBytes, report = () => {}) {
    graph(nodes);
    if (nodes.length * w * h > MAX_PIXELS) throw new Error('差分图合计最多 4000 万像素');
    const byId = new Map(nodes.map(node => [node.id, node])), parts = [], methods = [];
    for (const [index, node] of nodes.entries()) {
      const parent = node.parentId === 'base' ? base : byId.get(node.parentId).rgba;
      if (!['auto', 'manual', 'full'].includes(node.policy)) throw new Error('差分图编码方式无效');
      const analysis = analyze(parent, node.rgba, w, h), boxes = node.policy === 'full' ? [{ x: 0, y: 0, w, h }] : node.policy === 'auto' ? analysis.boxes : node.regions;
      if (coverage(analysis.mask, w, h, boxes).missing) throw new Error(`差分图「${node.name}」的选框未完全覆盖差异像素`);
      const name = new TextEncoder().encode(node.name);
      if (!name.length || name.length > 1024) throw new Error('差分图名称无效或过长');
      const header = new Uint8Array(16 + name.length), hv = view(header);
      hv.setUint16(0, name.length); hv.setUint16(2, boxes.length); hv.setUint32(4, node.parentId === 'base' ? 0 : nodes.findIndex(item => item.id === node.parentId) + 1); hv.setUint32(8, low.crc(node.rgba)); header.set(name, 16); parts.push(header);
      for (const [patchIndex, r] of boxes.entries()) {
        report({ progress: 100 * (index + patchIndex / Math.max(1, boxes.length)) / Math.max(1, nodes.length), message: `差分图 ${index + 1} / XOR 区域 ${patchIndex + 1}` });
        const key = `${identity(parent)}:${identity(node.rgba)}:${r.x},${r.y},${r.w},${r.h}`;
        let block = patches.get(key);
        if (!block) {
          const xor = new Uint8Array(r.w * r.h * 4);
          for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) for (let c = 0; c < 4; c++) { const dest = (y * r.w + x) * 4 + c, src = ((r.y + y) * w + r.x + x) * 4 + c; xor[dest] = parent[src] ^ node.rgba[src]; }
          block = await encodeBytes(xor, r.w, r.h, 4);
          patches.set(key, block); cacheBytes += block.bytes.length;
          while (cacheBytes > 32 * 1024 * 1024 && patches.size > 1) { const first = patches.keys().next().value; cacheBytes -= patches.get(first).bytes.length; patches.delete(first); }
        }
        const record = new Uint8Array(20), rv = view(record);
        [r.x, r.y, r.w, r.h, block.bytes.length].forEach((value, i) => rv.setUint32(i * 4, value)); parts.push(record, block.bytes);
        methods.push({ label: `差分图 ${index + 1} · XOR ${patchIndex + 1}`, method: block.method, bytes: block.bytes.length });
      }
    }
    const bytes = new Uint8Array(20 + parts.reduce((sum, part) => sum + part.length, 0)), v = view(bytes);
    bytes.set([68, 73, 70, 49]); v.setUint32(4, nodes.length); v.setUint32(8, w); v.setUint32(12, h); v.setUint32(16, low.crc(base));
    let offset = 20; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return { bytes, methods };
  }
  async function decode(bytes, base, w, h, decodeBytes) {
    if (bytes.length < 20 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'DIF1') throw new Error('差分区段文件头无效');
    const v = view(bytes), count = v.getUint32(4);
    if (count > MAX_NODES || count * w * h > MAX_PIXELS || v.getUint32(8) !== w || v.getUint32(12) !== h || v.getUint32(16) !== low.crc(base)) throw new Error('差分图数量、尺寸或基底校验失败');
    let offset = 20;
    const take = length => { if (length < 0 || length > bytes.length - offset) throw new Error('差分区段被截断'); const value = bytes.subarray(offset, offset + length); offset += length; return value; };
    const nodes = [];
    for (let index = 0; index < count; index++) {
      const header = view(take(16)), nameLength = header.getUint16(0), patchCount = header.getUint16(2), parent = header.getUint32(4);
      if (!nameLength || nameLength > 1024 || patchCount > 64 || parent > count || header.getUint32(12)) throw new Error('差分图记录无效');
      const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(take(nameLength)), records = [];
      for (let p = 0; p < patchCount; p++) {
        const rv = view(take(20)), r = { x: rv.getUint32(0), y: rv.getUint32(4), w: rv.getUint32(8), h: rv.getUint32(12) }; boxesValid([r], w, h);
        records.push({ ...r, bytes: take(rv.getUint32(16)) });
      }
      nodes.push({ id: `diff-${index + 1}`, parentId: parent === 0 ? 'base' : `diff-${parent}`, name, records, crc: header.getUint32(8) });
    }
    if (offset !== bytes.length) throw new Error('差分区段含未定义尾部');
    for (const index of graph(nodes)) {
      const node = nodes[index], parent = node.parentId === 'base' ? base : nodes[Number(node.parentId.slice(5)) - 1].rgba;
      node.rgba = new Uint8Array(parent);
      for (const r of node.records) {
        if (r.bytes.length < 20 || view(r.bytes).getUint32(4) !== r.w || view(r.bytes).getUint32(8) !== r.h || r.bytes[12] !== 4) throw new Error('XOR 分块尺寸无效');
        const block = await decodeBytes(r.bytes);
        // Always XOR against the parent, so overlapping boxes cannot cancel bits.
        for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) for (let c = 0; c < 4; c++) { const dest = ((r.y + y) * w + r.x + x) * 4 + c; node.rgba[dest] = parent[dest] ^ block.data[(y * r.w + x) * 4 + c]; }
      }
      if (low.crc(node.rgba) !== node.crc) throw new Error(`差分图「${node.name}」恢复校验失败`);
    }
    return nodes.map(({ id, parentId, name, rgba }) => ({ id, parentId, name, rgba, w, h }));
  }
  return { graph, autoBoxes, analyze, coverage, preview, boxesValid, encode, decode };
}
if (typeof module !== 'undefined') module.exports = DiffCodec;
