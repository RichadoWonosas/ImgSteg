"""Rebuild the classic-script codec bundle using only pinned local sources."""
from pathlib import Path
import base64
import re
root = Path(__file__).resolve().parent.parent
source = (root / 'tools/local-codecs.template.js').read_text(encoding='utf-8')
brotli = (root / 'vendor/brotli_wasm.original.js').read_text(encoding='utf-8')
brotli = re.sub(r'export default init;', '', brotli)
brotli = re.sub(r'export (function|class|const) ', r'\1 ', brotli)
brotli = brotli.replace("new URL('brotli_wasm_bg.wasm', import.meta.url)", 'null')
source = source.replace('__FFLATE_SOURCE__', (root / 'vendor/fflate.min.js').read_text(encoding='utf-8'))
source = source.replace('__BROTLI_SOURCE__', brotli)
source = source.replace('__BROTLI_BASE64__', repr(base64.b64encode((root / 'vendor/brotli_wasm_bg.wasm').read_bytes()).decode()))
(root / 'vendor-codecs.js').write_text(source, encoding='utf-8', newline='\n')
