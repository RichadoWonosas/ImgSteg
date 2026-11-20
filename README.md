# ImgSteg (图隐)

[简体中文](README_zh-Hans.md) · [Live demo](https://richadowonosas.github.io/ImgSteg/)

Reversible image steganography, entirely in your browser. Cover selected areas with mosaic, white, or black, then store the recovery data, additional images, and a text message inside the image's three least significant RGB bits.

The resulting PNG can restore the original image, the base image **i2**, a whole tree of derived difference images, attached files, and text. No backend, framework, CDN, package installation, or build step is required. Pinned JS/WASM codecs are bundled locally (see [vendor sources and licenses](vendor/README.md)). Image and message processing runs locally in a Web Worker.

## Features

- Multiple rectangular regions with individual mosaic, white, or black fills and editable pixel coordinates.
- Double-click selection; drag the interior to move, or any of eight edges/corners to resize.
- Click a difference-image row's thumbnail, title, or blank area to preview it; click a non-control area of an editable region row to select it. Inputs, labels, dropdowns, and action buttons keep their own behavior.
- One-pixel arrow-key adjustments. A selected edge responds only to its relevant axis; a corner responds to both. Press `Esc` to deselect and draw another rectangle.
- Multiple attached images, preserving their original file bytes, names, formats, metadata, and animations. Reorder them by dragging or using the move buttons.
- UTF-8 messages, including newlines, Chinese, emoji, a leading BOM, and NUL characters.
- Independent compression selection for each block, with precise capacity accounting and a raw-storage fallback.
- Difference-image families with arbitrary acyclic parent relationships, including parents uploaded later. Each image supports automatic boxes (at most 20), 32×32 automatic chunks, manual boxes with exact coverage validation, or full-image XOR.
- Automatic ImgSteg v1/v2/v3/v4/v5/v6 detection and recovery of the original image, i2, derived images, ordered attachments, and text.
- Export verification: the generated PNG is read back and its recovered contents are compared byte for byte before a successful result is shown.
- Remaining capacity in bits, bytes, equivalent RGB pixels, and maximum exact-aspect RAW dimensions for 1:1, 4:3, and 16:9.
- A compact floating capacity/progress dock that shows remaining whole bytes by default, with the exact remaining bit count in expandable details; sticky mode navigation and light/dark/system themes with an adjustable hue (default: 270°).
- Cached calculation results and compressed blocks. Selecting a region, switching previews, or adjusting the theme does not recompress unchanged content.

## Try it

Open the [live demo](https://richadowonosas.github.io/ImgSteg/), or download this repository and open `index.html` in a modern browser. A basic static HTTP server also works; there is no application server to configure.

Carrier-image file drops are accepted only inside the left **图片预览** (image preview) panel, including when replacing an existing image. Dropping files elsewhere does not upload or replace the carrier; the page prevents the browser from navigating to the dropped file. Attachment-list reordering remains independent.

1. Choose **制作隐写图片** (create a steganographic image) and select a carrier image. The built-in synthetic example is available for experimentation.
2. Drag rectangles on the preview, choose each fill, and optionally adjust the mosaic block size. Original RGBA pixels are saved for every region. Overlapping regions are filled in list order, while their saved pixels always come from the original image.
3. Double-click a rectangle or use its selection button to edit it. Drag its interior, edges, or corners; use arrow keys for exact one-pixel changes. Text fields retain their usual keyboard behavior. Regions cannot leave the image or become smaller than 1×1.
4. Upload optional image attachments and arrange their order. Add an optional text message. You can attach files or text without selecting any regions.
5. Click **计算并生成隐写 PNG** (calculate and generate). A PNG is produced only if the complete payload fits. If it does not, reduce the selected areas, attachments, or text, or choose another carrier. The covered i2 image remains downloadable.
6. In **识别与还原** (detect and restore), select the exported PNG. The page detects the format, verifies the contents, and provides the original image, i2, attached files in order, and a TXT download. You can also restore a newly generated PNG directly on the same page.

The interface is currently in Simplified Chinese. **仅分析 i2 低位** performs the original low-bit-only analysis; its payload size excludes regions, difference images, attachments, text, and the outer container. The full generation action includes all of them. Expand **容量与结果** in the bottom dock to inspect details, previews, and downloads; the quick PNG download stays visible after generation.

### Difference images

Covering and difference images can be used together. Upload one or multiple images and choose a base; the others become same-size difference images in upload order. The base also appears in the parent list: **原图预览** shows its unmasked pixels, **遮盖预览** shows covered i2, and **编辑遮盖** edits cover regions. Covered i2 is the implicit, unselectable root; the original unmasked base is reconstructed from it and is the selectable parent of difference images. Parent chains must reach that base; cycles and missing parents are rejected, and forward references are supported. Removing a parent reconnects its children to the unmasked base.

File drops are accepted only in the image preview panel. With a base already loaded, dropping images asks whether to append differences or replace the batch and choose a new base. The explicit replacement input always replaces. Replacement or **清空** clears the previous differences, covers, attachments, and cached results. **预览** (and a non-control row click) shows a difference image in original colors without masks or boxes; **编辑** shows the dimmed difference editor. The main generation button has a side menu containing **仅分析 i2 低位**.

Each image can use:

- **自动框选**: generate up to 20 rectangles covering every different pixel, then remove completely contained rectangles and duplicates. Switching from automatic to manual preserves those boxes, even for an image that has not been opened in the editor.
- **32×32 分块自动**: shrink changed chunks and merge adjacent unshrunk chunks, with a read-only grid/result preview (up to 1024 rectangles).
- **手动框选**: draw/edit rectangles with the existing editor. The image is dimmed by 50%, and changed RGBA pixels are marked white (`#FFFFFF`). After the first rectangle, still-uncovered changed pixels appear pale red (`#FFDDDD`). Packing is refused until coverage is complete.
- **全图 XOR**: XOR all RGBA samples against the parent and compress the result as one full-frame block. No manual selection is needed. Sparse differences can compress well even in this simplest mode.

Differences are exact 8-bit RGBA comparisons, including Alpha and hidden RGB values supported by direct PNG decoding. A difference image restores decoded pixels as a new PNG, rather than the source file's original encoding or metadata. Use ordinary attachments when exact original file bytes are needed.

Automatic selection follows connected-component bounding-box analysis, as described in the [OpenCV shape documentation](https://docs.opencv.org/4.5.4/d3/dc0/group__imgproc__shape.html), implemented here without OpenCV or other dependencies. An adaptive grid of at most 256×256 cells retains exact extrema of changed pixels, eight-connected components yield initial boxes, and excessive components are grouped spatially using Morton order. Greedy merging minimizes the additional bounding area of each pair until at most 10 initial boxes remain. A refinement pass then tries the largest improvable box first, scans both axes, and splits into two tight difference bounds with the greatest positive area reduction. Empty row/column gaps take priority. If the largest box cannot improve, smaller boxes are tried. Refinement stops at 20 boxes or when no positive reduction remains. This bounded heuristic guarantees coverage, not globally minimal area or optimal compression.

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
| Difference selection | At most 20 automatic boxes, 1024 read-only chunk results, or 64 manual boxes per image |
| UTF-8 message | 4 MiB; the interface allows up to 1 million UTF-16 code units |

Available payload capacity can be much lower than these input limits. Large inputs can still exhaust device memory. Candidate compression runs sequentially in a Worker. Changing the carrier or cancelling terminates the Worker and clears the attachment list; choose the image again to restart.

**Keep the exported PNG unchanged.** JPEG conversion, resizing, screenshots, and color adjustments may destroy the payload. This is reversible concealment, **not encryption**: anyone with the image can recover its contents. CRC-32 detects damage but is not cryptographic authentication.

## Payload format

All integers use big-endian byte order. The payload is self-describing; decoding needs the format implementation and a supported decompressor, but no original image or external sidecar file.

```text
IMGSTEG1 header (48 bytes), IMGSTEG2 (56 bytes), or IMGSTEG3–6 (64 bytes)
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
| 48 | 4 | v2/v3/v4: attachment count |
| 52 | 4 | v2/v3/v4: total attachment section length, including records |
| 56 | 4 | v3/v4: difference-image count |
| 60 | 4 | v3/v4: complete DIF1 section length |

With no difference images, no attachments means v1 and attachments enable v2. Dense-only difference images without covers enable v3; combining covers and dense differences enables v4; sparse differences enable v5. v3/v4 retain the attachment fields at offsets 48/52 even when there are no attachments. The body CRC starts after the actual 48/56/64-byte header. The current reader supports all six versions; older readers cannot decode newer versions.

### DIF1 section

The section begins with 20 bytes: `DIF1`, image count, width, height, and root RGBA CRC-32 (i2 in v3; the recovered unmasked original in v4) (all following fields uint32). Each upload-order image has a 16-byte record: UTF-8 name length (uint16), patch count (uint16), parent index (uint32, 0=root, 1-based upload order otherwise), child RGBA CRC-32 (uint32), reserved zero (uint32); then the filename bytes. Each patch has five uint32 values for X/Y/width/height/B8C1 length, followed by its RGBA XOR B8C1 block. An identical auto-mode image can have zero patches; full-image XOR has one full-frame patch. Graph reachability, cycles, dimensions, lengths, coverage on encoding, and reconstructed image CRCs are validated.

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

The local development copy includes the historical 54 dependency-free tests covering codecs, PNG filters, transparent pixels, export/read-back, overlap restoration, text/attachment/difference ordering, exact capacity, malformed payloads, geometry constraints, forward-reference DAGs, all three XOR policies, coverage, caches, and v1/v2/v3 compatibility. If that local `tests/` directory is present, run with Node.js 22+:

```sh
node --test tests/*.test.cjs
node tests/make-fixtures.cjs
```

The local `tests/browser.html` harness generates synthetic attachment files in the browser and exercises the real file-input change handler. Tests are development-only; running ImgSteg itself needs only a modern browser.

Combined-format validation additionally covers v4 PNG round trips with covers, forward parent references, attachments and text, cover edits with cache reuse, and legacy v3 covered-root decoding. This update used focused checks and browser acceptance rather than a full regression run.

Each thumbnail has **选为基底图** (disabled on the current base). This reuses loaded pixels, keeps every image, transfers cover coordinates/fills to the new base, and reverses the unique parent path while carrying each edge’s boxes and encoding policy. Attachments and text stay in place. Symmetric XOR/mask caches can be reused; capacity results are invalidated for the next calculation. This differs from replacing the uploaded batch, which clears the old images.

## Sparse differences and bundled high-compression codecs

Each difference rectangle compares a dense RGBA XOR block with a sparse block: a 1-bit-per-pixel change mask followed by the complete RGBA XOR values of changed pixels, in scan order. The mask and values are compressed together. Sparse is used only when its complete block, including the extra header, is smaller. Dense/no-change data retains the dense candidate; overlaps still apply against the unchanged parent. Result details show the selected method and bytes saved against dense.

The existing native candidates are joined by **fflate 0.8.2 DEFLATE level 9** and **brotli-wasm 3.0.1 quality 11**. Both participate in LSB3 and full-byte layout searches. A transformed input over 8 MiB skips Brotli quality 11 to bound costly trials; other candidates remain available. WASM initialization failure skips the WASM candidate. The classic-script bundle embeds the WASM bytes and is serialized into the existing Worker; there are no CDN requests or image uploads. See [vendor/README.md](vendor/README.md) for provenance, licenses and deterministic rebuilding.

Algorithm IDs 6 and 7 extend L3B1/B8C1 for the local DEFLATE-9 and Brotli-11 encoders/readers; 0–5 retain their meanings. Their compressed streams are standard raw DEFLATE and Brotli. Native Brotli/raw-DEFLATE decoding can fall back to the bundled codecs when unavailable. Old readers may not support these new algorithm IDs even when the outer container is v1–v4.

Outside chunk mode, a sparse-enabled difference section uses **DIF2** (the DIF1 records remain unchanged), and its outer container is **IMGSTEG5** with the same 64-byte header/root semantics as v4. Dense-only difference sections keep DIF1 and v3/v4. In DIF2, each patch payload is either the original B8C1 dense block or **SPX1**: 4-byte magic; uint32 width, height, changed-pixel count and dense-XOR CRC-32; then one B8C1 block. All integers are big-endian. The B8C1 decoded bytes contain `ceil(w*h/8)` MSB-first mask bytes, `4*count` RGBA XOR bytes, and zero padding to a multiple of four (encoded as width=paddedLength/4, height=1, channels=4). Count, dimensions, mask padding, zero padding, nonzero changed values and CRC are checked. The current reader accepts v1–v6 and DIF1/DIF2/DIF3; sparse files require the updated reader.

Focused measurements (synthetic data, not a general compression guarantee): in the development browser, a 128×128 structured LSB sample decreased from 235 bytes using native DEFLATE to 77 bytes using Brotli WASM, with the full search taking about 87 ms vs 514 ms. A 256×256 sparse random-change XOR block decreased from 4,674 to 4,113 bytes including block headers (about 12%); dense random and zero data retained their dense representation. Full PNG v5 restore and legacy v1–v4 compatibility were checked. High-quality compression trades encoding time and the bundled download size for potential capacity gains.

## 32×32 automatic chunks

Choose **32×32 分块自动** in a difference image's encoding selector, then **分块预览** to inspect the result. Each axis is divided into 32 integer intervals (`floor(i*dimension/32)` boundaries); dimensions below 32 use that many nonempty intervals. Empty chunks are discarded. Every changed chunk is tightened to its exact difference bounding box. Only chunks whose bounds did not shrink may merge; empty or shrunken chunks are never bridged.

The eligible chunk mask is partitioned using horizontal/vertical run sweeps and largest-rectangle-first histogram searches with two tie-breaking orientations. Adjacent rectangles with matching full edges are joined; the candidate with the fewest rectangles wins (perimeter breaks ties). This guarantees exact eligible-cell coverage, not a globally minimum rectangle partition or minimum compressed size.

The preview shows the original grid in gray, shrunken boxes in orange, merged boxes in green and untouched-size singleton chunks in the theme color. The summary reports changed/shrunken chunks and rectangle savings. It is read-only, with no drawing, handles, coordinate-input list or manual selection buttons. Original-color previews remain available. Packing uses exactly the same rectangles as preview and still compares dense/sparse XOR and codec candidates per rectangle. Many small chunks add header and compression work, so this mode is not guaranteed to be smaller than ordinary automatic selection.

Chunk mode emits **IMGSTEG6 / DIF3**, retaining the 64-byte header and original-root semantics of v4/v5. DIF3 preserves existing records and dense/SPX1 patch blocks, but allows up to **1024 patches per image**; DIF1/DIF2 retain their 64-patch decode limit. The manual encoder still permits at most 64 boxes, and ordinary automatic selection at most 20. The reader accepts older v1–v5 files; chunk files need the updated reader.

Focused verification covers exhaustive small-mask split comparisons, skipping an unsplittable largest box, gap splitting, 20-box limits, exact chunk shrink/merge coverage, tiny/non-divisible dimensions, 1024 shrunken patch records, sparse DIF3, and covered PNG v6 round trips. Browser acceptance confirms read-only rendering, four mixed result rectangles from 99 changed chunks, complete v6 restore with attachments/text, and preservation of all 20 coordinates when ordinary automatic selection switches to manual. No full regression run was performed.
