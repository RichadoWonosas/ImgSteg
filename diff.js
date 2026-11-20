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
  const pairKey = (a, b) => { const x = identity(a), y = identity(b); return `${Math.min(x, y)}:${Math.max(x, y)}`; };
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
  // Reorient only the unique root path. An XOR edge and its boxes are symmetric.
  // Slot IDs stay stable; the caller exchanges the root/selected pixel and name references.
  function reroot(nodes, rootId) {
    graph(nodes);
    if (!nodes.some(node => node.id === rootId)) throw new Error('请选择已有差分图作为基底');
    const neighbors = new Map([['base', []], ...nodes.map(node => [node.id, []])]);
    for (const node of nodes) { neighbors.get(node.id).push({ id: node.parentId, edge: node }); neighbors.get(node.parentId).push({ id: node.id, edge: node }); }
    const mapId = id => id === rootId ? 'base' : id === 'base' ? rootId : id;
    const edges = new Map(), seen = new Set([rootId]), queue = [rootId];
    for (let i = 0; i < queue.length; i++) for (const next of neighbors.get(queue[i])) if (!seen.has(next.id)) {
      seen.add(next.id); queue.push(next.id);
      edges.set(mapId(next.id), { parentId: mapId(queue[i]), policy: next.edge.policy, maxBoxes: next.edge.maxBoxes ?? 20, chunkRows: next.edge.chunkRows ?? 32, chunkCols: next.edge.chunkCols ?? 32, regions: (next.edge.regions || []).map(r => ({ ...r })) });
    }
    const result = nodes.map(node => ({ ...node, ...edges.get(node.id) }));
    graph(result); return result;
  }
  function removeContained(boxes) {
    return boxes.filter((box, index) => !boxes.some((outer, other) => other !== index && outer.x <= box.x && outer.y <= box.y && outer.x + outer.w >= box.x + box.w && outer.y + outer.h >= box.y + box.h && (area(outer) > area(box) || other < index)));
  }
  function boxesValid(boxes, w, h, limit = 64) {
    if (!Array.isArray(boxes) || boxes.length > limit) throw new Error(`每张差分图最多支持 ${limit} 个选框`);
    for (const r of boxes) if (![r.x, r.y, r.w, r.h].every(Number.isInteger) || r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > w || r.y + r.h > h) throw new Error('差分选框超出图像或尺寸无效');
  }
  function morton(x, y) { let value = 0; for (let bit = 0; bit < 8; bit++) value |= ((x >>> bit) & 1) << (bit * 2) | ((y >>> bit) & 1) << (bit * 2 + 1); return value; }
  function bestSplit(mask, w, r) {
    let count = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) count += Boolean(mask[y * w + x]);
    if (count < 2 || count === area(r)) return null;
    let best = null;
    // A one-pixel-wide/tall region only benefits from removing a gap.
    if (r.w === 1 || r.h === 1) {
      const vertical = r.h === 1, n = vertical ? r.w : r.h; let first = -1, last = -1, gap = 0, split = -1;
      for (let a = 0; a < n; a++) if (mask[(r.y + (vertical ? 0 : a)) * w + r.x + (vertical ? a : 0)]) {
        if (first < 0) first = a;
        if (last >= 0 && a - last - 1 > gap) { gap = a - last - 1; split = last + 1; }
        last = a;
      }
      if (split < 0) return null;
      const left = vertical ? { x: r.x + first, y: r.y, w: split - first, h: 1 } : { x: r.x, y: r.y + first, w: 1, h: split - first };
      const right = vertical ? { x: r.x + split + gap, y: r.y, w: last - split - gap + 1, h: 1 } : { x: r.x, y: r.y + split + gap, w: 1, h: last - split - gap + 1 };
      return { boxes: [left, right], gain: area(r) - area(left) - area(right), axis: vertical ? 'x' : 'y', cut: (vertical ? r.x : r.y) + split, disconnected: true };
    }
    for (const axis of ['x', 'y']) {
      const vertical = axis === 'x', n = vertical ? r.w : r.h, m = vertical ? r.h : r.w;
      const lows = new Int32Array(n + 1).fill(m), highs = new Int32Array(n + 1).fill(-1), occupied = new Uint8Array(Math.ceil(n / 8)); let last = -1;
      for (let a = n - 1; a >= 0; a--) {
        let low = m, high = -1;
        for (let b = 0; b < m; b++) if (mask[(r.y + (vertical ? b : a)) * w + r.x + (vertical ? a : b)]) { low = Math.min(low, b); high = Math.max(high, b); }
        if (high >= 0) { occupied[a >>> 3] |= 1 << (a & 7); if (last < 0) last = a; }
        lows[a] = Math.min(low, lows[a + 1]); highs[a] = Math.max(high, highs[a + 1]);
      }
      let first = -1, end = -1, low = m, high = -1, rightFirst = 0;
      for (let a = 0; a < n - 1; a++) {
        if (occupied[a >>> 3] & (1 << (a & 7))) {
          if (first < 0) first = a; end = a;
          for (let b = 0; b < m; b++) if (mask[(r.y + (vertical ? b : a)) * w + r.x + (vertical ? a : b)]) { low = Math.min(low, b); high = Math.max(high, b); }
        }
        if (first < 0 || highs[a + 1] < 0) continue;
        rightFirst = Math.max(rightFirst, a + 1); while (!(occupied[rightFirst >>> 3] & (1 << (rightFirst & 7)))) rightFirst++;
        const left = vertical ? { x: r.x + first, y: r.y + low, w: end - first + 1, h: high - low + 1 } : { x: r.x + low, y: r.y + first, w: high - low + 1, h: end - first + 1 };
        const right = vertical ? { x: r.x + rightFirst, y: r.y + lows[a + 1], w: last - rightFirst + 1, h: highs[a + 1] - lows[a + 1] + 1 } : { x: r.x + lows[a + 1], y: r.y + rightFirst, w: highs[a + 1] - lows[a + 1] + 1, h: last - rightFirst + 1 };
        const gain = area(r) - area(left) - area(right);
        if (gain > 0) {
          const plan = { boxes: [left, right], gain, axis, cut: (vertical ? r.x : r.y) + a + 1, disconnected: rightFirst - end > 1 };
          if (!best || gain > best.gain || gain === best.gain && plan.disconnected && !best.disconnected) best = plan;
        }
      }
    }
    return best;
  }
  function refineBoxes(mask, w, boxes, limit = 20) {
    let result = removeContained(boxes).map(r => ({ ...r })); const cuts = new Map();
    while (result.length < limit) {
      let chosen;
      for (const [i, r] of result.entries()) {
        const key = `${r.x},${r.y},${r.w},${r.h}`;
        if (!cuts.has(key)) cuts.set(key, bestSplit(mask, w, r));
        const split = cuts.get(key);
        if (split && (!chosen || split.gain > chosen.split.gain)) chosen = { i, split };
      }
      if (!chosen) break;
      result.splice(chosen.i, 1, ...chosen.split.boxes); result = removeContained(result);
    }
    return result.sort((a, b) => a.y - b.y || a.x - b.x);
  }
  function autoBoxes(mask, w, h, maxBoxes = 20) {
    if (!Number.isInteger(maxBoxes) || maxBoxes < 1 || maxBoxes > 256) throw new Error('自动选区数量须为 1–256 的整数');
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
    while (components.length > Math.min(10, maxBoxes)) {
      let bestA = 0, bestB = 1, bestCost = Infinity, merged;
      for (let a = 0; a < components.length; a++) for (let b = a + 1; b < components.length; b++) {
        const ra = components[a], rb = components[b], combined = union(ra, rb);
        const overlap = Math.max(0, Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x)) * Math.max(0, Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y));
        const cost = area(combined) - area(ra) - area(rb) + overlap;
        if (cost < bestCost) { bestA = a; bestB = b; bestCost = cost; merged = combined; }
      }
      components[bestA] = merged; components.splice(bestB, 1);
    }
    return refineBoxes(mask, w, components, maxBoxes);
  }
  function mergeChunks(cells, cols, rows) {
    function sweep(transpose) {
      const width = transpose ? rows : cols, height = transpose ? cols : rows, boxes = []; let previous = new Map();
      const filled = (x, y) => cells[transpose ? x * cols + y : y * cols + x];
      for (let y = 0; y < height; y++) {
        const current = new Map(); let x = 0;
        while (x < width) {
          if (!filled(x, y)) { x++; continue; }
          const start = x; while (x < width && filled(x, y)) x++;
          const key = `${start}:${x - start}`; let box = previous.get(key);
          if (box) box.h++; else { box = { x: start, y, w: x - start, h: 1 }; boxes.push(box); }
          current.set(key, box);
        }
        previous = current;
      }
      return transpose ? boxes.map(r => ({ x: r.y, y: r.x, w: r.h, h: r.w })) : boxes;
    }
    function largestFirst(wide) {
      const remaining = cells.slice(), boxes = []; let work = 0;
      while (remaining.some(Boolean)) {
        if ((work += cols * rows) > 4 * 1024 * 1024) return null;
        const heights = new Int32Array(cols); let best = { x: 0, y: 0, w: 0, h: 0 };
        for (let y = 0; y < rows; y++) {
          const stack = [];
          for (let x = 0; x < cols; x++) heights[x] = remaining[y * cols + x] ? heights[x] + 1 : 0;
          for (let x = 0; x <= cols; x++) {
            const height = x === cols ? 0 : heights[x];
            while (stack.length && heights[stack[stack.length - 1]] > height) {
              const h = heights[stack.pop()], left = stack.length ? stack[stack.length - 1] + 1 : 0, r = { x: left, y: y - h + 1, w: x - left, h };
              if (area(r) > area(best) || area(r) === area(best) && (wide ? r.w > best.w : r.h > best.h)) best = r;
            }
            stack.push(x);
          }
        }
        boxes.push(best);
        for (let y = best.y; y < best.y + best.h; y++) remaining.fill(0, y * cols + best.x, y * cols + best.x + best.w);
      }
      return boxes;
    }
    function joinNeighbors(input) {
      const boxes = input.map(r => ({ ...r })); let joined = true;
      while (joined) {
        joined = false;
        const horizontal = new Map(), vertical = new Map();
        boxes.forEach((r, i) => { horizontal.set(`${r.x}:${r.y}:${r.h}`, i); vertical.set(`${r.x}:${r.y}:${r.w}`, i); });
        for (let i = 0; i < boxes.length; i++) {
          const r = boxes[i], right = horizontal.get(`${r.x + r.w}:${r.y}:${r.h}`), below = vertical.get(`${r.x}:${r.y + r.h}:${r.w}`), next = right ?? below;
          if (next !== undefined) { boxes[i] = union(r, boxes[next]); boxes.splice(next, 1); joined = true; break; }
        }
      }
      return boxes;
    }
    const candidates = [sweep(false), sweep(true), largestFirst(true), largestFirst(false)].filter(Boolean).map(joinNeighbors);
    const perimeter = boxes => boxes.reduce((sum, r) => sum + r.w + r.h, 0);
    candidates.sort((a, b) => a.length - b.length || perimeter(a) - perimeter(b)); return candidates[0];
  }
  function chunkBoxes(mask, w, h, requestedRows = 32, requestedCols = 32) {
    if (![requestedRows, requestedCols].every(value => Number.isInteger(value) && value >= 1 && value <= 65536) || requestedRows * requestedCols > 65536) throw new Error('分块行列须为 1–65536 的整数，且总分块数不能超过 65536');
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > MAX_PIXELS || mask.length !== w * h) throw new Error('分块掩码尺寸无效');
    const cols = Math.min(requestedCols, w), rows = Math.min(requestedRows, h), xs = Array.from({ length: cols + 1 }, (_, i) => Math.floor(i * w / cols)), ys = Array.from({ length: rows + 1 }, (_, i) => Math.floor(i * h / rows));
    const full = new Uint8Array(cols * rows), shrunk = []; let active = 0, unshrunk = 0;
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
      const left = xs[cx], right = xs[cx + 1], top = ys[cy], bottom = ys[cy + 1]; let minX = right, minY = bottom, maxX = -1, maxY = -1;
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) if (mask[y * w + x]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      if (maxX < 0) continue;
      active++;
      if (minX === left && minY === top && maxX + 1 === right && maxY + 1 === bottom) { full[cy * cols + cx] = 1; unshrunk++; }
      else shrunk.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, kind: 'shrunk', cells: 1 });
    }
    const merged = mergeChunks(full, cols, rows).map(r => ({ x: xs[r.x], y: ys[r.y], w: xs[r.x + r.w] - xs[r.x], h: ys[r.y + r.h] - ys[r.y], kind: r.w * r.h > 1 ? 'merged' : 'cell', cells: r.w * r.h }));
    return { boxes: [...shrunk, ...merged].sort((a, b) => a.y - b.y || a.x - b.x), grid: { cols, rows, xs, ys, requestedRows, requestedCols }, stats: { total: cols * rows, active, shrunk: shrunk.length, unshrunk, retained: merged.length, merged: merged.filter(r => r.cells > 1).length, saved: unshrunk - merged.length } };
  }
  function cachedPlan(analysis, name, key, create) {
    const plans = analysis[name] ||= new Map();
    if (!plans.has(key)) { plans.set(key, create()); while (plans.size > 4) plans.delete(plans.keys().next().value); }
    return plans.get(key);
  }
  function autoPlan(analysis, w, h, maxBoxes = 20) {
    if (maxBoxes === 20) return analysis.boxes;
    return cachedPlan(analysis, 'autoPlans', maxBoxes, () => autoBoxes(analysis.mask, w, h, maxBoxes));
  }
  function chunkPlan(analysis, w, h, rows = 32, cols = 32) {
    return cachedPlan(analysis, 'chunkPlans', `${rows}:${cols}`, () => chunkBoxes(analysis.mask, w, h, rows, cols));
  }
  function boxesFor(node, analysis, w, h) {
    if (node.policy === 'chunk') return chunkPlan(analysis, w, h, node.chunkRows ?? 32, node.chunkCols ?? 32).boxes;
    if (node.policy === 'full') return [{ x: 0, y: 0, w, h }];
    if (node.policy === 'auto') return autoPlan(analysis, w, h, node.maxBoxes ?? 20);
    boxesValid(node.regions, w, h); return node.regions;
  }
  function analyze(parent, child, w, h) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > MAX_PIXELS || parent.length !== w * h * 4 || child.length !== parent.length) throw new Error('差分图与父本必须具有相同像素尺寸');
    const key = `${pairKey(parent, child)}:${w}:${h}`;
    if (masks.has(key)) return masks.get(key);
    const mask = new Uint8Array(w * h); let count = 0;
    for (let p = 0; p < mask.length; p++) { const i = p * 4; if (parent[i] !== child[i] || parent[i + 1] !== child[i + 1] || parent[i + 2] !== child[i + 2] || parent[i + 3] !== child[i + 3]) { mask[p] = 1; count++; } }
    const result = { mask, count, boxes: autoBoxes(mask, w, h) };
    masks.set(key, result); while (masks.size > 2) masks.delete(masks.keys().next().value); return result;
  }
  function coverage(mask, w, h, boxes) {
    boxesValid(boxes, w, h, 65536); const covered = new Uint8Array(w * h), events = new Map(); let missing = 0;
    const addEvent = (y, event) => { if (!events.has(y)) events.set(y, []); events.get(y).push(event); };
    boxes.forEach((r, i) => { addEvent(r.y, { i, r, enter: true }); addEvent(r.y + r.h, { i, enter: false }); });
    const rows = [...events.keys()].sort((a, b) => a - b), active = new Map();
    for (let row = 0; row < rows.length - 1; row++) {
      for (const event of events.get(rows[row])) if (event.enter) active.set(event.i, event.r); else active.delete(event.i);
      const spans = [...active.values()].map(r => [r.x, r.x + r.w]).sort((a, b) => a[0] - b[0]), merged = [];
      for (const span of spans) { const previous = merged[merged.length - 1]; if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]); else merged.push(span.slice()); }
      for (let y = rows[row]; y < rows[row + 1]; y++) for (const [left, right] of merged) covered.fill(1, y * w + left, y * w + right);
    }
    for (let p = 0; p < mask.length; p++) if (mask[p] && !covered[p]) missing++;
    return { covered, missing };
  }
  function rasterChunkPreview(rgba, w, h, plan) {
    const paint = (x, y, color, blend = false) => {
      x = Math.min(w - 1, x); y = Math.min(h - 1, y); if (x < 0 || y < 0) return;
      const i = (y * w + x) * 4; for (let c = 0; c < 3; c++) rgba[i + c] = blend ? Math.round(rgba[i + c] * 0.65 + color[c] * 0.35) : color[c]; rgba[i + 3] = 255;
    };
    for (const x of plan.grid.xs) for (let y = 0; y < h; y++) paint(x, y, [153, 153, 153], true);
    for (const y of plan.grid.ys) for (let x = 0; x < w; x++) paint(x, y, [153, 153, 153], true);
    for (const r of plan.boxes) {
      const color = r.kind === 'shrunk' ? [233, 154, 53] : r.kind === 'merged' ? [50, 183, 128] : [169, 112, 229];
      for (let x = r.x; x < r.x + r.w; x++) { paint(x, r.y, color); paint(x, r.y + r.h - 1, color); }
      for (let y = r.y; y < r.y + r.h; y++) { paint(r.x, y, color); paint(r.x + r.w - 1, y, color); }
    }
    return rgba;
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
  async function encodePatch(xor, w, h, encodeBytes) {
    const dense = await encodeBytes(xor, w, h, 4);
    let count = 0; const pixels = w * h, maskLength = Math.ceil(pixels / 8);
    for (let p = 0; p < pixels; p++) if (xor[p * 4] || xor[p * 4 + 1] || xor[p * 4 + 2] || xor[p * 4 + 3]) count++;
    const length = maskLength + count * 4;
    if (length >= xor.length) return { ...dense, sparse: false, denseBytes: dense.bytes.length };
    const packed = new Uint8Array(Math.ceil(length / 4) * 4); let offset = maskLength;
    for (let p = 0; p < pixels; p++) if (xor[p * 4] || xor[p * 4 + 1] || xor[p * 4 + 2] || xor[p * 4 + 3]) {
      packed[p >>> 3] |= 1 << (7 - (p & 7)); packed.set(xor.subarray(p * 4, p * 4 + 4), offset); offset += 4;
    }
    const compressed = await encodeBytes(packed, packed.length / 4, 1, 4);
    if (20 + compressed.bytes.length >= dense.bytes.length) return { ...dense, sparse: false, denseBytes: dense.bytes.length };
    const bytes = new Uint8Array(20 + compressed.bytes.length), v = view(bytes);
    bytes.set([83, 80, 88, 49]); v.setUint32(4, w); v.setUint32(8, h); v.setUint32(12, count); v.setUint32(16, low.crc(xor)); bytes.set(compressed.bytes, 20);
    return { bytes, method: `稀疏掩码＋变化 RGBA / ${compressed.method}`, sparse: true, denseBytes: dense.bytes.length };
  }
  const patchContents = new Map(); let patchContentBytes = 0;
  async function cachedPatch(xor, w, h, encodeBytes) {
    if (xor.length > 4096) return encodePatch(xor, w, h, encodeBytes);
    const key = `${w}:${h}:${low.crc(xor)}`, previous = patchContents.get(key);
    if (previous && previous.data.every((value, i) => value === xor[i])) return previous.block;
    const block = await encodePatch(xor, w, h, encodeBytes);
    if (previous) patchContentBytes -= previous.data.length + previous.block.bytes.length;
    patchContents.set(key, { data: xor.slice(), block }); patchContentBytes += xor.length + block.bytes.length;
    while (patchContents.size > 256 || patchContentBytes > 4 * 1024 * 1024) { const first = patchContents.keys().next().value, item = patchContents.get(first); patchContentBytes -= item.data.length + item.block.bytes.length; patchContents.delete(first); }
    return block;
  }
  function rememberPatch(key, block) {
    patches.set(key, block); cacheBytes += block.bytes.length;
    while (patches.size > 4096 || cacheBytes > 32 * 1024 * 1024 && patches.size > 1) { const first = patches.keys().next().value; cacheBytes -= patches.get(first).bytes.length; patches.delete(first); }
    return block;
  }
  async function chooseDelta(xor, subtract, w, h, encodeBytes, xorBlock) {
    const original = xorBlock || await cachedPatch(xor, w, h, encodeBytes);
    let best = { ...original, method: `XOR / ${original.method}`, subtracted: false };
    // A SUB1 wrapper adds four bytes; tiny raw blocks cannot beat XOR.
    if (best.bytes.length > 24) {
      const sub = await cachedPatch(subtract, w, h, encodeBytes);
      if (sub.bytes.length + 4 < best.bytes.length) {
        const bytes = new Uint8Array(4 + sub.bytes.length); bytes.set([83, 85, 66, 49]); bytes.set(sub.bytes, 4);
        best = { ...sub, bytes, denseBytes: sub.denseBytes + 4, method: `SUB / ${sub.method}`, subtracted: true };
      }
    }
    return best;
  }
  async function decodePatch(bytes, w, h, decodeBytes, allowSparse = true) {
    const sparse = bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'SPX1';
    if (!sparse) {
      if (bytes.length < 20 || view(bytes).getUint32(4) !== w || view(bytes).getUint32(8) !== h || bytes[12] !== 4) throw new Error('XOR 分块尺寸无效');
      return (await decodeBytes(bytes)).data;
    }
    if (!allowSparse || bytes.length < 40) throw new Error('稀疏分块格式无效');
    const v = view(bytes), pixels = w * h, count = v.getUint32(12), maskLength = Math.ceil(pixels / 8);
    if (v.getUint32(4) !== w || v.getUint32(8) !== h || count > pixels) throw new Error('稀疏分块尺寸或计数无效');
    const length = maskLength + count * 4, padded = Math.ceil(length / 4) * 4, payload = bytes.subarray(20);
    if (view(payload).getUint32(4) !== padded / 4 || view(payload).getUint32(8) !== 1 || payload[12] !== 4) throw new Error('稀疏分块数据长度无效');
    const { data } = await decodeBytes(payload);
    if (data.length !== padded || data.subarray(length).some(value => value !== 0) || pixels % 8 && (data[maskLength - 1] & ((1 << (8 - pixels % 8)) - 1))) throw new Error('稀疏分块填充无效');
    const xor = new Uint8Array(pixels * 4); let offset = maskLength, actual = 0;
    for (let p = 0; p < pixels; p++) if (data[p >>> 3] & (1 << (7 - (p & 7)))) {
      if (++actual > count) throw new Error('稀疏掩码计数不匹配');
      const value = data.subarray(offset, offset + 4); if (!value.some(x => x !== 0)) throw new Error('稀疏分块含无变化像素');
      xor.set(value, p * 4); offset += 4;
    }
    if (actual !== count || low.crc(xor) !== v.getUint32(16)) throw new Error('稀疏分块计数或校验失败');
    return xor;
  }
  async function encode(nodes, base, w, h, encodeBytes, report = () => {}) {
    graph(nodes);
    if (nodes.length * w * h > MAX_PIXELS) throw new Error('差分图合计最多 4000 万像素');
    const byId = new Map(nodes.map(node => [node.id, node])), parts = [], methods = [], imageGroups = []; let sparse = false, subtracted = false; const chunked = nodes.some(node => node.policy === 'chunk'), extended = nodes.some(node => node.policy === 'auto' && (node.maxBoxes ?? 20) > 64 || node.policy === 'chunk' && (node.chunkRows ?? 32) * (node.chunkCols ?? 32) > 1024);
    for (const [index, node] of nodes.entries()) {
      const parent = node.parentId === 'base' ? base : byId.get(node.parentId).rgba;
      if (!['auto', 'manual', 'full', 'chunk'].includes(node.policy)) throw new Error('差分图编码方式无效');
      const analysis = analyze(parent, node.rgba, w, h), boxes = boxesFor(node, analysis, w, h);
      if (coverage(analysis.mask, w, h, boxes).missing) throw new Error(`差分图「${node.name}」的选框未完全覆盖差异像素`);
      const name = new TextEncoder().encode(node.name);
      if (!name.length || name.length > 1024) throw new Error('差分图名称无效或过长');
      const headerSize = extended ? 20 : 16, header = new Uint8Array(headerSize + name.length), hv = view(header), parentIndex = node.parentId === 'base' ? 0 : nodes.findIndex(item => item.id === node.parentId) + 1;
      hv.setUint16(0, name.length);
      if (extended) { hv.setUint16(2, node.policy === 'chunk' ? 1 : node.policy === 'auto' ? 2 : 0); hv.setUint32(4, boxes.length); hv.setUint32(8, parentIndex); hv.setUint32(12, low.crc(node.rgba)); }
      else { hv.setUint16(2, boxes.length); hv.setUint32(4, parentIndex); hv.setUint32(8, low.crc(node.rgba)); }
      header.set(name, headerSize); parts.push(header);
      const group = { key: `diff-${index + 1}`, label: `差分图 ${index + 1} · ${node.name}`, frames: boxes.length, bytes: header.length }; imageGroups.push(group);
      for (const [patchIndex, r] of boxes.entries()) {
        report({ progress: 100 * (index + patchIndex / Math.max(1, boxes.length)) / Math.max(1, nodes.length), message: `差分图 ${index + 1} / 差值区域 ${patchIndex + 1}` });
        const geometry = `${w}:${r.x},${r.y},${r.w},${r.h}`, key = `delta:${identity(parent)}>${identity(node.rgba)}:${geometry}`, xorKey = `xor:${pairKey(parent, node.rgba)}:${geometry}`;
        let block = patches.get(key);
        if (!block) {
          const xor = new Uint8Array(r.w * r.h * 4), subtract = new Uint8Array(xor.length);
          for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) for (let c = 0; c < 4; c++) { const dest = (y * r.w + x) * 4 + c, src = ((r.y + y) * w + r.x + x) * 4 + c; xor[dest] = parent[src] ^ node.rgba[src]; subtract[dest] = (node.rgba[src] - parent[src] + 256) & 255; }
          const xorBlock = patches.get(xorKey) || rememberPatch(xorKey, await cachedPatch(xor, r.w, r.h, encodeBytes));
          block = rememberPatch(key, await chooseDelta(xor, subtract, r.w, r.h, encodeBytes, xorBlock));
        }
        subtracted ||= block.subtracted;
        sparse ||= block.sparse;
        const record = new Uint8Array(20), rv = view(record);
        [r.x, r.y, r.w, r.h, block.bytes.length].forEach((value, i) => rv.setUint32(i * 4, value)); parts.push(record, block.bytes); group.bytes += record.length + block.bytes.length;
        methods.push({ label: `选框 ${patchIndex + 1}`, imageKey: group.key, frame: patchIndex + 1, recordBytes: 20, method: block.method, bytes: block.bytes.length, denseBytes: block.denseBytes, sparse: block.sparse, chunked: node.policy === 'chunk' });
      }
    }
    const bytes = new Uint8Array(20 + parts.reduce((sum, part) => sum + part.length, 0)), v = view(bytes);
    bytes.set([68, 73, 70, extended ? 52 : chunked ? 51 : sparse ? 50 : 49]); v.setUint32(4, nodes.length); v.setUint32(8, w); v.setUint32(12, h); v.setUint32(16, low.crc(base));
    let offset = 20; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return { bytes, methods, imageGroups, sparse, chunked, extended, subtracted };
  }
  function summarizeMethods(methods, limit = 256) {
    if (methods.length <= limit) return methods;
    const groups = new Map();
    for (const item of methods) {
      const label = item.frame ? '选框' : item.label.replace(/ · (?:XOR|差值) \d+$/, ' · 差值'), key = `${item.imageKey || ''}:${label}:${item.method}:${Boolean(item.sparse)}`;
      let group = groups.get(key);
      if (!group) { group = { ...item, label, bytes: 0, blocks: 0, denseBytes: item.denseBytes === undefined ? undefined : 0 }; groups.set(key, group); }
      group.bytes += item.bytes; group.blocks++; if (group.denseBytes !== undefined) group.denseBytes += item.denseBytes;
    }
    return [...groups.values()].map(item => ({ ...item, label: item.blocks > 1 ? `${item.label}（${item.blocks} 块汇总）` : item.label }));
  }
  async function decode(bytes, base, w, h, decodeBytes, allowSubtract = true) {
    if (bytes.length < 20 || !['DIF1', 'DIF2', 'DIF3', 'DIF4'].includes(String.fromCharCode(...bytes.subarray(0, 4)))) throw new Error('差分区段文件头无效');
    const v = view(bytes), count = v.getUint32(4), allowSparse = bytes[3] >= 50, extended = bytes[3] === 52, maxPatches = bytes[3] === 51 ? 1024 : 64;
    if (count > MAX_NODES || count * w * h > MAX_PIXELS || v.getUint32(8) !== w || v.getUint32(12) !== h || v.getUint32(16) !== low.crc(base)) throw new Error('差分图数量、尺寸或基底校验失败');
    let offset = 20;
    const take = length => { if (length < 0 || length > bytes.length - offset) throw new Error('差分区段被截断'); const value = bytes.subarray(offset, offset + length); offset += length; return value; };
    const nodes = [];
    for (let index = 0; index < count; index++) {
      const header = view(take(extended ? 20 : 16)), nameLength = header.getUint16(0), flags = extended ? header.getUint16(2) : 0, patchCount = extended ? header.getUint32(4) : header.getUint16(2), parent = header.getUint32(extended ? 8 : 4), crc = header.getUint32(extended ? 12 : 8);
      const limit = extended ? flags === 1 ? 65536 : flags === 2 ? 256 : 64 : maxPatches;
      if (!nameLength || nameLength > 1024 || flags > 2 || patchCount > limit || parent > count || header.getUint32(extended ? 16 : 12)) throw new Error('差分图记录无效');
      const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(take(nameLength)), records = []; let patchArea = 0;
      for (let p = 0; p < patchCount; p++) {
        const rv = view(take(20)), r = { x: rv.getUint32(0), y: rv.getUint32(4), w: rv.getUint32(8), h: rv.getUint32(12) }; boxesValid([r], w, h);
        patchArea += r.w * r.h; if (extended && flags === 1 && patchArea > w * h) throw new Error('分块累计面积超出图像');
        records.push({ ...r, bytes: take(rv.getUint32(16)) });
      }
      nodes.push({ id: `diff-${index + 1}`, parentId: parent === 0 ? 'base' : `diff-${parent}`, name, records, crc });
    }
    if (offset !== bytes.length) throw new Error('差分区段含未定义尾部');
    for (const index of graph(nodes)) {
      const node = nodes[index], parent = node.parentId === 'base' ? base : nodes[Number(node.parentId.slice(5)) - 1].rgba;
      node.rgba = new Uint8Array(parent);
      for (const r of node.records) {
        const subtracted = r.bytes.length >= 4 && String.fromCharCode(...r.bytes.subarray(0, 4)) === 'SUB1';
        if (subtracted && !allowSubtract) throw new Error('此版本不允许循环减法分块');
        const xor = await decodePatch(subtracted ? r.bytes.subarray(4) : r.bytes, r.w, r.h, decodeBytes, allowSparse);
        // Both operations read the unchanged parent, including overlapping boxes.
        for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) for (let c = 0; c < 4; c++) { const dest = ((r.y + y) * w + r.x + x) * 4 + c; const value = xor[(y * r.w + x) * 4 + c]; node.rgba[dest] = subtracted ? (parent[dest] + value) & 255 : parent[dest] ^ value; }
      }
      if (low.crc(node.rgba) !== node.crc) throw new Error(`差分图「${node.name}」恢复校验失败`);
    }
    return nodes.map(({ id, parentId, name, rgba }) => ({ id, parentId, name, rgba, w, h }));
  }
  return { graph, reroot, mergeChunks, chunkBoxes, chunkPlan, boxesFor, removeContained, bestSplit, refineBoxes, autoBoxes, autoPlan, analyze, coverage, rasterChunkPreview, preview, boxesValid, summarizeMethods, encodePatch, decodePatch, chooseDelta, encode, decode };
}
if (typeof module !== 'undefined') module.exports = DiffCodec;
