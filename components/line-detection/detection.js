/**
 * Core line detection algorithms for handwriting images.
 * All operations run entirely in the browser using Canvas 2D API — no backend required.
 * @module detection
 */

/**
 * Resize an image element or canvas to fit within maxDimension while preserving aspect ratio.
 * Returns the original if it already fits.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} image
 * @param {number} [maxDimension=2048]
 * @returns {HTMLImageElement|HTMLCanvasElement}
 */
export function resizeImageIfNeeded(image, maxDimension = 2048) {
    const w = image.width ?? image.naturalWidth
    const h = image.height ?? image.naturalHeight
    if (w <= maxDimension && h <= maxDimension) return image

    let newWidth, newHeight
    if (w > h) {
        newWidth = maxDimension
        newHeight = Math.floor(h * (maxDimension / w))
    } else {
        newHeight = maxDimension
        newWidth = Math.floor(w * (maxDimension / h))
    }

    const canvas = document.createElement('canvas')
    canvas.width = newWidth
    canvas.height = newHeight
    canvas.getContext('2d').drawImage(image, 0, 0, newWidth, newHeight)
    return canvas
}

/**
 * Find text line bounding boxes using a horizontal projection profile.
 * Dark pixels (grayscale < 225) are counted per row; runs of high-count rows
 * become candidate lines.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} imageElement
 * @returns {Array<{x:number,y:number,width:number,height:number}>}
 */
export async function detectLines(imageElement) {
    const width = imageElement.width ?? imageElement.naturalWidth
    const height = imageElement.height ?? imageElement.naturalHeight

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imageElement, 0, 0, width, height)
    const { data } = ctx.getImageData(0, 0, width, height)

    const projection = new Array(height).fill(0)
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4
            const gray = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2])
            if ((255 - gray) > 30) projection[y]++
        }
    }

    const smoothed = _smooth(projection, height, 3)
    return _analyzeProjection(smoothed, height, width)
}

/**
 * Find text line bounding boxes by measuring row-level horizontal busyness
 * (colour change between adjacent horizontal blocks).
 *
 * @param {HTMLImageElement|HTMLCanvasElement} imageElement
 * @returns {Array<{x:number,y:number,width:number,height:number}>}
 */
export async function detectLinesWithBusyness(imageElement) {
    const width = imageElement.width ?? imageElement.naturalWidth
    const height = imageElement.height ?? imageElement.naturalHeight

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imageElement, 0, 0, width, height)
    const { data } = ctx.getImageData(0, 0, width, height)

    const blockSize = Math.max(3, Math.floor(height / 200))
    const busyness = new Array(height).fill(0)

    for (let y = blockSize; y < height - blockSize; y++) {
        for (let x = blockSize; x < width - blockSize; x += blockSize) {
            const cur = (y * width + x) * 4
            const left = (y * width + (x - blockSize)) * 4
            const diff = (Math.abs(data[cur] - data[left]) + Math.abs(data[cur + 1] - data[left + 1]) + Math.abs(data[cur + 2] - data[left + 2]))
            if (diff < 30) continue
            busyness[y] += diff / 3
            for (let offset = 1; offset <= blockSize / 2; offset++) {
                const w = (diff / 3) * (1 - offset / (blockSize / 2))
                if (y - offset >= 0) busyness[y - offset] += w
                if (y + offset < height) busyness[y + offset] += w
            }
        }
        busyness[y] /= width
    }

    const window = Math.max(5, Math.floor(height / 150))
    const smoothed = _smooth(busyness, height, window)
    return _analyzeBusynessProfile(smoothed, height, width)
}

/**
 * Combined detection: first locates text regions via morphological analysis,
 * then runs busyness-based detection within each region.  Falls back to
 * full-image busyness detection when no regions are found.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} imageElement
 * @returns {Promise<Array<{x:number,y:number,width:number,height:number}>>}
 */
export async function detectHandwritingLines(imageElement) {
    try {
        const regions = await _detectTextRegions(imageElement)
        if (!regions.length) return detectLinesWithBusyness(imageElement)

        const allLines = []
        for (const region of regions) {
            if (region.width < 50 || region.height < 50) continue
            const regionCanvas = document.createElement('canvas')
            regionCanvas.width = region.width
            regionCanvas.height = region.height
            regionCanvas.getContext('2d').drawImage(
                imageElement,
                region.x, region.y, region.width, region.height,
                0, 0, region.width, region.height
            )
            const regionLines = await detectLinesWithBusyness(regionCanvas)
            for (const line of regionLines) {
                allLines.push({ x: line.x + region.x, y: line.y + region.y, width: line.width, height: line.height })
            }
        }
        return allLines.length ? allLines : detectLinesWithBusyness(imageElement)
    } catch {
        return detectLinesWithBusyness(imageElement)
    }
}

// ── private helpers ────────────────────────────────────────────────────────────

function _smooth(arr, length, window) {
    return arr.map((_, i) => {
        let sum = 0, count = 0
        for (let j = Math.max(0, i - window); j < Math.min(length, i + window + 1); j++) {
            sum += arr[j]; count++
        }
        return sum / count
    })
}

function _stats(arr) {
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length
    return { mean, stdDev: Math.sqrt(variance) }
}

function _analyzeProjection(proj, height, width) {
    const { mean, stdDev } = _stats(proj)
    const threshold = mean + stdDev * 0.5

    const derivs = []
    for (let i = 1; i < height; i++) derivs.push(proj[i] - proj[i - 1])
    const smoothDerivs = _smooth(derivs, derivs.length, 3)

    const lines = []
    let inLine = false, startY = 0, lineMax = 0

    for (let y = 0; y < height; y++) {
        if (!inLine && (proj[y] > threshold || (y > 0 && smoothDerivs[y - 1] > stdDev * 0.3))) {
            inLine = true; startY = y; lineMax = proj[y]
        } else if (inLine && (proj[y] < threshold * 0.8 || (y > 0 && smoothDerivs[y - 1] < -stdDev * 0.3))) {
            inLine = false
            const h = y - startY
            if (h > 5 && lineMax > threshold * 1.2) lines.push({ x: 0, y: startY, width, height: h })
        }
        if (inLine) lineMax = Math.max(lineMax, proj[y])
    }
    if (inLine) {
        const h = height - startY
        if (h > 5 && lineMax > threshold * 1.2) lines.push({ x: 0, y: startY, width, height: h })
    }
    return lines.length <= 1 ? _findLinesWithLocalMaxima(proj, height, width) : lines
}

function _findLinesWithLocalMaxima(proj, height, width) {
    const minDist = Math.round(height * 0.02)
    let peaks = []
    for (let i = 1; i < height - 1; i++) {
        if (proj[i] > proj[i - 1] && proj[i] > proj[i + 1]) peaks.push({ y: i, value: proj[i] })
    }
    peaks.sort((a, b) => b.value - a.value)

    const significant = []
    const used = new Set()
    for (const peak of peaks) {
        if ([...used].every(y => Math.abs(peak.y - y) >= minDist)) {
            significant.push(peak)
            used.add(peak.y)
        }
    }
    significant.sort((a, b) => a.y - b.y)

    return significant.map((cur, i) => {
        const startY = i === 0 ? 0 : Math.floor((significant[i - 1].y + cur.y) / 2)
        const endY = i === significant.length - 1 ? height : Math.floor((cur.y + significant[i + 1].y) / 2)
        return endY - startY > 5 ? { x: 0, y: startY, width, height: endY - startY } : null
    }).filter(Boolean)
}

function _analyzeBusynessProfile(profile, height, width) {
    const { mean, stdDev } = _stats(profile)
    const threshold = mean + stdDev * 0.75

    const lines = []
    let inLine = false, startY = 0, peak = 0

    for (let y = 0; y < height; y++) {
        if (!inLine && profile[y] > threshold) { inLine = true; startY = y; peak = profile[y]; continue }
        if (inLine && profile[y] < threshold * 0.6) {
            inLine = false
            const h = y - startY
            if (h > 4 && peak > threshold * 1.1) lines.push({ x: 0, y: startY, width, height: h })
            continue
        }
        if (inLine) peak = Math.max(peak, profile[y])
    }
    if (inLine) {
        const h = height - startY
        if (h > 4 && peak > threshold * 1.1) lines.push({ x: 0, y: startY, width, height: h })
    }
    return lines.length ? lines : _findLinesWithLocalMaxima(profile, height, width)
}

async function _detectTextRegions(imageElement) {
    const width = imageElement.width ?? imageElement.naturalWidth
    const height = imageElement.height ?? imageElement.naturalHeight

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imageElement, 0, 0, width, height)
    const { data } = ctx.getImageData(0, 0, width, height)

    const ds = Math.max(1, Math.floor(Math.max(width, height) / 1000))
    const dsW = Math.floor(width / ds), dsH = Math.floor(height / ds)

    let sum = 0, cnt = 0
    for (let y = 0; y < height; y += ds * 2) {
        for (let x = 0; x < width; x += ds * 2) {
            const idx = (y * width + x) * 4
            sum += (data[idx] + data[idx + 1] + data[idx + 2]) / 3; cnt++
        }
    }
    const thresh = Math.min(40, (sum / cnt) * 0.5)

    const binary = Array.from({ length: dsH }, () => new Array(dsW).fill(0))
    for (let y = 0; y < dsH; y++) {
        for (let x = 0; x < dsW; x++) {
            const idx = (y * ds * width + x * ds) * 4
            binary[y][x] = (data[idx] + data[idx + 1] + data[idx + 2]) / 3 < (255 - thresh) ? 1 : 0
        }
    }

    const dilated = _dilate(binary, 2, dsW, dsH)
    const eroded = _erode(dilated, 1, dsW, dsH)
    const regions = _findConnectedComponents(eroded, dsW, dsH)
    return regions.map(r => ({ x: r.x * ds, y: r.y * ds, width: r.width * ds, height: r.height * ds }))
}

function _dilate(img, k, w, h) {
    const hk = Math.floor(k / 2)
    return img.map((row, y) => row.map((_, x) => {
        for (let ky = -hk; ky <= hk; ky++) {
            for (let kx = -hk; kx <= hk; kx++) {
                const ny = y + ky, nx = x + kx
                if (ny >= 0 && ny < h && nx >= 0 && nx < w && img[ny][nx] === 1) return 1
            }
        }
        return 0
    }))
}

function _erode(img, k, w, h) {
    const hk = Math.floor(k / 2)
    return img.map((row, y) => row.map((_, x) => {
        for (let ky = -hk; ky <= hk; ky++) {
            for (let kx = -hk; kx <= hk; kx++) {
                const ny = y + ky, nx = x + kx
                if (ny >= 0 && ny < h && nx >= 0 && nx < w && img[ny][nx] === 0) return 0
            }
        }
        return 1
    }))
}

function _findConnectedComponents(img, width, height) {
    // MAX caps the union-find table size. Images with very many tiny fragments may
    // silently reuse existing labels once this limit is reached, but in practice the
    // subsequent top-50 region filter discards such noisy components anyway.
    const MAX = 1000
    const parent = Array.from({ length: MAX }, (_, i) => i)
    function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])) }
    function union(a, b) { parent[find(a)] = find(b) }

    const label = Array.from({ length: height }, () => new Array(width).fill(0))
    let next = 1
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!img[y][x]) continue
            const neighbors = []
            if (y > 0 && label[y - 1][x]) neighbors.push(label[y - 1][x])
            if (x > 0 && label[y][x - 1]) neighbors.push(label[y][x - 1])
            if (!neighbors.length) { label[y][x] = next < MAX ? next++ : find(1) }
            else { label[y][x] = neighbors[0]; for (let i = 1; i < neighbors.length; i++) union(neighbors[0], neighbors[i]) }
        }
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (label[y][x]) label[y][x] = find(label[y][x])

    const counts = {}, minX = {}, minY = {}, maxX = {}, maxY = {}
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const l = label[y][x]; if (!l) continue
            counts[l] = (counts[l] || 0) + 1
            minX[l] = l in minX ? Math.min(minX[l], x) : x
            minY[l] = l in minY ? Math.min(minY[l], y) : y
            maxX[l] = l in maxX ? Math.max(maxX[l], x) : x
            maxY[l] = l in maxY ? Math.max(maxY[l], y) : y
        }
    }
    return Object.keys(counts)
        .map(l => ({ l: +l, count: counts[l] }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50)
        .map(({ l }) => {
            const w = maxX[l] - minX[l] + 1, h = maxY[l] - minY[l] + 1
            return (w >= 10 && h >= 10 && counts[l] / (w * h) >= 0.08)
                ? { x: minX[l], y: minY[l], width: w, height: h }
                : null
        })
        .filter(Boolean)
}
