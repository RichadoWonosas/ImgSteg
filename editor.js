/* Pixel-exact geometry shared by pointer/keyboard editing and tests. */
function RectEditor() {
  const parts = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const labels = { move: '整个选框', n: '上边', s: '下边', w: '左边', e: '右边', nw: '左上角', ne: '右上角', sw: '左下角', se: '右下角' };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function adjust(rect, part, dx, dy, width, height) {
    const out = { ...rect };
    if (part === 'move') { out.x = clamp(rect.x + dx, 0, width - rect.w); out.y = clamp(rect.y + dy, 0, height - rect.h); return out; }
    if (!parts.includes(part)) return out;
    let left = rect.x, top = rect.y, right = rect.x + rect.w, bottom = rect.y + rect.h;
    if (part.includes('w')) left = clamp(left + dx, 0, right - 1);
    if (part.includes('e')) right = clamp(right + dx, left + 1, width);
    if (part.includes('n')) top = clamp(top + dy, 0, bottom - 1);
    if (part.includes('s')) bottom = clamp(bottom + dy, top + 1, height);
    return { ...out, x: left, y: top, w: right - left, h: bottom - top };
  }
  function handles(r) {
    const x = r.x, y = r.y, right = x + r.w, bottom = y + r.h, cx = x + r.w / 2, cy = y + r.h / 2;
    return { nw: [x, y], n: [cx, y], ne: [right, y], e: [right, cy], se: [right, bottom], s: [cx, bottom], sw: [x, bottom], w: [x, cy] };
  }
  function hit(r, point, toleranceX, toleranceY) {
    const positions = handles(r);
    // Prefer the nearest handle for small rectangles whose touch targets overlap.
    const near = parts.filter(p => Math.abs(point.x - positions[p][0]) <= toleranceX && Math.abs(point.y - positions[p][1]) <= toleranceY);
    if (near.length) return near.sort((a, b) => {
      const distance = p => ((point.x - positions[p][0]) / toleranceX) ** 2 + ((point.y - positions[p][1]) / toleranceY) ** 2;
      return distance(a) - distance(b);
    })[0];
    if (point.x >= r.x && point.x <= r.x + r.w) {
      if (Math.abs(point.y - r.y) <= toleranceY) return 'n';
      if (Math.abs(point.y - r.y - r.h) <= toleranceY) return 's';
    }
    if (point.y >= r.y && point.y <= r.y + r.h) {
      if (Math.abs(point.x - r.x) <= toleranceX) return 'w';
      if (Math.abs(point.x - r.x - r.w) <= toleranceX) return 'e';
    }
    return point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h ? 'move' : null;
  }
  function topmost(regions, point) {
    for (let i = regions.length - 1; i >= 0; i--) { const r = regions[i]; if (point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h) return i; }
    return -1;
  }
  return { adjust, handles, hit, topmost, parts, labels };
}
if (typeof module !== 'undefined') module.exports = RectEditor;
