# Local codec sources

Runtime bundle: `../vendor-codecs.js`. No npm install, bundler, CDN, network fetch or server-side processing is needed to use the app. The WASM bytes are embedded in the classic-script bundle so local files and Blob Workers do not need to fetch a separate WASM URL.

| Package | Pinned version | Upstream | License | Used APIs |
| --- | --- | --- | --- | --- |
| fflate | 0.8.2 | https://github.com/101arrowz/fflate | MIT (`fflate-LICENSE.txt`) | `deflateSync(level:9, mem:8)` and streaming `Inflate` |
| lzma-wasm | 1.0.7 | https://github.com/Wu-Yijun/lzma-wasm | MIT OR Apache-2.0 (both license texts bundled) | XZ/LZMA2 preset 3 and bounded `decompressToBuffer` |
| brotli-wasm | 3.0.1 | https://github.com/httptoolkit/brotli-wasm | Apache-2.0 (`brotli-wasm-LICENSE.txt`) | quality 5 compression (quality 11 decoding remains supported); bounded `DecompressStream` |

`manifest.json` records official npm tarball URLs, npm SHA-512 integrity values, and SHA-256 hashes of vendored sources. The WASM binary is unmodified. Original browser glue is kept for audit (line endings may be normalized); the bundle removes ESM export declarations and the unused import.meta URL default. fflate uses its UMD build inside a private CommonJS-style scope.

`../tools/local-codecs.template.js` contains the project adapter. Rebuild from the pinned local sources with:

```sh
python tools/build-vendor.py
```

This development-only command uses Python's standard library, does not download anything, and generates `vendor-codecs.js` deterministically. The app itself requires only a browser.

The adapter exposes `LocalCodecs().available(format)` and `run(bytes,format,decode,limit)` for `deflate-js9`, `brotli-wasm5` and `lzma2-xz3` (with the legacy `brotli-wasm11` alias). Calls in the product run in its existing Worker. Brotli initialization is lazy and falls back to the remaining candidates if WebAssembly is unavailable. Brotli-5 and LZMA2-3 are considered only for transformed inputs <=8 MiB; larger inputs retain native codecs, fflate level 9 and raw storage. XZ trials are also skipped when the best payload is already <=32 bytes, since an XZ stream cannot beat that size. Decode limits are enforced incrementally; payloads using a local algorithm require the bundled reader. Standard Brotli/DEFLATE streams remain interoperable with independent decoders.

`lzma-wasm.iife.js` is kept byte-for-byte from npm; the generated private wrapper removes only its final `window.LzmaWasm` assignment so it also works in Blob Workers. It includes its WASM bytes. `tools/xz-codec-adapter.js` validates a single CRC64 XZ stream: header/footer/index/block checks, one LZMA2 filter, dictionary <=64 MiB, <=1024 blocks, exact output length and every block CRC64. Because upstream's fixed-buffer decoder may return a prefix without reaching EOF, the wrapper allocates the indexed output size plus one byte and rejects a longer result. It avoids the unbounded dynamic decoder. Empty compression uses the canonical 32-byte empty XZ stream instead of the upstream version's invalid empty output. No external dictionary is needed.
