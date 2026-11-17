# ImgSteg (图隐)

[简体中文](README_zh-Hans.md) · [Live demo](https://richadowonosas.github.io/ImgSteg/)

Reversible image steganography, entirely in your browser. Cover selected areas with mosaic, white, or black, then store the recovery data, additional images, and a text message inside the image's three least significant RGB bits.

The resulting PNG can restore the original image, the base image **i2**, a whole tree of derived difference images, attached files, and text. No backend, framework, CDN, package installation, or build step is required. Image and message processing runs locally in a Web Worker.

## Features

- Multiple rectangular regions with individual mosaic, white, or black fills and editable pixel coordinates.
- Double-click selection; drag the interior to move, or any of eight edges/corners to resize.
- One-pixel arrow-key adjustments. A selected edge responds only to its relevant axis; a corner responds to both. Press `Esc` to deselect and draw another rectangle.
- Multiple attached images, preserving their original file bytes, names, formats, metadata, and animations. Reorder them by dragging or using the move buttons.
- UTF-8 messages, including newlines, Chinese, emoji, a leading BOM, and NUL characters.
- Independent compression selection for each block, with precise capacity accounting and a raw-storage fallback.
- Difference-image families with arbitrary acyclic parent relationships, including parents uploaded later. Each image supports automatic boxes (at most 10), manual boxes with exact coverage validation, or full-image XOR.
- Automatic ImgSteg v1/v2/v3 detection and recovery of the original image, i2, derived images, ordered attachments, and text.
- Export verification: the generated PNG is read back and its recovered contents are compared byte for byte before a successful result is shown.
- Remaining capacity in bits, bytes, equivalent RGB pixels, and maximum exact-aspect RAW dimensions for 1:1, 4:3, and 16:9.
- A compact floating capacity/progress dock that shows remaining whole bytes by default, with the exact remaining bit count in expandable details; sticky mode navigation and light/dark/system themes with an adjustable hue (default: 270°).
- Cached calculation results and compressed blocks. Selecting a region, switching previews, or adjusting the theme does not recompress unchanged content.

## Try it

Open the [live demo](https://richadowonosas.github.io/ImgSteg/), or download this repository and open `index.html` in a modern browser. A basic static HTTP server also works; there is no application server to configure.

1. Choose **制作隐写图片** (create a steganographic image) and select a carrier image. The built-in synthetic example is available for experimentation.
2. Drag rectangles on the preview, choose each fill, and optionally adjust the mosaic block size. Original RGBA pixels are saved for every region. Overlapping regions are filled in list order, while their saved pixels always come from the original image.
3. Double-click a rectangle or use its selection button to edit it. Drag its interior, edges, or corners; use arrow keys for exact one-pixel changes. Text fields retain their usual keyboard behavior. Regions cannot leave the image or become smaller than 1×1.
4. Upload optional image attachments and arrange their order. Add an optional text message. You can attach files or text without selecting any regions.
5. Click **计算并生成隐写 PNG** (calculate and generate). A PNG is produced only if the complete payload fits. If it does not, reduce the selected areas, attachments, or text, or choose another carrier. The covered i2 image remains downloadable.
6. In **识别与还原** (detect and restore), select the exported PNG. The page detects the format, verifies the contents, and provides the original image, i2, attached files in order, and a TXT download. You can also restore a newly generated PNG directly on the same page.

The interface is currently in Simplified Chinese. **仅分析 i2 低位** performs the original low-bit-only analysis; its payload size excludes regions, difference images, attachments, text, and the outer container. The full generation action includes all of them. Expand **容量与结果** in the bottom dock to inspect details, previews, and downloads; the quick PNG download stays visible after generation.

### Difference images

After loading a base image, choose **差分图隐写** in the creation-type selector. The base itself is the visible i2 image and is not covered or redrawn. Upload same-size derived images, then choose each image's parent. Every parent chain must end at i2; self-parenting, missing parents, and cycles are rejected. Forward references are supported. Removing a parent reconnects its direct children to the base and invalidates their coverage information.

Each image can use:

- **自动框选**: generate up to 10 rectangles covering every different pixel.
- **手动框选**: draw/edit rectangles with the existing editor. The image is dimmed by 50%, and changed RGBA pixels are marked white (`#FFFFFF`). After the first rectangle, still-uncovered changed pixels appear pale red (`#FFDDDD`). Packing is refused until coverage is complete.
- **全图 XOR**: XOR all RGBA samples against the parent and compress the result as one full-frame block. No manual selection is needed. Sparse differences can compress well even in this simplest mode.

Differences are exact 8-bit RGBA comparisons, including Alpha and hidden RGB values supported by direct PNG decoding. A difference image restores decoded pixels as a new PNG, rather than the source file's original encoding or metadata. Use ordinary attachments when exact original file bytes are needed.

Automatic selection follows connected-component bounding-box analysis, as described in the [OpenCV shape documentation](https://docs.opencv.org/4.5.4/d3/dc0/group__imgproc__shape.html), implemented here without OpenCV or other dependencies. An adaptive grid of at most 256×256 cells retains exact extrema of changed pixels, eight-connected components yield initial boxes, and excessive components are grouped spatially using Morton order. Greedy merging minimizes the additional bounding area of each pair until at most 10 remain. This bounded heuristic guarantees coverage, not globally minimal area or optimal compression.

Selected rectangles store parent/child XOR bytes, independently compressed with B8C1. Reconstruction always XORs against the unchanged parent, so overlapping rectangles do not cancel data. Images are reconstructed in topological order and checked against each image's RGBA CRC-32. Storage order still follows upload order, and parents may refer forward.

### Theme and result caching

**主题设置** controls light, dark, or system-following appearance and a 0–360° hue, defaulting to 270°. Preferences are local to the browser origin and do not alter image bytes. Only the essential capacity summary and progress remain permanently visible; the full result panel is collapsible.

The page retains the last full-generation and low-bit-analysis results. Repeating an identical request returns the saved blobs and metrics. Keys include carrier lifetime, regions/fills, mosaic size, difference parents/policies/manual boxes, attachments/order, and text. Presentation-only changes are excluded. The Worker also reuses unchanged i2 low-bit/Alpha blocks, saved original regions, attached-file blocks, and XOR patches when other content changes. New carriers and cancellation clear the cache. Compression-block caches are bounded by entry count/bytes; no cache is persisted to disk.

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
| Difference images | 16, each the same size as i2; 40 million pixels combined |
| Difference selection | At most 10 automatic boxes, or 64 manual boxes per image |
| UTF-8 message | 4 MiB; the interface allows up to 1 million UTF-16 code units |

Available payload capacity can be much lower than these input limits. Large inputs can still exhaust device memory. Candidate compression runs sequentially in a Worker. Changing the carrier or cancelling terminates the Worker and clears the attachment list; choose the image again to restart.

**Keep the exported PNG unchanged.** JPEG conversion, resizing, screenshots, and color adjustments may destroy the payload. This is reversible concealment, **not encryption**: anyone with the image can recover its contents. CRC-32 detects damage but is not cryptographic authentication.

## Payload format

All integers use big-endian byte order. The payload is self-describing; decoding needs the format implementation and a supported decompressor, but no original image or external sidecar file.

```text
IMGSTEG1 header (48 bytes), IMGSTEG2 (56 bytes), or IMGSTEG3 (64 bytes)
i2 RGB low-bit block (L3B1)
optional i2 Alpha block (B8C1)
region record + original RGBA block (B8C1), repeated in selection order
optional difference-image section (DIF1), including its parent graph and XOR blocks
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
| 48 | 4 | v2/v3: attachment count |
| 52 | 4 | v2/v3: total attachment section length, including records |
| 56 | 4 | v3 only: difference-image count |
| 60 | 4 | v3 only: complete DIF1 section length |

With no difference images, no attachments means v1 and attachments enable v2. Difference images enable v3; v3 retains the attachment fields at offsets 48/52 even when there are no attachments. The body CRC starts after the actual 48/56/64-byte header. The current reader supports all three versions; older readers cannot decode newer versions.

### DIF1 section

The section begins with 20 bytes: `DIF1`, image count, width, height, and i2 RGBA CRC-32 (all following fields uint32). Each upload-order image has a 16-byte record: UTF-8 name length (uint16), patch count (uint16), parent index (uint32, 0=i2, 1-based upload order otherwise), child RGBA CRC-32 (uint32), reserved zero (uint32); then the filename bytes. Each patch has five uint32 values for X/Y/width/height/B8C1 length, followed by its RGBA XOR B8C1 block. An identical auto-mode image can have zero patches; full-image XOR has one full-frame patch. Graph reachability, cycles, dimensions, lengths, coverage on encoding, and reconstructed image CRCs are validated.

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
| `diff.js` | Parent graphs, masks, bounded automatic boxes, coverage previews and XOR patch sections |

GitHub Pages publishes the repository root from `main`. `.nojekyll` enables direct static-file serving; no build workflow or `.github` directory is needed.

`.gitignore` excludes `test/`, `tests/`, and directories beginning with `.` at every level, with an explicit exception for `.github/` so GitHub configuration can be versioned. Local test suites, generated fixtures, screenshots, and publishing helpers are intentionally absent from the published repository and site. Dotfiles such as `.gitignore` and `.nojekyll` remain tracked.

The local development copy includes 54 dependency-free tests covering codecs, PNG filters, transparent pixels, export/read-back, overlap restoration, text/attachment/difference ordering, exact capacity, malformed payloads, geometry constraints, forward-reference DAGs, all three XOR policies, coverage, caches, and v1/v2/v3 compatibility. If that local `tests/` directory is present, run with Node.js 22+:

```sh
node --test tests/*.test.cjs
node tests/make-fixtures.cjs
```

The local `tests/browser.html` harness generates synthetic attachment files in the browser and exercises the real file-input change handler. Tests are development-only; running ImgSteg itself needs only a modern browser.
