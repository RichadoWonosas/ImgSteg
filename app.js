'use strict';
const $ = id => document.getElementById(id), codec = LsbCodec();
const format = n => n.toLocaleString('zh-CN'), svgNS = 'http://www.w3.org/2000/svg';
const rectEditor = RectEditor();
const differenceEngine = DiffCodec();
let worker, image, mode = 'encode', regions = [], revision = 0, busy = false, pendingPreview, drag;
let selectedIndex = -1, selectedPart = 'move', attachments = [], dragAttachmentId = null;
let baseOriginalPreview = false;
let rawPreview = false, pendingBatch = [], queuedDifferences = [];
let creationKind = 'cover', coverRegions = regions, differences = [], activeDifferenceId = null;
let taskKey = '', displayedKey = '', displayedAction = '';
const resultCache = new Map();
let request = 0, taskId = 0, loadId = 0, sourceURL, previewURL;
const outputURLs = new Set();
function workerMain() {
  const codec = LsbCodec(), steg = ImgSteg(), png = PngCodec(), diff = DiffCodec();
  let image;
  const attachedFiles = new Map();
  const differenceFiles = new Map();
  let lowKey = '', lowResult;
  function differenceNodes(metadata) {
    diff.graph(metadata);
    if (metadata.length * image.w * image.h > 40000000) throw new Error('差分图合计最多支持 4000 万像素');
    return metadata.map(node => {
      const entry = differenceFiles.get(node.id);
      if (!entry) throw new Error('差分图数据已失效，请重新上传');
      return { ...node, name: entry.name, rgba: entry.rgba };
    });
  }
  async function load(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let result = await png.decode(bytes);
    if (result) return { ...result, source: 'PNG 原始 8 位像素' };
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width * bitmap.height > 40000000) throw new Error('当前最多支持 4000 万像素');
      const w = bitmap.width, h = bitmap.height, canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
      if (!ctx) throw new Error('无法创建 Canvas');
      ctx.drawImage(bitmap, 0, 0);
      result = { rgba: new Uint8Array(ctx.getImageData(0, 0, w, h).data), w, h, source: '浏览器解码的 8 位 sRGB 像素' };
      canvas.width = canvas.height = 1; return result;
    } finally { bitmap.close(); }
  }
  self.onmessage = async ({ data: message }) => {
    const { action, id } = message;
    const progress = update => self.postMessage({ id, action, ...update });
    try {
      if (action === 'load') {
        progress({ progress: 2, message: '正在读取本地图片…' });
        if (message.demo) {
          const w = 640, h = 400, rgba = new Uint8Array(w * h * 4);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            rgba[i] = (32 + Math.floor(x / 32) * 8) & 248; rgba[i + 1] = (80 + Math.floor(y / 24) * 8) & 248; rgba[i + 2] = (120 + Math.floor((x + y) / 48) * 8) & 248;
            if (x > 160 && x < 300 && y > 100 && y < 230) { rgba[i] = 224; rgba[i + 1] = 160 + x % 24; rgba[i + 2] = 64 + y % 32; }
            rgba[i + 3] = 255;
          }
          image = { rgba, w, h, source: '本机生成的合成示例' };
        } else image = await load(message.file);
        let detected = false, detectionError = '';
        try { detected = steg.probe(image.rgba, image.w, image.h).detected; } catch (error) { detectionError = error.message; }
        const blob = await png.encode(image.rgba, image.w, image.h);
        self.postMessage({ id, action, done: true, w: image.w, h: image.h, source: image.source, detected, detectionError, blob }); return;
      }
      if (!image) throw new Error('请先上传图片');
      const { rgba, w, h } = image;
      if (action === 'rebase') {
        const entry = differenceFiles.get(message.nodeId);
        if (!entry) throw new Error('基底图片数据已失效');
        const detected = steg.probe(entry.rgba, w, h).detected;
        differenceFiles.set(message.nodeId, { ...image, name: message.oldName });
        image = { rgba: entry.rgba, w, h, source: '已载入的差分图原始像素' }; lowKey = ''; lowResult = undefined;
        self.postMessage({ id, action, done: true, nodeId: message.nodeId, detected, source: image.source }); return;
      }
      if (action === 'diff-manual') {
        const nodes = differenceNodes(message.differences), node = nodes.find(item => item.id === message.nodeId);
        if (!node) throw new Error('差分图已失效');
        const parent = node.parentId === 'base' ? rgba : nodes.find(item => item.id === node.parentId).rgba;
        const analysis = diff.analyze(parent, node.rgba, w, h);
        self.postMessage({ id, action, done: true, nodeId: node.id, boxes: analysis.boxes }); return;
      }
      if (action === 'diff-upload') {
        if (differenceFiles.size + message.files.length > 16 || (differenceFiles.size + message.files.length) * w * h > 40000000) throw new Error('最多 16 张差分图，合计最多 4000 万像素');
        const items = [];
        for (const [index, file] of message.files.entries()) {
          progress({ progress: index / message.files.length * 100, message: `正在读取差分图 ${index + 1}…` });
          const decoded = await load(file);
          if (decoded.w !== w || decoded.h !== h) throw new Error(`差分图「${file.name}」必须与基底图尺寸 ${w} × ${h} 相同`);
          if (!file.name || new TextEncoder().encode(file.name).length > 1024) throw new Error('差分图名称过长或无效');
          items.push({ id: `diff-${id}-${index}`, name: file.name, rgba: decoded.rgba, w, h, previewBlob: await png.encode(decoded.rgba, w, h) });
        }
        for (const item of items) differenceFiles.set(item.id, item);
        self.postMessage({ id, action, done: true, items: items.map(({ rgba, ...item }) => item) });
      } else if (action === 'forget-difference') differenceFiles.delete(message.differenceId);
      else if (action === 'diff-preview') {
        const nodes = differenceNodes(message.differences), node = nodes.find(item => item.id === message.nodeId);
        if (!node) throw new Error('请选择差分图');
        const parent = node.parentId === 'base' ? rgba : nodes.find(item => item.id === node.parentId).rgba;
        const analysis = diff.analyze(parent, node.rgba, w, h), boxes = diff.boxesFor(node, analysis, w, h);
        const result = diff.preview(node.rgba, analysis, w, h, boxes), plan = node.policy === 'chunk' ? diff.chunkPlan(analysis, w, h) : null;
        self.postMessage({ id, action, done: true, revision: message.revision, nodeId: node.id, boxes, chunk: plan ? { grid: plan.grid, stats: plan.stats } : null, count: analysis.count, missing: result.missing, blob: await png.encode(result.rgba, w, h) });
      } else if (action === 'attachments') {
        const items = [];
        if (attachedFiles.size + message.files.length > 32) throw new Error('最多附加 32 张图片');
        let total = [...attachedFiles.values()].reduce((sum, item) => sum + item.file.size, 0);
        for (let index = 0; index < message.files.length; index++) {
          const file = message.files[index]; total += file.size;
          if (!file.size || total > 32 * 1024 * 1024) throw new Error('附加图片原文件总大小最多为 32 MiB');
          progress({ progress: 100 * index / message.files.length, message: `正在验证附加图片 ${index + 1}…` });
          const decoded = await load(file);
          const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff' };
          const type = /^image\/[a-zA-Z0-9.+-]+$/.test(file.type) ? file.type : types[file.name.split('.').pop().toLowerCase()] || 'image/x-unknown';
          if (new TextEncoder().encode(file.name).length > 1024) throw new Error('附加图片文件名过长');
          const item = { id: `${id}-${index}`, name: file.name, type, w: decoded.w, h: decoded.h, size: file.size, file, previewBlob: await png.encode(decoded.rgba, decoded.w, decoded.h) };
          items.push(item);
        }
        for (const item of items) attachedFiles.set(item.id, item);
        self.postMessage({ id, action, done: true, items: items.map(({ file, ...item }) => item) });
      } else if (action === 'forget-attachment') {
        attachedFiles.delete(message.attachmentId);
      } else if (action === 'preview') {
        const base = steg.makeBase(rgba, w, h, message.regions, message.blockSize);
        self.postMessage({ id, action, done: true, revision: message.revision, blob: await png.encode(base, w, h) });
      } else if (action === 'analyze') {
        const base = steg.makeBase(rgba, w, h, message.regions, message.blockSize);
        const key = JSON.stringify([message.regions, message.blockSize]);
        if (key !== lowKey || !lowResult) { lowResult = await codec.encode(codec.extract(base), w, h, progress); lowKey = key; }
        const result = { ...lowResult, bytes: lowResult.bytes.slice() };
        self.postMessage({ id, action, done: true, w, h, ...result }, [result.bytes.buffer]);
      } else if (action === 'build') {
        const extraImages = [];
        if (new Set(message.attachmentIds).size !== message.attachmentIds.length) throw new Error('附加图片顺序无效');
        for (const attachmentId of message.attachmentIds) {
          const item = attachedFiles.get(attachmentId);
          if (!item) throw new Error('附加图片已失效，请重新上传');
          extraImages.push({ name: item.name, type: item.type, w: item.w, h: item.h, cacheId: item.id, data: new Uint8Array(await item.file.arrayBuffer()) });
        }
        const variants = differenceNodes(message.differences || []);
        const result = await steg.build(rgba, w, h, message.regions, message.text, message.blockSize, progress, extraImages, variants);
        const baseBlob = await png.encode(result.base, w, h); let carrierBlob;
        if (result.fits) {
          progress({ progress: 93, message: '正在导出无损 PNG，并从导出文件再次验证恢复…' });
          carrierBlob = await png.encode(result.carrier, w, h);
          const saved = await png.decode(new Uint8Array(await carrierBlob.arrayBuffer()));
          const restored = await steg.restore(saved.rgba, w, h);
          if (!steg.equal(restored.original, rgba) || !steg.equal(restored.base, result.base) || restored.text !== message.text || !steg.sameAttachments(restored.attachments, extraImages)) throw new Error('导出 PNG 的恢复校验失败');
          if (variants.length !== restored.differences.length || variants.some((node, index) => !steg.equal(node.rgba, restored.differences[index].rgba))) throw new Error('导出 PNG 的差分图校验失败');
        }
        self.postMessage({ id, action, done: true, w, h, fits: result.fits, bytes: result.bytes, baseBlob, carrierBlob, methods: result.methods, textBytes: result.textBytes }, [result.bytes.buffer]);
      } else if (action === 'restore') {
        const result = await steg.restore(rgba, w, h, progress);
        if (!result.detected) { self.postMessage({ id, action, done: true, detected: false }); return; }
        const originalBlob = await png.encode(result.original, w, h), baseBlob = await png.encode(result.base, w, h);
        const extraImages = result.attachments.map(item => ({ name: item.name, type: item.type, w: item.w, h: item.h, blob: new Blob([item.data], { type: item.type }) }));
        const variants = [];
        for (const node of result.differences) variants.push({ id: node.id, parentId: node.parentId, name: node.name, blob: await png.encode(node.rgba, w, h) });
        self.postMessage({ id, action, done: true, detected: true, w, h, text: result.text, regions: result.regions, originalBlob, baseBlob, attachments: extraImages, differences: variants, version: result.version, length: result.length });
      }
    } catch (error) { self.postMessage({ id, action, revision: message.revision, nodeId: message.nodeId, error: error.message || '处理失败' }); }
  };
}
function makeWorker() {
  const code = `const LocalCodecs = ${typeof LocalCodecs === 'function' ? LocalCodecs.toString() : 'undefined'}; const LsbCodec = ${LsbCodec.toString()}; const DiffCodec = ${DiffCodec.toString()}; const ImgSteg = ${ImgSteg.toString()}; const PngCodec = ${PngCodec.toString()}; (${workerMain.toString()})();`;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
  worker.onmessage = event => receive(event.data);
  worker.onerror = event => { setBusy(false); $('state').textContent = '处理失败'; status(event.message || 'Worker 启动失败，请使用现代浏览器', true); };
}
function status(message, error = false, value) {
  $('status').textContent = message; $('status').classList.toggle('error', error);
  if (value !== undefined) { $('progress').style.width = `${value}%`; document.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', value); }
}
function setBusy(value) {
  busy = value; $('cancel').hidden = !value;
  for (const id of ['generate', 'analyze', 'block-size', 'new-fill', 'extra-text', 'add-attachments', 'attachment-files', 'add-differences', 'difference-files', 'generate-menu-toggle']) $(id).disabled = value || !image;
  for (const id of ['add-region', 'clear-regions']) $(id).disabled = value || !regionsEditable();
  $('restore').disabled = value || !image || !image.detected;
  $('selection-overlay').classList.toggle('locked', value || !regionsEditable());
  for (const input of $('region-list').querySelectorAll('input,select,button')) input.disabled = value || !regionsEditable();
  for (const row of $('region-list').children) row.classList.toggle('clickable-row', !value && regionsEditable());
  for (const input of $('difference-list').querySelectorAll('button,select')) input.disabled = value || input.dataset.unavailable === 'true';
  for (const row of $('difference-list').children) row.classList.toggle('clickable-row', !value);
  $('edit-base').disabled = value || !image;
  $('add-differences').disabled = value; $('difference-files').disabled = value;
  if (value) closeGenerateMenu();
  for (const button of $('attachment-list').querySelectorAll('button')) button.disabled = value || button.dataset.unavailable === 'true';
  for (const row of $('attachment-list').children) row.draggable = !value;
}
function resetMetrics() {
  displayedKey = ''; displayedAction = ''; $('payload-summary').textContent = '等待计算';
  $('remaining').innerHTML = '— <small>byte</small>'; $('remaining').classList.remove('error');
  for (const id of ['bytes', 'pixels', 'method']) $(id).textContent = '—';
  for (const id of ['original', 'compressed', 'remaining-bits']) $(id).textContent = '— bit';
  for (const name of ['square', 'standard', 'wide']) { $(`raw-${name}-size`).textContent = '— × —'; $(`raw-${name}-pixels`).textContent = '— 像素'; }
  $('compression-details').replaceChildren(); $('download').disabled = true; $('download').onclick = null;
}
function clearOutputs() {
  for (const url of outputURLs) URL.revokeObjectURL(url); outputURLs.clear();
  for (const id of ['generated', 'restored', 'decode-text-box', 'decoded-attachments-box', 'decoded-differences-box', 'quick-download']) $(id).hidden = true;
  $('decoded-attachments').replaceChildren(); $('decoded-differences').replaceChildren();
  for (const id of ['steg-preview', 'original-output', 'base-output']) $(id).removeAttribute('src');
  $('decoded-text').value = '';
}
function outputURL(blob) { const url = URL.createObjectURL(blob); outputURLs.add(url); return url; }
function save(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); }
function attachDownload(id, blob, name) { const url = outputURL(blob); $(id).href = url; $(id).download = name; return url; }
function showMetrics(w, h, bytes, method, note) {
  const m = codec.metrics(w, h, bytes);
  $('remaining').replaceChildren(document.createTextNode(format(m.b) + ' '));
  const unit = document.createElement('small'); unit.textContent = 'byte'; $('remaining').append(unit);
  $('remaining').classList.toggle('error', m.r < 0n);
  $('bytes').textContent = format(m.b); $('pixels').textContent = format(m.pixels);
  $('remaining-bits').textContent = `${format(m.r)} bit`;
  $('original').textContent = `${format(m.original)} bit`; $('compressed').textContent = `${format(m.n)} bit`; $('method').textContent = method;
  codec.rawSizes(m.pixels).forEach((size, i) => { const name = ['square', 'standard', 'wide'][i]; $(`raw-${name}-size`).textContent = `${format(size.width)} × ${format(size.height)}`; $(`raw-${name}-pixels`).textContent = `${format(size.pixels)} 像素`; });
  $('result-note').textContent = note;
  $('payload-summary').textContent = `${format(BigInt(bytes))} / ${format(m.original >> 3n)} byte`;
}
function closeGenerateMenu() { $('generate-menu').hidden = true; $('generate-menu-toggle').setAttribute('aria-expanded', 'false'); }
function clearImage() {
  clearTimeout(pendingPreview); if (worker) worker.terminate(); worker = null;
  ++request; taskId = loadId = 0; revision++; image = null; queuedDifferences = [];
  regions = []; coverRegions = regions; selectedIndex = -1; drag = null; baseOriginalPreview = false; rawPreview = false; creationKind = 'cover';
  clearDifferences(); clearAttachments(); resultCache.clear(); resetMetrics(); clearOutputs();
  if (sourceURL) URL.revokeObjectURL(sourceURL); if (previewURL) URL.revokeObjectURL(previewURL); sourceURL = previewURL = undefined;
  $('preview').removeAttribute('src'); $('preview-box').hidden = true; $('dropzone').hidden = false; $('filename').textContent = ''; $('dimensions').textContent = '等待选择'; $('state').textContent = '尚未开始'; $('detection').textContent = '上传后自动识别本项目的隐写标记。'; $('detection').classList.remove('error');
  setBusy(false); updateCreationView(); status('已清空图片，可重新上传一张或多张图片。', false, 0);
}
let importPreviewURLs = [];
function releaseImport() {
  for (const url of importPreviewURLs) URL.revokeObjectURL(url); importPreviewURLs = [];
  pendingBatch = []; $('import-candidates').replaceChildren();
}
function chooseBatchBase() {
  $('import-choice').hidden = true; $('import-base-step').hidden = false;
  $('import-candidates').replaceChildren();
  pendingBatch.forEach((file, index) => {
    const label = document.createElement('label'), radio = document.createElement('input'), thumb = document.createElement('img'), name = document.createElement('span');
    radio.type = 'radio'; radio.name = 'batch-base'; radio.value = index; radio.checked = index === 0; thumb.src = URL.createObjectURL(file); importPreviewURLs.push(thumb.src); thumb.alt = ''; name.textContent = file.name; label.append(radio, thumb, name); $('import-candidates').append(label);
  });
}
function replaceBatch(files, baseIndex = 0) {
  if (!files.length) return;
  if (files.length > 17) { status('一批最多 1 张基底和 16 张差分图。', true); return; }
  clearImage(); openFile(files[baseIndex], false, files.filter((_, index) => index !== baseIndex));
}
function importImages(files, replace = false) {
  if (busy) return;
  files = files.filter(file => file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)$/i.test(file.name));
  if (!files.length) { status('请选择图片文件。', true); return; }
  if (mode === 'decode') { queuedDifferences = []; openFile(files[0]); return; }
  if (replace && files.length === 1 || !image && files.length === 1) { replaceBatch(files); return; }
  releaseImport(); pendingBatch = files;
  $('import-title').textContent = image && !replace ? '如何导入这批图片？' : '选择基底图';
  $('import-hint').textContent = `已选择 ${files.length} 张图片。`;
  $('import-choice').hidden = replace || !image; $('import-base-step').hidden = true;
  if (replace || !image) chooseBatchBase();
  $('image-import-dialog').showModal();
}
function openFile(file, demo = false, batch = []) {
  if (!file && !demo) return;
  queuedDifferences = batch;
  clearTimeout(pendingPreview); if (worker) worker.terminate(); worker = null;
  image = null; regions = []; drag = null; selectedIndex = -1; selectedPart = 'move'; revision++; taskId = 0;
  baseOriginalPreview = false; rawPreview = false; creationKind = 'cover'; coverRegions = regions; clearDifferences(); resultCache.clear();
  clearAttachments();
  resetMetrics(); clearOutputs(); renderRegions();
  if (sourceURL) URL.revokeObjectURL(sourceURL); if (previewURL) URL.revokeObjectURL(previewURL); sourceURL = previewURL = undefined;
  $('preview').removeAttribute('src'); $('preview-box').hidden = true; $('dropzone').hidden = false;
  $('filename').textContent = demo ? 'ImgSteg-demo.png' : file.name; $('dimensions').textContent = '读取中'; $('state').textContent = '读取中';
  $('detection').textContent = '正在识别 ImgSteg 标记…'; $('detection').classList.remove('error');
  status('正在读取图片…', false, 0); setBusy(true);
  try { makeWorker(); loadId = ++request; worker.postMessage({ id: loadId, action: 'load', file, demo }); }
  catch (error) { setBusy(false); status(error.message, true); }
}
function receive(data) {
  if (data.action === 'diff-preview') {
    if (data.revision !== revision || data.nodeId !== activeDifferenceId || creationKind !== 'difference' || rawPreview || mode !== 'encode') return;
    if (data.error) { status(data.error, true); $('diff-status').textContent = data.error; return; }
    const node = activeDifference(); if (!node) return;
    node.count = data.count; node.missing = data.missing; node.chunk = data.chunk;
    if (node.policy !== 'manual') { node.regions = data.boxes.map(r => ({ ...r, mode: 'mosaic' })); regions = node.regions; selectedIndex = -1; }
    if (previewURL) URL.revokeObjectURL(previewURL); previewURL = URL.createObjectURL(data.blob); $('preview').src = previewURL;
    const stats = data.chunk?.stats;
    $('diff-status').textContent = `差异 ${format(data.count)} 像素 · 未覆盖 ${format(data.missing)} 像素 · ${data.boxes.length} 个框${stats ? `；${stats.total} 个分块，变化 ${stats.active}，收缩 ${stats.shrunk}，未收缩 ${stats.unshrunk} → ${stats.retained} 个矩形（合并减少 ${stats.saved} 个）` : ''}`;
    $('diff-status').classList.toggle('error', data.missing > 0); renderRegions(); setBusy(busy); return;
  }
  if (data.action === 'preview') {
    if (data.error) { if (data.revision === revision) status(data.error, true); return; }
    if (data.done && data.revision === revision && image && mode === 'encode' && creationKind === 'cover' && !baseOriginalPreview && (rawPreview || $('show-fill').checked)) { if (previewURL) URL.revokeObjectURL(previewURL); previewURL = URL.createObjectURL(data.blob); $('preview').src = previewURL; }
    return;
  }
  if (data.id !== (data.action === 'load' ? loadId : taskId)) return;
  if (data.error) { setBusy(false); if (data.action === 'diff-manual') renderDifferences(); $('state').textContent = '处理失败'; status(data.error, true, 0); return; }
  if (!data.done) { status(data.message, false, data.progress); return; }
  setBusy(false);
  if (data.action === 'build' || data.action === 'analyze') {
    displayedKey = taskKey; displayedAction = data.action;
    if (!data.cached) resultCache.set(data.action, { key: taskKey, data });
  }
  if (data.action === 'load') {
    image = { w: data.w, h: data.h, detected: data.detected };
    sourceURL = URL.createObjectURL(data.blob); $('preview').src = sourceURL;
    $('preview-box').hidden = false; $('dropzone').hidden = true;
    $('selection-overlay').setAttribute('viewBox', `0 0 ${data.w} ${data.h}`);
    $('dimensions').textContent = `${format(data.w)} × ${format(data.h)} px`; $('source-info').textContent = data.source;
    $('detection').textContent = data.detectionError || (data.detected ? (mode === 'decode' ? '发现 ImgSteg 标记，正在自动提取并校验。' : '发现 ImgSteg 标记，可切换到“识别与还原”提取内容。') : '未发现本项目的 ImgSteg v1/v2/v3/v4/v5/v6 标记。');
    $('detection').classList.toggle('error', Boolean(data.detectionError));
    $('state').textContent = '就绪'; $('result-note').textContent = mode === 'decode' ? (data.detected ? '已识别隐写标记，正在提取恢复数据。' : '此图片未发现本项目的隐写格式。') : '框选区域、填写文字后，点击“计算并生成隐写 PNG”。';
    status('可在图片上拖出多个矩形选区。', false, 0); setBusy(false); renderRegions();
    renderDifferences(); updateCreationView();
    if (queuedDifferences.length) { const files = queuedDifferences; queuedDifferences = []; addDifferences(files); }
    if (mode === 'decode' && data.detected) startTask('restore');
  } else if (data.action === 'rebase') {
    const chosen = differences.find(node => node.id === data.nodeId);
    const next = differenceEngine.reroot(differences, chosen.id);
    const oldName = $('filename').textContent, oldURL = sourceURL;
    sourceURL = chosen.previewURL; $('filename').textContent = chosen.name;
    const previous = next.find(node => node.id === chosen.id); previous.name = oldName; previous.previewURL = oldURL;
    differences = next; image.detected = data.detected; $('source-info').textContent = data.source;
    $('detection').textContent = data.detected ? '发现 ImgSteg 标记，可切换到识别与还原。' : '未发现本项目的 ImgSteg v1/v2/v3/v4/v5/v6 标记。'; $('detection').classList.remove('error');
    resultCache.clear(); displayedKey = displayedAction = ''; editDifference(null); changed(); $('state').textContent = '已切换基底'; status('已重定向父本路径并迁移遮盖；图片、附图与文字均保留，无需重新上传。', false, 100);
  } else if (data.action === 'diff-manual') {
    const node = differences.find(item => item.id === data.nodeId); if (!node) return;
    node.policy = 'manual'; node.regions = data.boxes.map(r => ({ ...r, mode: 'mosaic' })); node.missing = 0;
    if (activeDifferenceId === node.id) { regions = node.regions; selectedIndex = -1; }
    changed(); updateCreationView(); $('state').textContent = '待计算';
  } else if (data.action === 'diff-upload') {
    for (const { previewBlob, ...item } of data.items) differences.push({ ...item, parentId: 'base', policy: 'auto', regions: [], previewURL: URL.createObjectURL(previewBlob) });
    renderDifferences(); editDifference(data.items[0]?.id || null); changed(); status(`已添加 ${data.items.length} 张差分图，可为每张选择父本与编码方式。`, false, 100);
  } else if (data.action === 'attachments') {
    for (const item of data.items) { const { previewBlob, ...metadata } = item; attachments.push({ ...metadata, previewURL: URL.createObjectURL(previewBlob) }); }
    renderAttachments(); changed(false); status(`已按上传顺序添加 ${data.items.length} 张图片，可拖动调整顺序。`, false, 100);
  } else if (data.action === 'analyze') {
    showMetrics(data.w, data.h, data.bytes.length, data.method, '仅分析 i2 的低位压缩空间，尚未计入选区、文字和隐写文件头。');
    const url = outputURL(new Blob([data.bytes], { type: 'application/octet-stream' }));
    $('download').disabled = false; $('download').textContent = '下载低位压缩内容 ↓'; $('download').onclick = () => save(url, 'i2.lsb3');
    $('state').textContent = '分析完成'; status(data.cached ? '已复用上次低位分析结果，未重新压缩。' : `已比较 ${data.candidates} 个低位候选方案，往返校验通过。`, false, 100);
  } else if (data.action === 'build') {
    if (mode === 'encode' && creationKind === 'cover' && !baseOriginalPreview && (rawPreview || $('show-fill').checked)) { if (previewURL) URL.revokeObjectURL(previewURL); previewURL = URL.createObjectURL(data.baseBlob); $('preview').src = previewURL; }
    const remaining = BigInt(data.w) * BigInt(data.h) * 9n - BigInt(data.bytes.length) * 8n;
    showMetrics(data.w, data.h, data.bytes.length, '各分块独立择优，详情见下方', data.fits ? '全部恢复数据与文字均可装入，已生成并验证隐写 PNG。' : `容量不足，超出 ${format(-remaining)} bit；请缩小选区、减少文字或更换图片。`);
    for (const item of data.methods) { const row = document.createElement('li'); row.textContent = `${item.label}：${item.method} · ${format(item.bytes)} byte${item.sparse ? `（比整框节省 ${format(item.denseBytes - item.bytes)} byte）` : ''}`; $('compression-details').append(row); }
    const overhead = data.bytes.length - data.methods.reduce((sum, item) => sum + item.bytes, 0);
    const row = document.createElement('li'); row.textContent = `容器头、选区与附加图片记录：${format(overhead)} byte`; $('compression-details').append(row);
    $('generated').hidden = false; attachDownload('download-base', data.baseBlob, 'ImgSteg-i2.png');
    $('steg-result').hidden = !data.fits; $('overflow-result').hidden = data.fits;
    if (data.fits) {
      $('steg-preview').src = attachDownload('download-steg', data.carrierBlob, 'ImgSteg-hidden.png');
      $('quick-download').href = $('download-steg').href; $('quick-download').download = 'ImgSteg-hidden.png'; $('quick-download').hidden = false;
      $('restore-generated').onclick = () => { openFile(new File([data.carrierBlob], 'ImgSteg-hidden.png', { type: 'image/png' })); setMode('decode'); };
      $('state').textContent = '生成成功'; status(data.cached ? '已复用上次完整结果，配置未改变，无需重新计算。' : '已从导出 PNG 验证原图、i2、差分图、附图和文字；可展开查看结果。', false, 100);
    }
    else { $('state').textContent = '容量不足'; status('没有写入隐写内容。i2 底图仍可下载；缩小选区后重试。', true, 100); }
  } else if (data.action === 'restore') {
    if (!data.detected) { $('state').textContent = '未识别'; status('未发现本项目格式的隐写内容。', false, 100); return; }
    showMetrics(data.w, data.h, data.length, '已解码并校验全部分块', '已完整还原原图、底图 i2、差分图、附图和文字。');
    $('detection').textContent = `已识别 ImgSteg v${data.version}，全部恢复数据校验通过。`;
    $('restored').hidden = false;
    $('original-output').src = attachDownload('download-original', data.originalBlob, 'ImgSteg-original.png');
    $('base-output').src = attachDownload('download-restored-base', data.baseBlob, 'ImgSteg-i2.png');
    $('decoded-text').value = data.text; $('decode-text-box').hidden = false;
    attachDownload('download-text', new Blob([data.text], { type: 'text/plain;charset=utf-8' }), 'ImgSteg-message.txt');
    $('text-summary').textContent = data.text ? `${format(new TextEncoder().encode(data.text).length)} UTF-8 byte` : '未附加文字';
    $('decoded-differences-box').hidden = !data.differences.length; $('decoded-difference-count').textContent = `${data.differences.length} 张`;
    for (const item of data.differences) {
      const row = document.createElement('li'), preview = document.createElement('img'), link = document.createElement('a'), caption = document.createElement('p');
      preview.alt = `还原的差分图：${item.name}`; preview.src = outputURL(item.blob); link.href = preview.src; link.download = safeFilename(item.name.replace(/\.[^.]+$/, '') + '.png'); link.className = 'download-link'; link.textContent = `下载 ${item.name} ↓`;
      caption.className = 'hint'; const parent = data.differences.find(node => node.id === item.parentId); caption.textContent = `父本：${parent ? parent.name : data.version >= 4 ? '未遮盖基底（原图）' : '基底 i2'}`;
      row.append(preview, link, caption); $('decoded-differences').append(row);
    }
    $('decoded-attachments-box').hidden = false; $('decoded-attachment-count').textContent = `${data.attachments.length} 张（按存放顺序）`;
    for (const [index, item] of data.attachments.entries()) {
      const row = document.createElement('li'), preview = document.createElement('img'), link = document.createElement('a');
      preview.alt = `附加图片 ${index + 1}：${item.name}`; preview.src = outputURL(item.blob);
      link.href = preview.src; link.download = safeFilename(item.name); link.className = 'download-link'; link.textContent = `${index + 1}. 下载 ${item.name} ↓`;
      row.append(preview, link); $('decoded-attachments').append(row);
    }
    $('state').textContent = '还原成功'; status(`已恢复 ${data.differences.length} 张差分图、${data.attachments.length} 张附图、原图、i2 及文字；展开查看。`, false, 100);
  }
}
function changed(preview = true) {
  renderDifferences();
  if (preview) revision++;
  if (displayedKey && displayedKey === configuration(displayedAction)) { if (preview) schedulePreview(); return; }
  resetMetrics(); clearOutputs(); $('state').textContent = '待计算'; $('result-note').textContent = '选区或文字已变更，请重新计算生成。';
  status('内容已变更，等待计算；未变的压缩分块会自动复用。', false, 0);
  if (preview) schedulePreview();
}
function blockSize() { return Math.max(2, Math.min(128, Math.trunc(Number($('block-size').value) || 12))); }
function schedulePreview() {
  clearTimeout(pendingPreview); if (!image || !worker) return;
  if (mode === 'decode') { $('preview').src = sourceURL; return; }
  if (rawPreview) {
    if (activeDifference() || baseOriginalPreview) $('preview').src = activeDifference()?.previewURL || sourceURL;
    else pendingPreview = setTimeout(() => worker.postMessage({ id: ++request, action: 'preview', regions: coverRegions, blockSize: blockSize(), revision }), 150);
    return;
  }
  if (creationKind === 'difference') {
    const node = activeDifference();
    if (!node) { $('preview').src = sourceURL; return; }
    pendingPreview = setTimeout(() => worker.postMessage({ id: ++request, action: 'diff-preview', differences: differenceMetadata(), nodeId: node.id, revision }), 150); return;
  }
  if (!$('show-fill').checked) { $('preview').src = sourceURL; return; }
  pendingPreview = setTimeout(() => worker.postMessage({ id: ++request, action: 'preview', regions, blockSize: blockSize(), revision }), 150);
}
function startTask(action) {
  if (busy || !image) return;
  revision++;
  clearTimeout(pendingPreview); resetMetrics(); clearOutputs();
  setBusy(true); taskId = ++request; $('state').textContent = '处理中'; status('正在启动本地计算…', false, 0);
  taskKey = configuration(action); const cached = resultCache.get(action);
  if (cached?.key === taskKey && (action === 'build' || action === 'analyze')) { receive({ ...cached.data, id: taskId, cached: true }); return; }
  worker.postMessage({ id: taskId, action, regions: coverRegions, text: $('extra-text').value, blockSize: blockSize(), attachmentIds: attachments.map(item => item.id), differences: action === 'build' ? differenceMetadata() : [] });
}
function activeDifference() { return differences.find(node => node.id === activeDifferenceId); }
function regionsEditable() { return Boolean(image && mode === 'encode' && !rawPreview && (creationKind === 'cover' || activeDifference()?.policy === 'manual')); }
function differenceMetadata() { return differences.map(node => ({ id: node.id, name: node.name, parentId: node.parentId, policy: node.policy, regions: node.regions.map(({ x, y, w, h }) => ({ x, y, w, h })) })); }
function configuration(action) {
  const base = { action, regions: coverRegions, blockSize: blockSize() };
  if (action === 'build') {
    base.text = $('extra-text').value; base.attachments = attachments.map(item => item.id);
    base.differences = differenceMetadata().map(node => ({ ...node, regions: node.policy === 'manual' ? node.regions : [] }));
  }
  return JSON.stringify(base);
}
function clearDifferences() {
  for (const node of differences) URL.revokeObjectURL(node.previewURL);
  differences = []; activeDifferenceId = null; $('difference-list').replaceChildren();
  $('diff-status').textContent = '选择一张差分图查看与父本的差异。'; $('diff-status').classList.remove('error');
}
function updateCreationView() {
  document.body.dataset.creation = creationKind;
  $('difference-controls').hidden = false;
  $('show-fill-label').hidden = creationKind !== 'cover' || rawPreview || mode !== 'encode';
  const node = activeDifference();
  $('editor-context').textContent = rawPreview ? (node ? `原色预览：${node.name}（点击编辑修改选区）` : baseOriginalPreview ? '基底原图预览（未遮盖）' : '遮盖底图 i2 预览（点击编辑遮盖修改选区）') : creationKind === 'cover' ? '编辑遮盖选区；预览填充后的底图 i2。' : node ? `差分预览：${node.name} ← ${node.parentId === 'base' ? '未遮盖基底' : differences.find(item => item.id === node.parentId)?.name}` : '编辑基底遮盖。';
  if (!node) { $('diff-status').textContent = '基底图：可同时添加遮盖和差分图。'; $('diff-status').classList.remove('error'); }
  if (rawPreview) { $('diff-status').textContent = node ? '原色预览：不显示差异蒙层与选框。' : baseOriginalPreview ? '基底原图预览：不显示遮盖与选框。' : '底图 i2 预览：显示遮盖结果。'; $('diff-status').classList.remove('error'); }
  setBusy(busy); renderRegions(); schedulePreview();
}
function editDifference(id, preview = false, original = false) {
  if (busy) return;
  baseOriginalPreview = original; rawPreview = preview; creationKind = id ? 'difference' : 'cover';
  activeDifferenceId = id; selectedIndex = -1; selectedPart = 'move'; drag = null; revision++;
  regions = activeDifference()?.regions || coverRegions;
  if (activeDifference()) $('preview').src = activeDifference().previewURL; else if (sourceURL) $('preview').src = sourceURL;
  renderDifferences(); updateCreationView();
}
function isRowControl(target) {
  return Boolean(target.closest?.('button, input, select, textarea, option, a, label, summary, [role="button"], [contenteditable]'));
}
function thumbnailWithBaseButton(thumb, node) {
  const column = document.createElement('div'), button = document.createElement('button'); column.className = 'difference-thumb';
  button.textContent = '选为基底图'; button.className = 'text-button'; button.disabled = busy || !node;
  button.dataset.unavailable = String(!node); button.setAttribute('aria-label', node ? `选为基底图：${node.name}` : '当前基底图');
  if (node) button.onclick = () => selectBase(node.id);
  column.append(thumb, button); return column;
}
function selectBase(id) {
  if (busy || !image) return;
  try { differenceEngine.reroot(differences, id); } catch (error) { status(error.message, true); return; }
  clearTimeout(pendingPreview); revision++; setBusy(true); taskId = ++request;
  $('state').textContent = '切换基底'; status('正在切换基底与父本方向…', false, 0);
  worker.postMessage({ action: 'rebase', id: taskId, nodeId: id, oldName: $('filename').textContent });
}
function renderDifferences() {
  $('difference-list').replaceChildren();
  if (image) {
    const row = document.createElement('li'), thumb = document.createElement('img'), fields = document.createElement('div'), title = document.createElement('strong'), note = document.createElement('p'), buttons = document.createElement('div');
    row.className = 'clickable-row'; row.classList.toggle('active-difference', !activeDifferenceId); thumb.src = sourceURL; thumb.alt = '基底图'; title.textContent = `基底 · ${$('filename').textContent}`; note.className = 'hint'; note.textContent = coverRegions.length ? `父本：遮盖版 i2（不可选择） · ${coverRegions.length} 个遮盖选区` : '基底图 · 可添加遮盖'; fields.append(title, note); buttons.className = 'difference-actions';
    for (const [label, preview, original] of [['原图预览', true, true], ['遮盖预览', true, false], ['编辑遮盖', false, false]]) { const button = document.createElement('button'); button.textContent = label; button.className = 'text-button'; button.disabled = busy; button.onclick = () => editDifference(null, preview, original); buttons.append(button); }
    row.onclick = event => { if (!isRowControl(event.target)) editDifference(null, true); }; row.append(thumbnailWithBaseButton(thumb, null), fields, buttons); $('difference-list').append(row);
  }
  differences.forEach((node, index) => {
    const row = document.createElement('li'); row.classList.toggle('active-difference', node.id === activeDifferenceId);
    row.classList.toggle('clickable-row', !busy);
    row.addEventListener('click', event => { if (!busy && !isRowControl(event.target)) editDifference(node.id, true); });
    const thumb = document.createElement('img'); thumb.src = node.previewURL; thumb.alt = node.name;
    const fields = document.createElement('div'), title = document.createElement('strong'); title.textContent = `${index + 1}. ${node.name}`; fields.append(title);
    const parentLabel = document.createElement('label'); parentLabel.textContent = '父本 ';
    const parent = document.createElement('select'); parent.setAttribute('aria-label', `差分图 ${index + 1} 父本`);
    for (const candidate of [{ id: 'base', name: '基底（未遮盖）' }, ...differences.filter(item => item.id !== node.id)]) {
      const option = document.createElement('option'); option.value = candidate.id; option.textContent = candidate.name;
      try { differenceEngine.graph(differences.map(item => ({ ...item, parentId: item.id === node.id ? candidate.id : item.parentId }))); } catch { option.disabled = true; }
      parent.append(option);
    }
    parent.value = node.parentId; parent.disabled = busy;
    parent.onchange = () => {
      const next = parent.value;
      try { differenceEngine.graph(differences.map(item => ({ ...item, parentId: item.id === node.id ? next : item.parentId }))); }
      catch (error) { parent.value = node.parentId; status(error.message, true); return; }
      node.parentId = next; node.missing = undefined; selectedIndex = -1; renderDifferences(); changed(); updateCreationView();
    };
    parentLabel.append(parent);
    const policyLabel = document.createElement('label'); policyLabel.textContent = '编码 ';
    const policy = document.createElement('select'); policy.setAttribute('aria-label', `差分图 ${index + 1} 编码方式`);
    for (const [value, text] of [['auto', '自动框选（≤20）'], ['chunk', '32×32 分块自动'], ['manual', '手动框选'], ['full', '全图 XOR']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; policy.append(option); }
    policy.value = node.policy; policy.disabled = busy;
    policy.onchange = () => {
      if (node.policy === 'auto' && policy.value === 'manual') {
        clearTimeout(pendingPreview); revision++; setBusy(true); taskId = ++request;
        $('state').textContent = '保留自动选框'; status('正在保留当前父本对应的自动选框…', false, 0);
        worker.postMessage({ action: 'diff-manual', id: taskId, nodeId: node.id, differences: differenceMetadata() }); return;
      }
      node.policy = policy.value; node.regions = []; node.missing = undefined; if (node.id === activeDifferenceId) { regions = node.regions; selectedIndex = -1; } renderDifferences(); changed(); updateCreationView(); };
    policyLabel.append(policy); fields.append(parentLabel, policyLabel);
    const buttons = document.createElement('div'), view = document.createElement('button'), edit = document.createElement('button'), remove = document.createElement('button'); buttons.className = 'difference-actions';
    view.textContent = '预览'; view.className = 'text-button'; view.disabled = busy; view.setAttribute('aria-label', `预览差分图 ${index + 1}`); view.onclick = () => editDifference(node.id, true);
    edit.textContent = node.policy === 'chunk' ? '分块预览' : node.id === activeDifferenceId && !rawPreview ? '正在编辑' : '编辑'; edit.className = 'text-button'; edit.setAttribute('aria-label', node.policy === 'chunk' ? `查看分块差分图 ${index + 1}` : `编辑差分图 ${index + 1}`); edit.disabled = busy; edit.onclick = () => editDifference(node.id);
    remove.textContent = '移除'; remove.className = 'text-button'; remove.disabled = busy; remove.setAttribute('aria-label', `移除差分图 ${index + 1}`);
    remove.onclick = () => {
      URL.revokeObjectURL(node.previewURL); differences.splice(index, 1);
      for (const child of differences) if (child.parentId === node.id) { child.parentId = 'base'; child.missing = undefined; }
      worker?.postMessage({ action: 'forget-difference', differenceId: node.id, id: ++request });
      if (activeDifferenceId === node.id) { activeDifferenceId = null; creationKind = 'cover'; rawPreview = false; }
      regions = activeDifference()?.regions || coverRegions; selectedIndex = -1; renderDifferences(); changed(); updateCreationView();
    };
    buttons.append(view, edit, remove); row.append(thumbnailWithBaseButton(thumb, node), fields, buttons); $('difference-list').append(row);
  });
}
function addDifferences(files) {
  if (busy || !files.length) return;
  if (!image) { importImages(files, true); return; }
  if (files.length + differences.length > 16 || (files.length + differences.length) * image.w * image.h > 40000000) { status('最多 16 张差分图，合计最多 4000 万像素。', true); return; }
  clearTimeout(pendingPreview); resetMetrics(); clearOutputs(); setBusy(true); taskId = ++request;
  $('state').textContent = '读取差分图'; status('正在检查差分图尺寸…', false, 0); worker.postMessage({ action: 'diff-upload', id: taskId, files });
}
function setResultsOpen(open) {
  $('capacity-details').hidden = !open; $('toggle-results').setAttribute('aria-expanded', String(open)); $('toggle-results').textContent = open ? '收起明细 ▾' : '容量与结果 ▴';
}
function applySettings() {
  let settings = { mode: 'system', hue: 270 };
  try { const saved = JSON.parse(localStorage.getItem('ImgSteg.settings.v1')); if (saved && ['system', 'light', 'dark'].includes(saved.mode) && Number.isFinite(saved.hue)) settings = { mode: saved.mode, hue: Math.max(0, Math.min(360, saved.hue)) }; } catch { /* localStorage may be unavailable. */ }
  const system = matchMedia('(prefers-color-scheme: dark)');
  function paint() {
    document.documentElement.dataset.theme = settings.mode === 'system' ? (system.matches ? 'dark' : 'light') : settings.mode;
    document.documentElement.style.setProperty('--hue', settings.hue); $('theme-mode').value = settings.mode; $('theme-hue').value = settings.hue; $('hue-value').textContent = `${settings.hue}°`;
  }
  function saveSettings() { paint(); try { localStorage.setItem('ImgSteg.settings.v1', JSON.stringify(settings)); } catch { /* Keep session preferences. */ } }
  $('theme-mode').onchange = () => { settings.mode = $('theme-mode').value; saveSettings(); };
  $('theme-hue').oninput = () => { settings.hue = Number($('theme-hue').value); saveSettings(); };
  system.addEventListener('change', paint); paint();
}
function safeFilename(name) { return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'image'; }
function clearAttachments() {
  for (const item of attachments) URL.revokeObjectURL(item.previewURL);
  attachments = []; dragAttachmentId = null; renderAttachments();
}
function reorderAttachment(id, targetId, after = false) {
  if (busy || id === targetId) return;
  const from = attachments.findIndex(item => item.id === id), target = attachments.findIndex(item => item.id === targetId);
  if (from < 0 || target < 0) return;
  const [item] = attachments.splice(from, 1), to = attachments.findIndex(item => item.id === targetId);
  attachments.splice(to + (after ? 1 : 0), 0, item); renderAttachments(); changed(false);
}
function renderAttachments() {
  $('attachment-list').replaceChildren();
  const total = attachments.reduce((sum, item) => sum + item.size, 0);
  $('attachment-count').textContent = `${attachments.length} 张 · ${format(total)} byte`;
  attachments.forEach((item, index) => {
    const row = document.createElement('li'); row.draggable = !busy; row.dataset.attachmentId = item.id;
    const preview = document.createElement('img'); preview.src = item.previewURL; preview.alt = item.name; preview.draggable = false;
    const info = document.createElement('div'), title = document.createElement('strong'), description = document.createElement('span');
    title.textContent = `${index + 1}. ${item.name}`; description.textContent = `${item.w} × ${item.h} · ${format(item.size)} byte`; info.append(title, description);
    const actions = document.createElement('div'); actions.className = 'attachment-actions';
    for (const [action, label, unavailable] of [['up', '上移', index === 0], ['down', '下移', index === attachments.length - 1], ['remove', '移除', false]]) {
      const button = document.createElement('button'); button.className = 'text-button'; button.textContent = label; button.setAttribute('aria-label', `${label}附加图片 ${index + 1}`); button.dataset.unavailable = String(unavailable); button.disabled = busy || unavailable;
      button.onclick = () => {
        if (action === 'remove') {
          URL.revokeObjectURL(item.previewURL); attachments.splice(index, 1); worker?.postMessage({ action: 'forget-attachment', attachmentId: item.id, id: ++request }); renderAttachments(); changed(false);
        } else reorderAttachment(item.id, attachments[index + (action === 'up' ? -1 : 1)].id, action === 'down');
      }; actions.append(button);
    }
    row.addEventListener('dragstart', event => {
      if (busy) { event.preventDefault(); return; }
      dragAttachmentId = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-imgsteg-attachment', item.id); row.classList.add('dragging');
    });
    row.addEventListener('dragover', event => { if (dragAttachmentId) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; row.classList.add('drop-target'); } });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', event => {
      if (!dragAttachmentId) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = row.getBoundingClientRect(); reorderAttachment(dragAttachmentId, item.id, event.clientY > bounds.top + bounds.height / 2); dragAttachmentId = null;
    });
    row.addEventListener('dragend', () => { dragAttachmentId = null; for (const item of $('attachment-list').children) item.classList.remove('dragging', 'drop-target'); });
    row.append(preview, info, actions); $('attachment-list').append(row);
  });
}
function addAttachments(files) {
  if (busy || !image || !files.length) return;
  if (attachments.length + files.length > 32 || attachments.reduce((sum, item) => sum + item.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024) { status('最多附加 32 张图片，原文件总大小最多为 32 MiB。', true); return; }
  clearTimeout(pendingPreview); resetMetrics(); clearOutputs(); setBusy(true); taskId = ++request;
  $('state').textContent = '读取附加图片'; status('正在验证附加图片…', false, 0); worker.postMessage({ action: 'attachments', id: taskId, files });
}
function selectRegion(index, part = 'move', focus = true) {
  selectedIndex = index; selectedPart = part; renderRegions();
  if (focus) $('selection-overlay').focus({ preventScroll: true });
}
function syncRegionFields(index) {
  const r = regions[index], row = $('region-list').children[index];
  if (!r || !row) return;
  for (const input of row.querySelectorAll('input')) {
    const key = input.dataset.coordinate; input.value = r[key];
    input.max = String(key === 'x' ? image.w - 1 : key === 'y' ? image.h - 1 : key === 'w' ? image.w - r.x : image.h - r.y);
  }
}
function applyGeometry(rect) {
  const current = regions[selectedIndex];
  if (!current || ['x', 'y', 'w', 'h'].every(key => current[key] === rect[key])) return;
  Object.assign(current, rect); syncRegionFields(selectedIndex); changed(); renderOverlay();
}
function renderOverlay(draft) {
  const overlay = $('selection-overlay'); overlay.replaceChildren();
  if (rawPreview) return;
  const chunkMode = activeDifference()?.policy === 'chunk', grid = activeDifference()?.chunk?.grid;
  if (chunkMode && grid) {
    for (const x of grid.xs) { const line = document.createElementNS(svgNS, 'line'); line.setAttribute('x1', x); line.setAttribute('x2', x); line.setAttribute('y1', 0); line.setAttribute('y2', image.h); line.setAttribute('class', 'chunk-grid'); overlay.append(line); }
    for (const y of grid.ys) { const line = document.createElementNS(svgNS, 'line'); line.setAttribute('x1', 0); line.setAttribute('x2', image.w); line.setAttribute('y1', y); line.setAttribute('y2', y); line.setAttribute('class', 'chunk-grid'); overlay.append(line); }
  }
  [...regions, ...(draft ? [draft] : [])].forEach((r, index) => {
    const rect = document.createElementNS(svgNS, 'rect');
    for (const [name, value] of Object.entries({ x: r.x, y: r.y, width: r.w, height: r.h })) rect.setAttribute(name, value);
    rect.setAttribute('class', `selection-rect${chunkMode ? ` chunk-box chunk-${r.kind || 'cell'}` : ''}`); overlay.append(rect);
    if (chunkMode) { const title = document.createElementNS(svgNS, 'title'); title.textContent = `${r.kind === 'shrunk' ? '收缩' : r.kind === 'merged' ? `合并 ${r.cells} 块` : '未收缩'}：${r.x}, ${r.y} · ${r.w} × ${r.h}`; rect.append(title); return; }
    const text = document.createElementNS(svgNS, 'text'); text.setAttribute('x', r.x + 3); text.setAttribute('y', r.y + 3); text.setAttribute('class', 'selection-number'); text.setAttribute('font-size', image ? Math.max(image.w / 55, 8) : 10); text.textContent = index + 1; overlay.append(text);
  });
  if (chunkMode) { $('selection-help').textContent = '分块模式只读：灰线为原始网格，橙色为收缩框，绿色为合并框，紫色为未收缩单块；不提供手动画框或调整。'; return; }
  if (regions[selectedIndex]) {
    const r = regions[selectedIndex], bounds = overlay.getBoundingClientRect();
    const hx = image.w / Math.max(bounds.width, 1) * 4.5, hy = image.h / Math.max(bounds.height, 1) * 4.5;
    const outline = document.createElementNS(svgNS, 'rect');
    for (const [key, value] of Object.entries({ x: r.x, y: r.y, width: r.w, height: r.h })) outline.setAttribute(key, value);
    outline.setAttribute('class', 'selected-outline'); overlay.append(outline);
    for (const [part, [x, y]] of Object.entries(rectEditor.handles(r))) {
      const handle = document.createElementNS(svgNS, 'rect');
      for (const [key, value] of Object.entries({ x: x - hx, y: y - hy, width: hx * 2, height: hy * 2 })) handle.setAttribute(key, value);
      handle.setAttribute('class', `selection-handle${part === selectedPart ? ' active' : ''}`); handle.dataset.part = part;
      handle.setAttribute('aria-label', `选区 ${selectedIndex + 1} ${rectEditor.labels[part]}控制点`); overlay.append(handle);
    }
    $('selection-help').textContent = `已选中选区 ${selectedIndex + 1} · ${rectEditor.labels[selectedPart]}。方向键每次调整 1 像素${['n', 's'].includes(selectedPart) ? '，仅上下键生效' : ['w', 'e'].includes(selectedPart) ? '，仅左右键生效' : ''}；Esc 取消选中。`;
  } else $('selection-help').textContent = '双击选框以选中；拖动内部移动，拖动边或角缩放。方向键每次微调 1 像素；Esc 取消选中后可继续画框。';
  if (rawPreview) $('selection-help').textContent = '原色预览模式；点击编辑可修改选区。';
  else if (creationKind === 'difference' && !regionsEditable()) $('selection-help').textContent = activeDifference() ? '自动框选与全图 XOR 的选框只读；切换到手动框选后可编辑。' : '请先选择一张差分图进行预览或框选。';
}
function renderRegions() {
  const chunkMode = activeDifference()?.policy === 'chunk';
  $('chunk-legend').hidden = !chunkMode || rawPreview; $('region-buttons').hidden = chunkMode;
  $('region-list').replaceChildren(); $('region-count').textContent = chunkMode ? `${regions.length} 个自动矩形` : `${regions.length} 个选区`; $('no-regions').hidden = regions.length !== 0;
  if (chunkMode) { $('no-regions').hidden = true; if (rawPreview) $('selection-help').textContent = '原色预览模式；点击分块预览查看收缩与合并结果。'; renderOverlay(); return; }
  regions.forEach((r, index) => {
    const row = document.createElement('li'), title = document.createElement('div'); title.className = 'region-title'; row.classList.toggle('selected-region', index === selectedIndex);
    row.classList.toggle('clickable-row', !busy && regionsEditable());
    row.addEventListener('click', event => { if (!busy && regionsEditable() && !isRowControl(event.target)) selectRegion(index); });
    const label = document.createElement('strong'); label.textContent = `选区 ${index + 1}`; title.append(label);
    const select = document.createElement('select'); select.setAttribute('aria-label', `选区 ${index + 1} 填充方式`);
    for (const [value, text] of [['mosaic', '马赛克'], ['white', '纯白'], ['black', '纯黑']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
    select.value = r.mode; select.disabled = busy || !regionsEditable(); select.onchange = () => { r.mode = select.value; changed(); };
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = '删除'; remove.disabled = busy || !regionsEditable(); remove.setAttribute('aria-label', `删除选区 ${index + 1}`);
    remove.onclick = () => { regions.splice(index, 1); if (selectedIndex === index) selectedIndex = -1; else if (selectedIndex > index) selectedIndex--; changed(); renderRegions(); };
    const pick = document.createElement('button'); pick.className = 'text-button'; pick.textContent = index === selectedIndex ? '已选中' : '选中'; pick.setAttribute('aria-label', `选中选区 ${index + 1}`); pick.disabled = busy || !regionsEditable(); pick.onclick = () => selectRegion(index);
    title.append(select, pick, remove); row.append(title);
    const fields = document.createElement('div'); fields.className = 'region-fields';
    for (const [key, text] of [['x', 'X'], ['y', 'Y'], ['w', '宽'], ['h', '高']]) {
      const field = document.createElement('label'), caption = document.createElement('span'), input = document.createElement('input'); caption.textContent = text;
      input.type = 'number'; input.step = '1'; input.dataset.coordinate = key; input.min = key === 'x' || key === 'y' ? '0' : '1'; input.max = String(key === 'x' ? image.w - 1 : key === 'y' ? image.h - 1 : key === 'w' ? image.w - r.x : image.h - r.y); input.value = r[key]; input.disabled = busy || !regionsEditable(); input.setAttribute('aria-label', `选区 ${index + 1} ${text}`);
      input.oninput = () => {
        const value = Number(input.value);
        if (input.value === '' || !Number.isInteger(value) || value < Number(input.min) || value > Number(input.max)) return;
        r[key] = value; r.w = Math.min(r.w, image.w - r.x); r.h = Math.min(r.h, image.h - r.y);
        for (const field of row.querySelectorAll('input')) {
          const coordinate = field.dataset.coordinate;
          field.max = String(coordinate === 'x' ? image.w - 1 : coordinate === 'y' ? image.h - 1 : coordinate === 'w' ? image.w - r.x : image.h - r.y);
          if (field !== input) field.value = r[coordinate];
        }
        changed(); renderOverlay();
      };
      input.onblur = () => { input.value = r[key]; };
      field.append(caption, input); fields.append(field);
    }
    row.append(fields); $('region-list').append(row);
  }); renderOverlay();
}
function setMode(next) {
  mode = next;
  for (const current of ['encode', 'decode']) { $(`tab-${current}`).setAttribute('aria-selected', String(current === mode)); $(`${current}-controls`).hidden = current !== mode; }
  $('selection-overlay').hidden = mode === 'decode'; updateCreationView();
  if (mode === 'decode' && image?.detected && !busy) startTask('restore');
}
function point(event) {
  const bounds = $('selection-overlay').getBoundingClientRect();
  return { x: Math.max(0, Math.min(image.w, Math.floor((event.clientX - bounds.left) / bounds.width * image.w))), y: Math.max(0, Math.min(image.h, Math.floor((event.clientY - bounds.top) / bounds.height * image.h))) };
}
function draftRegion(start, end) { return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y), mode: $('new-fill').value }; }
function hitSelected(p) {
  if (!image || !regions[selectedIndex]) return null;
  const bounds = $('selection-overlay').getBoundingClientRect();
  return rectEditor.hit(regions[selectedIndex], p, 8 * image.w / Math.max(1, bounds.width), 8 * image.h / Math.max(1, bounds.height));
}
$('selection-overlay').addEventListener('dblclick', event => {
  if (!regionsEditable() || busy) return;
  event.preventDefault(); drag = null; selectRegion(rectEditor.topmost(regions, point(event)));
});
$('selection-overlay').addEventListener('pointerdown', event => {
  if (!regionsEditable() || busy || (event.pointerType === 'mouse' && event.button !== 0)) return;
  const p = point(event), part = hitSelected(p);
  if (!part && regions.length >= 64) { status('最多支持 64 个选区。', true); return; }
  event.preventDefault(); $('selection-overlay').focus({ preventScroll: true });
  if (part) {
    selectedPart = part; drag = { kind: 'edit', start: p, original: { ...regions[selectedIndex] }, part, pointerId: event.pointerId }; renderOverlay();
  } else {
    selectedIndex = -1; selectedPart = 'move'; drag = { kind: 'create', start: p, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId }; renderRegions();
  }
  $('selection-overlay').setPointerCapture(event.pointerId);
});
$('selection-overlay').addEventListener('pointermove', event => {
  if (!regionsEditable() || busy) return;
  const p = point(event);
  if (drag?.pointerId === event.pointerId) {
    if (drag.kind === 'create') renderOverlay(draftRegion(drag.start, p));
    else applyGeometry(rectEditor.adjust(drag.original, drag.part, p.x - drag.start.x, p.y - drag.start.y, image.w, image.h));
  } else {
    const part = hitSelected(p); $('selection-overlay').style.cursor = !part ? 'crosshair' : part === 'move' ? 'move' : `${part}-resize`;
  }
});
$('selection-overlay').addEventListener('pointerup', event => {
  if (drag?.pointerId !== event.pointerId) return;
  const current = drag; drag = null;
  if (current.kind === 'create' && Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) >= 2) {
    const r = draftRegion(current.start, point(event)); if (r.w && r.h) { regions.push(r); selectedIndex = regions.length - 1; selectedPart = 'move'; changed(); }
  } else if (current.kind === 'edit') {
    const p = point(event); applyGeometry(rectEditor.adjust(current.original, current.part, p.x - current.start.x, p.y - current.start.y, image.w, image.h));
  }
  renderRegions();
});
$('selection-overlay').addEventListener('keydown', event => {
  if (busy || !regionsEditable() || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Escape') { event.preventDefault(); drag = null; selectRegion(-1); return; }
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!directions[event.key] || !regions[selectedIndex] || drag) return;
  event.preventDefault(); const [dx, dy] = directions[event.key];
  applyGeometry(rectEditor.adjust(regions[selectedIndex], selectedPart, dx, dy, image.w, image.h));
});
for (const name of ['pointercancel', 'lostpointercapture']) $('selection-overlay').addEventListener(name, () => { if (drag) { drag = null; renderOverlay(); } });
$('add-region').onclick = () => { if (!regionsEditable() || busy || regions.length >= 64) return; regions.push({ x: Math.floor(image.w / 4), y: Math.floor(image.h / 4), w: Math.max(1, Math.floor(image.w / 4)), h: Math.max(1, Math.floor(image.h / 4)), mode: $('new-fill').value }); selectedIndex = regions.length - 1; selectedPart = 'move'; changed(); renderRegions(); };
$('clear-regions').onclick = () => { regions.length = 0; selectedIndex = -1; changed(); renderRegions(); };
$('block-size').onchange = () => { $('block-size').value = blockSize(); changed(); };
$('extra-text').oninput = () => { $('text-length').textContent = `${format(new TextEncoder().encode($('extra-text').value).length)} UTF-8 byte`; changed(false); };
$('show-fill').onchange = schedulePreview;
$('tab-encode').onclick = () => setMode('encode'); $('tab-decode').onclick = () => setMode('decode');
$('generate').onclick = () => { closeGenerateMenu(); startTask('build'); }; $('analyze').onclick = () => { closeGenerateMenu(); startTask('analyze'); }; $('restore').onclick = () => startTask('restore');
$('demo').onclick = () => openFile(null, true);
$('add-differences').onclick = () => $('difference-files').click();
$('difference-files').onchange = event => { addDifferences([...event.target.files]); event.target.value = ''; };
$('edit-base').onclick = () => editDifference(null);
$('toggle-results').onclick = () => setResultsOpen($('capacity-details').hidden);
$('add-attachments').onclick = () => $('attachment-files').click();
$('attachment-files').onchange = event => { addAttachments([...event.target.files]); event.target.value = ''; };
$('file').onchange = event => { importImages([...event.target.files], true); event.target.value = ''; };
const imagePreviewPanel = $('image-preview-panel');
let previewDragDepth = 0;
function isFileDrag(event) { return Array.from(event.dataTransfer?.types || []).includes('Files') || Boolean(event.dataTransfer?.files?.length); }
function clearPreviewDrag() { previewDragDepth = 0; imagePreviewPanel.classList.remove('dragover'); $('dropzone').classList.remove('dragover'); }
for (const name of ['dragenter', 'dragover']) imagePreviewPanel.addEventListener(name, event => {
  if (!isFileDrag(event) || dragAttachmentId) return;
  event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
  if (name === 'dragenter') previewDragDepth++;
  imagePreviewPanel.classList.add('dragover'); $('dropzone').classList.add('dragover');
});
imagePreviewPanel.addEventListener('dragleave', () => { if (previewDragDepth > 0 && --previewDragDepth === 0) clearPreviewDrag(); });
imagePreviewPanel.addEventListener('drop', event => {
  if (!isFileDrag(event) || dragAttachmentId) return;
  event.preventDefault(); event.stopPropagation(); clearPreviewDrag(); importImages([...event.dataTransfer.files]);
});
// Outside the preview, reject file drops without opening/navigating to the file.
document.addEventListener('dragover', event => { if (isFileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; } });
document.addEventListener('drop', event => { if (isFileDrag(event)) { event.preventDefault(); clearPreviewDrag(); } });
document.addEventListener('dragend', clearPreviewDrag);
$('cancel').onclick = () => { clearImage(); $('state').textContent = '已取消'; status('计算已取消。可重新选择图片。', false, 0); };
window.addEventListener('beforeunload', () => { if (worker) worker.terminate(); if (sourceURL) URL.revokeObjectURL(sourceURL); if (previewURL) URL.revokeObjectURL(previewURL); for (const item of [...attachments, ...differences]) URL.revokeObjectURL(item.previewURL); for (const url of outputURLs) URL.revokeObjectURL(url); });
window.addEventListener('resize', () => { if (image) renderOverlay(); });
setBusy(false);
applySettings(); updateCreationView();

$('clear-image').onclick = clearImage;
$('generate-menu-toggle').onclick = () => { const open = $('generate-menu').hidden; $('generate-menu').hidden = !open; $('generate-menu-toggle').setAttribute('aria-expanded', String(open)); };
document.addEventListener('click', event => { if (!event.target.closest('.split-action')) closeGenerateMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeGenerateMenu(); });
$('import-add').onclick = () => { const files = pendingBatch; $('image-import-dialog').close(); addDifferences(files); };
$('import-replace').onclick = chooseBatchBase;
$('import-confirm').onclick = () => { const files = pendingBatch; const index = Number(document.querySelector('input[name="batch-base"]:checked')?.value || 0); $('image-import-dialog').close(); replaceBatch(files, index); };
$('import-cancel').onclick = () => $('image-import-dialog').close();
$('image-import-dialog').addEventListener('close', releaseImport);
