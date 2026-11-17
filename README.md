# ImgSteg (图隐)

[简体中文](README_zh-Hans.md) · [Live demo](https://richadowonosas.github.io/ImgSteg/)

Reversible image steganography, entirely in your browser. Cover selected areas with mosaic, white, or black, then store the recovery data, additional images, and a text message inside the image's three least significant RGB bits.

The resulting PNG can restore both the original image and the covered base image **i2**, along with all attached files and text. No backend, framework, CDN, package installation, or build step is required. Image and message processing runs locally in a Web Worker.

## Features

- Multiple rectangular regions with individual mosaic, white, or black fills and editable pixel coordinates.
- Double-click selection; drag the interior to move, or any of eight edges/corners to resize.
- One-pixel arrow-key adjustments. A selected edge responds only to its relevant axis; a corner responds to both. Press `Esc` to deselect and draw another rectangle.
- Multiple attached images, preserving their original file bytes, names, formats, metadata, and animations. Reorder them by dragging or using the move buttons.
- UTF-8 messages, including newlines, Chinese, emoji, a leading BOM, and NUL characters.
- Independent compression selection for each block, with precise capacity accounting and a raw-storage fallback.
- Automatic ImgSteg v1/v2 detection and recovery of the original image, i2, ordered attachments, and text.
- Export verification: the generated PNG is read back and its recovered contents are compared byte for byte before a successful result is shown.
- Remaining capacity in bits, bytes, equivalent RGB pixels, and maximum exact-aspect RAW dimensions for 1:1, 4:3, and 16:9.

## Try it

Open the [live demo](https://richadowonosas.github.io/ImgSteg/), or download this repository and open `index.html` in a modern browser. A basic static HTTP server also works; there is no application server to configure.

1. Choose **制作隐写图片** (create a steganographic image) and select a carrier image. The built-in synthetic example is available for experimentation.
2. Drag rectangles on the preview, choose each fill, and optionally adjust the mosaic block size. Original RGBA pixels are saved for every region. Overlapping regions are filled in list order, while their saved pixels always come from the original image.
3. Double-click a rectangle or use its selection button to edit it. Drag its interior, edges, or corners; use arrow keys for exact one-pixel changes. Text fields retain their usual keyboard behavior. Regions cannot leave the image or become smaller than 1×1.
4. Upload optional image attachments and arrange their order. Add an optional text message. You can attach files or text without selecting any regions.
5. Click **计算并生成隐写 PNG** (calculate and generate). A PNG is produced only if the complete payload fits. If it does not, reduce the selected areas, attachments, or text, or choose another carrier. The covered i2 image remains downloadable.
6. In **识别与还原** (detect and restore), select the exported PNG. The page detects the format, verifies the contents, and provides the original image, i2, attached files in order, and a TXT download. You can also restore a newly generated PNG directly on the same page.

The interface is currently in Simplified Chinese. **仅分析 i2 低位** performs the original low-bit-only analysis; its payload size excludes regions, attachments, text, and the outer steganography container. The full generation action includes all of them.

## How it works

1. Copy the selected original RGBA regions and apply their fills in order to create i2.
2. Extract three low bits from each RGB channel of i2: `9 × width × height` meaningful bits. Alpha is handled separately when required.
3. Compress i2's low bits, its optional Alpha plane, and each original region independently. Then compress each attached image's complete original file bytes in list order. The UTF-8 text block is always last.
4. Include dimensions, coordinates, filenames, MIME types, block lengths, checksums, container headers, and padding in the complete payload size.
5. If the payload fits within `9wh`, replace the RGB low three bits in i2 with the payload. Unused low bits are zeroed; the high five bits remain unchanged. Export an opaque, lossless PNG to prevent premultiplied Alpha from damaging carrier bits.
6. To recover, restore i2's low bits and Alpha, then paste the saved original regions back onto i2. Extract the original attachment files and decode the final UTF-8 message. Check the payload, i2, original image, and individual blocks with CRC-32.

### Compression

Low-bit candidates include compact packing, interleaved channel values, planar channels, bit planes, and horizontal/vertical prediction differences. Full-byte blocks compare interleaved bytes, planar channels, horizontal/vertical differences, and bit planes.

Each layout is tested with the browser's available `deflate-raw`, `deflate`, `gzip`, `brotli`, and `zstd` compression/decompression pair. Unsupported formats are skipped. Raw storage is also considered. The smallest complete block wins.

This is the best result **within the tested candidates**, not a claim of universally optimal compression. The native Compression Streams API does not expose compression-level controls, and random low bits or already-compressed attachments may not shrink. A decoding browser must support the algorithm recorded in each block.

### Capacity

For an image of width `w`, height `h`, and complete payload length `n` bits:

```text
capacity = 9wh
r = 9wh - n
b = r >> 3
P = floor(b / 3)
```

These calculations use `BigInt`, including signed shifts and floor division, to avoid JavaScript's 32-bit bitwise truncation. Negative values indicate that there is no usable space.

For a reduced integer aspect ratio `a:b`, the maximum exact-aspect RAW dimensions are:

```text
k = floor(sqrt(max(P, 0) / (a × b)))
dimensions = (a × k) × (b × k)
```

The square root is calculated with integer arithmetic. RAW estimates assume RGB at three bytes per pixel, without headers, Alpha, or row padding.

## Image fidelity and limits

The custom PNG reader/writer supports 8-bit, non-interlaced RGB/RGBA and all five PNG row filters. Export does not use Canvas encoding. Directly read RGBA PNGs preserve every sample, including hidden RGB values at Alpha=0. RGB+tRNS, indexed, grayscale, 16-bit, interlaced PNGs, and other formats fall back to browser decoding.

For the **carrier**, recovery means restoring the decoded pixels, not recreating the original source file's bytes. Browser-decoded images use 8-bit sRGB, may round transparent RGB values, and use one decoded animation frame. Source metadata, encoding, higher bit depth, and animation are not stored. Direct PNG reads preserve sample values without ICC conversion.

For **attachments**, the complete original file bytes are retained. The restored files preserve their encoding, metadata, and animation. Their previews use decoded image pixels.

The exported carrier is opaque. Original/i2 Alpha values are recovered from the saved data. Filled areas in i2 are opaque; mosaic blocks use the mean RGB values of the current i2 block, aligned to the region's top-left corner.

| Resource | Limit |
| --- | --- |
| Carrier or decoded attachment image | 40 million pixels per image |
| Selected regions | 64 |
| Total selected area | 40 million pixels, counting overlaps repeatedly |
| Attached image files | 32 |
| Combined original attachment file size | 32 MiB |
| UTF-8 message | 4 MiB; the interface allows up to 1 million UTF-16 code units |

Available payload capacity can be much lower than these input limits. Large inputs can still exhaust device memory. Candidate compression runs sequentially in a Worker. Changing the carrier or cancelling terminates the Worker and clears the attachment list; choose the image again to restart.

**Keep the exported PNG unchanged.** JPEG conversion, resizing, screenshots, and color adjustments may destroy the payload. This is reversible concealment, **not encryption**: anyone with the image can recover its contents. CRC-32 detects damage but is not cryptographic authentication.

## Payload format

All integers use big-endian byte order. The payload is self-describing; decoding needs the format implementation and a supported decompressor, but no original image or external sidecar file.

```text
IMGSTEG1 header (48 bytes), or IMGSTEG2 header (56 bytes)
i2 RGB low-bit block (L3B1)
optional i2 Alpha block (B8C1)
region record + original RGBA block (B8C1), repeated in selection order
attachment record + original file-byte block (B8C1), repeated in attachment order
optional UTF-8 message block (B8C1), always last
```

### Container header

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 8 | ASCII `IMGSTEG1` or `IMGSTEG2` |
| 8 | 4 | Total payload length, including the header |
| 12 | 4 | Image width |
| 16 | 4 | Image height |
| 20 | 4 | Region count |
| 24 | 4 | L3B1 block length |
| 28 | 4 | i2 Alpha block length; zero means opaque |
| 32 | 4 | CRC-32 of complete i2 RGBA bytes |
| 36 | 4 | CRC-32 of complete original RGBA bytes |
| 40 | 4 | CRC-32 of all bytes after the actual container header |
| 44 | 4 | Final text block length; zero means no text |
| 48 | 4 | v2 only: attachment count |
| 52 | 4 | v2 only: total attachment section length, including records |

No attachments means a v1 container. Attachments enable v2. The current reader supports both versions; older v1-only implementations cannot decode v2.

A region record is 24 bytes: X/Y/width/height as four uint32 values; one fill byte (0=mosaic, 1=white, 2=black); three zero reserved bytes; and a uint32 block length.

An attachment record starts with 16 bytes: UTF-8 filename length (uint16), MIME length (uint16), block length (uint32), width and height (uint32 each). Filename bytes, MIME bytes, and the original-file B8C1 block follow. Filenames allow up to 1,024 UTF-8 bytes; MIME types allow up to 128 bytes.

### Compression blocks

Both block types have 20-byte headers and a CRC-32 of the canonical original data.

- **L3B1:** magic (4 bytes), layout (1), algorithm (1), reserved zero bytes (2), width (4), height (4), CRC-32 (4). Layouts: 0=compact, 1=interleaved low values, 2=planar channels, 3=bit planes, 4=left differences, 5=upper differences. Compact packing visits each pixel's R/G/B channels, bit 2 down to bit 0, and zero-pads the final byte. Planes use channel order, then bit 2 to 0, then row-major pixels, without intermediate padding. Differences are modulo 8 with zero boundary predictions.
- **B8C1:** magic (4 bytes), width (4), height (4), channel count (1), layout (1), algorithm (1), reserved zero byte (1), CRC-32 (4). Channels may be 1, 3, or 4. Layouts: 0=interleaved bytes, 1=planar channels, 2=left differences, 3=upper differences, 4=bit planes. Differences are modulo 256. Planes use channel order, then bit 7 to 0, then row-major samples. File and text blocks use width=byte length, height=1, channels=1.

Algorithm IDs: 0=raw, 1=deflate-raw, 2=deflate, 3=gzip, 4=brotli, 5=zstd. Raw storage only uses layout 0. Text is decoded as UTF-8 without HTML interpretation. See the [Compression Standard](https://compression.spec.whatwg.org/) for the native stream interfaces.

## Source layout and deployment

| File | Purpose |
| --- | --- |
| `index.html`, `style.css` | Interface and styling |
| `app.js` | Region editing, attachment ordering, Worker orchestration, previews and downloads |
| `codec.js` | RGB low-bit codecs and exact capacity/RAW-size calculations |
| `steg.js` | Full-byte codecs, v1/v2 containers, embedding and restoration |
| `png.js` | Lossless PNG reading and writing |
| `editor.js` | Hit testing, constrained movement and eight-direction resizing |

GitHub Pages publishes the repository root from `main`. `.nojekyll` enables direct static-file serving; no build workflow or `.github` directory is needed.

`.gitignore` excludes `test/`, `tests/`, and directories beginning with `.` at every level, with an explicit exception for `.github/` so GitHub configuration can be versioned. Local test suites, generated fixtures, screenshots, and publishing helpers are intentionally absent from the published repository and site. Dotfiles such as `.gitignore` and `.nojekyll` remain tracked.

The local development copy includes 45 dependency-free tests covering codecs, PNG filters, transparent pixels, export/read-back, overlap restoration, text and attachment ordering, exact capacity, malformed payloads, geometry constraints, and v1/v2 compatibility. If that local `tests/` directory is present, run with Node.js 22+:

```sh
node --test tests/*.test.cjs
node tests/make-fixtures.cjs
```

The local `tests/browser.html` harness generates synthetic attachment files in the browser and exercises the real file-input change handler. Tests are development-only; running ImgSteg itself needs only a modern browser.
