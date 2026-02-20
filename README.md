# Line-Detection

Browser-only components and a TPEN 3 interface for automatically detecting handwriting lines in manuscript images.  All processing runs entirely in the browser using the Canvas 2D API — no server-side backend is required.

---

## Repository Structure

```
components/
  line-detection/
    detection.js   — Core line-detection algorithms (projection, busyness, combined)
    index.js       — <handwriting-line-detector> Custom Element

interfaces/
  line-detection/
    index.html     — TPEN 3 interface page
    index.js       — Interface logic (auth, page load, detection, save)
```

---

## Components

### `components/line-detection/`

#### `detection.js`

Exports three async functions (and a resize helper) that operate entirely on a browser `<canvas>`:

| Function | Description |
|---|---|
| `resizeImageIfNeeded(image, maxDim)` | Down-scales an image to `maxDim` × `maxDim` preserving aspect ratio |
| `detectLines(imageElement)` | Horizontal projection-profile analysis |
| `detectLinesWithBusyness(imageElement)` | Block-busyness (horizontal colour change) analysis |
| `detectHandwritingLines(imageElement)` | Combined: morphological region detection + busyness per region |

All functions return `Array<{x, y, width, height}>` in image-pixel coordinates.

#### `index.js` — `<handwriting-line-detector>`

A self-contained Custom Element. Include it in any HTML page:

```html
<script type="module" src="components/line-detection/index.js"></script>
<handwriting-line-detector src="https://example.org/image.jpg"></handwriting-line-detector>
```

The `src` attribute triggers detection. On completion the element fires a `lines-detected` custom event:

```js
detector.addEventListener('lines-detected', e => {
  console.log(e.detail.lines) // Array<{x,y,width,height}>
})
```

---

## TPEN 3 Interface — `interfaces/line-detection/`

A standalone web page that integrates with the [TPEN 3](https://three.t-pen.org) transcription platform.

### Usage

Open `interfaces/line-detection/index.html` with the following URL parameters:

```
?projectID=<TPEN3 project ID>&pageID=<TPEN3 page ID>
```

### Workflow

1. **Authenticate** — the interface redirects to TPEN 3 login if no valid token is found in `localStorage`.
2. **Load page** — the page's canvas is fetched from the TPEN 3 services API.
3. **Detect lines** — clicking _Detect Lines_ runs the browser-side detection and overlays bounding boxes.
4. **Save annotations** — clicking _Save Lines as Annotations_ writes the detected lines back to TPEN 3 as W3C Web Annotations with `motivation: "transcribing"` and `FragmentSelector` targets in canvas-coordinate space.

No backend proxy is involved at any step.
