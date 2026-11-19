# Local codec sources

Runtime bundle: `../vendor-codecs.js`. No npm install, bundler, CDN, network fetch or server-side processing is needed to use the app. The WASM bytes are embedded in the classic-script bundle so local files and Blob Workers do not need to fetch a separate WASM URL.

| Package | Pinned version | Upstream | License | Used APIs |
| --- | --- | --- | --- | --- |
| fflate | 0.8.2 | https://github.com/101arrowz/fflate | MIT (`fflate-LICENSE.txt`) | `deflateSync(level:9, mem:8)` and streaming `Inflate` |
| brotli-wasm | 3.0.1 | https://github.com/httptoolkit/brotli-wasm | Apache-2.0 (`brotli-wasm-LICENSE.txt`) | quality 11 compression; bounded `DecompressStream` |

`manifest.json` records official npm tarball URLs, npm SHA-512 integrity values, and SHA-256 hashes of vendored sources. The WASM binary is unmodified. Original browser glue is kept for audit (line endings may be normalized); the bundle removes ESM export declarations and the unused import.meta URL default. fflate uses its UMD build inside a private CommonJS-style scope.

`../tools/local-codecs.template.js` contains the project adapter. Rebuild from the pinned local sources with:

```sh
python tools/build-vendor.py
```

This development-only command uses Python's standard library, does not download anything, and generates `vendor-codecs.js` deterministically. The app itself requires only a browser.

The adapter exposes `LocalCodecs().available(format)` and `run(bytes,format,decode,limit)` for `deflate-js9` and `brotli-wasm11`. Calls in the product run in its existing Worker. Brotli initialization is lazy and falls back to the remaining candidates if WebAssembly is unavailable. Quality 11 is considered only for transformed inputs <=8 MiB; larger inputs retain native codecs, fflate level 9 and raw storage. Decode limits are enforced incrementally; payloads using a local algorithm require the bundled reader. Standard Brotli/DEFLATE streams remain interoperable with independent decoders.
