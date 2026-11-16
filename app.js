'use strict';
const $ = id => document.getElementById(id), codec = LsbCodec();
const format = n => n.toLocaleString('zh-CN'), svgNS = 'http://www.w3.org/2000/svg';
const rectEditor = RectEditor();
let worker, image, mode = 'encode', regions = [], revision = 0, busy = false, pendingPreview, drag;
let selectedIndex = -1, selectedPart = 'move', attachments = [], dragAttachmentId = null;
let request = 0, taskId = 0, loadId = 0, sourceURL, previewURL;
const outputURLs = new Set();
function workerMain() {
  const codec = LsbCodec(), steg = ImgSteg(), png = PngCodec();
  let image;
  const attachedFiles = new Map();
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
      if (action === 'attachments') {
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
        const result = await codec.encode(codec.extract(base), w, h, progress);
        self.postMessage({ id, action, done: true, w, h, ...result }, [result.bytes.buffer]);
      } else if (action === 'build') {
        const extraImages = [];
        if (new Set(message.attachmentIds).size !== message.attachmentIds.length) throw new Error('附加图片顺序无效');
        for (const attachmentId of message.attachmentIds) {
          const item = attachedFiles.get(attachmentId);
          if (!item) throw new Error('附加图片已失效，请重新上传');
          extraImages.push({ name: item.name, type: item.type, w: item.w, h: item.h, data: new Uint8Array(await item.file.arrayBuffer()) });
        }
        const result = await steg.build(rgba, w, h, message.regions, message.text, message.blockSize, progress, extraImages);
        const baseBlob = await png.encode(result.base, w, h); let carrierBlob;
        if (result.fits) {
          progress({ progress: 93, message: '正在导出无损 PNG，并从导出文件再次验证恢复…' });
          carrierBlob = await png.encode(result.carrier, w, h);
          const saved = await png.decode(new Uint8Array(await carrierBlob.arrayBuffer()));
          const restored = await steg.restore(saved.rgba, w, h);
          if (!steg.equal(restored.original, rgba) || !steg.equal(restored.base, result.base) || restored.text !== message.text || !steg.sameAttachments(restored.attachments, extraImages)) throw new Error('导出 PNG 的恢复校验失败');
        }
        self.postMessage({ id, action, done: true, w, h, fits: result.fits, bytes: result.bytes, baseBlob, carrierBlob, methods: result.methods, textBytes: result.textBytes }, [result.bytes.buffer]);
      } else if (action === 'restore') {
        const result = await steg.restore(rgba, w, h, progress);
        if (!result.detected) { self.postMessage({ id, action, done: true, detected: false }); return; }
        const originalBlob = await png.encode(result.original, w, h), baseBlob = await png.encode(result.base, w, h);
        const extraImages = result.attachments.map(item => ({ name: item.name, type: item.type, w: item.w, h: item.h, blob: new Blob([item.data], { type: item.type }) }));
        self.postMessage({ id, action, done: true, detected: true, w, h, text: result.text, regions: result.regions, originalBlob, baseBlob, attachments: extraImages, version: result.version, length: result.length });
      }
    } catch (error) { self.postMessage({ id, action, revision: message.revision, error: error.message || '处理失败' }); }
  };
}
function makeWorker() {
  const code = `const LsbCodec = ${LsbCodec.toString()}; const ImgSteg = ${ImgSteg.toString()}; const PngCodec = ${PngCodec.toString()}; (${workerMain.toString()})();`;
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
  for (const id of ['generate', 'analyze', 'add-region', 'clear-regions', 'block-size', 'new-fill', 'extra-text', 'add-attachments', 'attachment-files']) $(id).disabled = value || !image;
  $('restore').disabled = value || !image || !image.detected;
  $('selection-overlay').classList.toggle('locked', value);
  for (const input of $('region-list').querySelectorAll('input,select,button')) input.disabled = value;
  for (const button of $('attachment-list').querySelectorAll('button')) button.disabled = value || button.dataset.unavailable === 'true';
  for (const row of $('attachment-list').children) row.draggable = !value;
}
function resetMetrics() {
  $('remaining').innerHTML = '— <small>bit</small>'; $('remaining').classList.remove('error');
  for (const id of ['bytes', 'pixels', 'method']) $(id).textContent = '—';
  for (const id of ['original', 'compressed']) $(id).textContent = '— bit';
  for (const name of ['square', 'standard', 'wide']) { $(`raw-${name}-size`).textContent = '— × —'; $(`raw-${name}-pixels`).textContent = '— 像素'; }
  $('compression-details').replaceChildren(); $('download').disabled = true; $('download').onclick = null;
}
function clearOutputs() {
  for (const url of outputURLs) URL.revokeObjectURL(url); outputURLs.clear();
  for (const id of ['generated', 'restored', 'decode-text-box', 'decoded-attachments-box']) $(id).hidden = true;
  $('decoded-attachments').replaceChildren();
  for (const id of ['steg-preview', 'original-output', 'base-output']) $(id).removeAttribute('src');
  $('decoded-text').value = '';
}
function outputURL(blob) { const url = URL.createObjectURL(blob); outputURLs.add(url); return url; }
function save(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); }
function attachDownload(id, blob, name) { const url = outputURL(blob); $(id).href = url; $(id).download = name; return url; }
function showMetrics(w, h, bytes, method, note) {
  const m = codec.metrics(w, h, bytes);
  $('remaining').replaceChildren(document.createTextNode(format(m.r) + ' '));
  const unit = document.createElement('small'); unit.textContent = 'bit'; $('remaining').append(unit);
  $('remaining').classList.toggle('error', m.r < 0n);
  $('bytes').textContent = format(m.b); $('pixels').textContent = format(m.pixels);
  $('original').textContent = `${format(m.original)} bit`; $('compressed').textContent = `${format(m.n)} bit`; $('method').textContent = method;
  codec.rawSizes(m.pixels).forEach((size, i) => { const name = ['square', 'standard', 'wide'][i]; $(`raw-${name}-size`).textContent = `${format(size.width)} × ${format(size.height)}`; $(`raw-${name}-pixels`).textContent = `${format(size.pixels)} 像素`; });
  $('result-note').textContent = note;
}
function openFile(file, demo = false) {
  if (!file && !demo) return;
  clearTimeout(pendingPreview); if (worker) worker.terminate(); worker = null;
  image = null; regions = []; drag = null; selectedIndex = -1; selectedPart = 'move'; revision++; taskId = 0;
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
  if (data.action === 'preview') {
    if (data.error) { if (data.revision === revision) status(data.error, true); return; }
    if (data.done && data.revision === revision && image && mode === 'encode' && $('show-fill').checked) { if (previewURL) URL.revokeObjectURL(previewURL); previewURL = URL.createObjectURL(data.blob); $('preview').src = previewURL; }
    return;
  }
  if (data.id !== (data.action === 'load' ? loadId : taskId)) return;
  if (data.error) { setBusy(false); $('state').textContent = '处理失败'; status(data.error, true, 0); return; }
  if (!data.done) { status(data.message, false, data.progress); return; }
  setBusy(false);
  if (data.action === 'load') {
    image = { w: data.w, h: data.h, detected: data.detected };
    sourceURL = URL.createObjectURL(data.blob); $('preview').src = sourceURL;
    $('preview-box').hidden = false; $('dropzone').hidden = true;
    $('selection-overlay').setAttribute('viewBox', `0 0 ${data.w} ${data.h}`);
    $('dimensions').textContent = `${format(data.w)} × ${format(data.h)} px`; $('source-info').textContent = data.source;
    $('detection').textContent = data.detectionError || (data.detected ? (mode === 'decode' ? '发现 ImgSteg 标记，正在自动提取并校验。' : '发现 ImgSteg 标记，可切换到“识别与还原”提取内容。') : '未发现本项目的 ImgSteg v1/v2 标记。');
    $('detection').classList.toggle('error', Boolean(data.detectionError));
    $('state').textContent = '就绪'; $('result-note').textContent = mode === 'decode' ? (data.detected ? '已识别隐写标记，正在提取恢复数据。' : '此图片未发现本项目的隐写格式。') : '框选区域、填写文字后，点击“计算并生成隐写 PNG”。';
    status('可在图片上拖出多个矩形选区。', false, 0); setBusy(false); renderRegions();
    if (mode === 'decode' && data.detected) startTask('restore');
  } else if (data.action === 'attachments') {
    for (const item of data.items) { const { previewBlob, ...metadata } = item; attachments.push({ ...metadata, previewURL: URL.createObjectURL(previewBlob) }); }
    renderAttachments(); changed(false); status(`已按上传顺序添加 ${data.items.length} 张图片，可拖动调整顺序。`, false, 100);
  } else if (data.action === 'analyze') {
    showMetrics(data.w, data.h, data.bytes.length, data.method, '仅分析 i2 的低位压缩空间，尚未计入选区、文字和隐写文件头。');
    const url = outputURL(new Blob([data.bytes], { type: 'application/octet-stream' }));
    $('download').disabled = false; $('download').textContent = '下载低位压缩内容 ↓'; $('download').onclick = () => save(url, 'i2.lsb3');
    $('state').textContent = '分析完成'; status(`已比较 ${data.candidates} 个低位候选方案，往返校验通过。`, false, 100);
  } else if (data.action === 'build') {
    if (mode === 'encode' && $('show-fill').checked) { if (previewURL) URL.revokeObjectURL(previewURL); previewURL = URL.createObjectURL(data.baseBlob); $('preview').src = previewURL; }
    const remaining = BigInt(data.w) * BigInt(data.h) * 9n - BigInt(data.bytes.length) * 8n;
    showMetrics(data.w, data.h, data.bytes.length, '各分块独立择优，详情见下方', data.fits ? '全部恢复数据与文字均可装入，已生成并验证隐写 PNG。' : `容量不足，超出 ${format(-remaining)} bit；请缩小选区、减少文字或更换图片。`);
    for (const item of data.methods) { const row = document.createElement('li'); row.textContent = `${item.label}：${item.method} · ${format(item.bytes)} byte`; $('compression-details').append(row); }
    const overhead = data.bytes.length - data.methods.reduce((sum, item) => sum + item.bytes, 0);
    const row = document.createElement('li'); row.textContent = `容器头、选区与附加图片记录：${format(overhead)} byte`; $('compression-details').append(row);
    $('generated').hidden = false; attachDownload('download-base', data.baseBlob, 'ImgSteg-i2.png');
    $('steg-result').hidden = !data.fits; $('overflow-result').hidden = data.fits;
    if (data.fits) {
      $('steg-preview').src = attachDownload('download-steg', data.carrierBlob, 'ImgSteg-hidden.png');
      $('restore-generated').onclick = () => { openFile(new File([data.carrierBlob], 'ImgSteg-hidden.png', { type: 'image/png' })); setMode('decode'); };
      $('state').textContent = '生成成功'; status('从导出 PNG 再次提取，原图、i2、附加图片与文字全部逐字节还原。请保留 PNG 原文件。', false, 100);
    }
    else { $('state').textContent = '容量不足'; status('没有写入隐写内容。i2 底图仍可下载；缩小选区后重试。', true, 100); }
  } else if (data.action === 'restore') {
    if (!data.detected) { $('state').textContent = '未识别'; status('未发现本项目格式的隐写内容。', false, 100); return; }
    showMetrics(data.w, data.h, data.length, '已解码并校验全部分块', '已完整还原原图、底图 i2、附加图片和文字。');
    $('detection').textContent = `已识别 ImgSteg v${data.version}，全部恢复数据校验通过。`;
    $('restored').hidden = false;
    $('original-output').src = attachDownload('download-original', data.originalBlob, 'ImgSteg-original.png');
    $('base-output').src = attachDownload('download-restored-base', data.baseBlob, 'ImgSteg-i2.png');
    $('decoded-text').value = data.text; $('decode-text-box').hidden = false;
    attachDownload('download-text', new Blob([data.text], { type: 'text/plain;charset=utf-8' }), 'ImgSteg-message.txt');
    $('text-summary').textContent = data.text ? `${format(new TextEncoder().encode(data.text).length)} UTF-8 byte` : '未附加文字';
    $('decoded-attachments-box').hidden = false; $('decoded-attachment-count').textContent = `${data.attachments.length} 张（按存放顺序）`;
    for (const [index, item] of data.attachments.entries()) {
      const row = document.createElement('li'), preview = document.createElement('img'), link = document.createElement('a');
      preview.alt = `附加图片 ${index + 1}：${item.name}`; preview.src = outputURL(item.blob);
      link.href = preview.src; link.download = safeFilename(item.name); link.className = 'download-link'; link.textContent = `${index + 1}. 下载 ${item.name} ↓`;
      row.append(preview, link); $('decoded-attachments').append(row);
    }
    $('state').textContent = '还原成功'; status(`已恢复 ${data.regions.length} 个选区、${data.attachments.length} 张附加图片、原图、i2 及文字，校验通过。`, false, 100);
  }
}
function changed(preview = true) {
  if (preview) revision++;
  resetMetrics(); clearOutputs(); $('state').textContent = '待计算'; $('result-note').textContent = '选区或文字已变更，请重新计算生成。';
  if (preview) schedulePreview();
}
function blockSize() { return Math.max(2, Math.min(128, Math.trunc(Number($('block-size').value) || 12))); }
function schedulePreview() {
  clearTimeout(pendingPreview); if (!image || !worker) return;
  if (!$('show-fill').checked || mode === 'decode') { $('preview').src = sourceURL; return; }
  pendingPreview = setTimeout(() => worker.postMessage({ id: ++request, action: 'preview', regions, blockSize: blockSize(), revision }), 150);
}
function startTask(action) {
  if (busy || !image) return;
  clearTimeout(pendingPreview); resetMetrics(); clearOutputs();
  setBusy(true); taskId = ++request; $('state').textContent = '处理中'; status('正在启动本地计算…', false, 0);
  worker.postMessage({ id: taskId, action, regions, text: $('extra-text').value, blockSize: blockSize(), attachmentIds: attachments.map(item => item.id) });
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
  [...regions, ...(draft ? [draft] : [])].forEach((r, index) => {
    const rect = document.createElementNS(svgNS, 'rect');
    for (const [name, value] of Object.entries({ x: r.x, y: r.y, width: r.w, height: r.h })) rect.setAttribute(name, value);
    rect.setAttribute('class', 'selection-rect'); overlay.append(rect);
    const text = document.createElementNS(svgNS, 'text'); text.setAttribute('x', r.x + 3); text.setAttribute('y', r.y + 3); text.setAttribute('class', 'selection-number'); text.setAttribute('font-size', image ? Math.max(image.w / 55, 8) : 10); text.textContent = index + 1; overlay.append(text);
  });
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
}
function renderRegions() {
  $('region-list').replaceChildren(); $('region-count').textContent = `${regions.length} 个选区`; $('no-regions').hidden = regions.length !== 0;
  regions.forEach((r, index) => {
    const row = document.createElement('li'), title = document.createElement('div'); title.className = 'region-title'; row.classList.toggle('selected-region', index === selectedIndex);
    const label = document.createElement('strong'); label.textContent = `选区 ${index + 1}`; title.append(label);
    const select = document.createElement('select'); select.setAttribute('aria-label', `选区 ${index + 1} 填充方式`);
    for (const [value, text] of [['mosaic', '马赛克'], ['white', '纯白'], ['black', '纯黑']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
    select.value = r.mode; select.disabled = busy; select.onchange = () => { r.mode = select.value; changed(); };
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = '删除'; remove.disabled = busy; remove.setAttribute('aria-label', `删除选区 ${index + 1}`);
    remove.onclick = () => { regions.splice(index, 1); if (selectedIndex === index) selectedIndex = -1; else if (selectedIndex > index) selectedIndex--; changed(); renderRegions(); };
    const pick = document.createElement('button'); pick.className = 'text-button'; pick.textContent = index === selectedIndex ? '已选中' : '选中'; pick.setAttribute('aria-label', `选中选区 ${index + 1}`); pick.disabled = busy; pick.onclick = () => selectRegion(index);
    title.append(select, pick, remove); row.append(title);
    const fields = document.createElement('div'); fields.className = 'region-fields';
    for (const [key, text] of [['x', 'X'], ['y', 'Y'], ['w', '宽'], ['h', '高']]) {
      const field = document.createElement('label'), caption = document.createElement('span'), input = document.createElement('input'); caption.textContent = text;
      input.type = 'number'; input.step = '1'; input.dataset.coordinate = key; input.min = key === 'x' || key === 'y' ? '0' : '1'; input.max = String(key === 'x' ? image.w - 1 : key === 'y' ? image.h - 1 : key === 'w' ? image.w - r.x : image.h - r.y); input.value = r[key]; input.disabled = busy; input.setAttribute('aria-label', `选区 ${index + 1} ${text}`);
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
  $('selection-overlay').hidden = mode === 'decode'; $('show-fill-label').hidden = mode === 'decode'; schedulePreview();
  renderOverlay();
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
  if (!image || busy || mode !== 'encode') return;
  event.preventDefault(); drag = null; selectRegion(rectEditor.topmost(regions, point(event)));
});
$('selection-overlay').addEventListener('pointerdown', event => {
  if (!image || busy || mode !== 'encode' || (event.pointerType === 'mouse' && event.button !== 0)) return;
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
  if (!image || busy) return;
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
  if (busy || !image || mode !== 'encode' || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Escape') { event.preventDefault(); drag = null; selectRegion(-1); return; }
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!directions[event.key] || !regions[selectedIndex] || drag) return;
  event.preventDefault(); const [dx, dy] = directions[event.key];
  applyGeometry(rectEditor.adjust(regions[selectedIndex], selectedPart, dx, dy, image.w, image.h));
});
for (const name of ['pointercancel', 'lostpointercapture']) $('selection-overlay').addEventListener(name, () => { if (drag) { drag = null; renderOverlay(); } });
$('add-region').onclick = () => { if (!image || busy || regions.length >= 64) return; regions.push({ x: Math.floor(image.w / 4), y: Math.floor(image.h / 4), w: Math.max(1, Math.floor(image.w / 4)), h: Math.max(1, Math.floor(image.h / 4)), mode: $('new-fill').value }); selectedIndex = regions.length - 1; selectedPart = 'move'; changed(); renderRegions(); };
$('clear-regions').onclick = () => { regions = []; selectedIndex = -1; changed(); renderRegions(); };
$('block-size').onchange = () => { $('block-size').value = blockSize(); changed(); };
$('extra-text').oninput = () => { $('text-length').textContent = `${format(new TextEncoder().encode($('extra-text').value).length)} UTF-8 byte`; changed(false); };
$('show-fill').onchange = schedulePreview;
$('tab-encode').onclick = () => setMode('encode'); $('tab-decode').onclick = () => setMode('decode');
$('generate').onclick = () => startTask('build'); $('analyze').onclick = () => startTask('analyze'); $('restore').onclick = () => startTask('restore');
$('demo').onclick = () => openFile(null, true);
$('add-attachments').onclick = () => $('attachment-files').click();
$('attachment-files').onchange = event => { addAttachments([...event.target.files]); event.target.value = ''; };
$('file').onchange = event => { openFile(event.target.files[0]); event.target.value = ''; };
for (const name of ['dragenter', 'dragover']) document.addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('dragover'); });
document.addEventListener('dragleave', () => $('dropzone').classList.remove('dragover'));
document.addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('dragover'); if (!dragAttachmentId) openFile(event.dataTransfer.files[0]); });
$('cancel').onclick = () => { if (worker) worker.terminate(); worker = null; clearTimeout(pendingPreview); ++request; taskId = loadId = 0; image = null; regions = []; selectedIndex = -1; clearAttachments(); renderRegions(); setBusy(false); $('state').textContent = '已取消'; $('dimensions').textContent = '请重新选择'; status('计算已取消。请重新选择图片以开始新的处理。', false, 0); };
window.addEventListener('beforeunload', () => { if (worker) worker.terminate(); if (sourceURL) URL.revokeObjectURL(sourceURL); if (previewURL) URL.revokeObjectURL(previewURL); for (const item of attachments) URL.revokeObjectURL(item.previewURL); for (const url of outputURLs) URL.revokeObjectURL(url); });
window.addEventListener('resize', () => { if (image) renderOverlay(); });
setBusy(false);
