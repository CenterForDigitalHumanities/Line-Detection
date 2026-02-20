/**
 * Line Detection — TPEN 3 Interface
 *
 * Loads a canvas image from a TPEN 3 project page, runs automatic
 * handwriting-line detection entirely in the browser, and saves the
 * detected lines back to TPEN 3 as Web Annotations.
 *
 * Required URL parameters:
 *   projectID — TPEN 3 project identifier
 *   pageID    — TPEN 3 page (AnnotationPage) identifier
 *
 * Authentication is handled by reading / writing the TPEN3 `userToken`
 * from localStorage (same mechanism used by the main TPEN-interfaces repo).
 */

import '../../components/line-detection/index.js'

// ── Configuration ─────────────────────────────────────────────────────────────

const TPEN3_URL = 'https://three.t-pen.org'
const SERVICES_URL = 'https://dev.api.t-pen.org'

// ── DOM references ────────────────────────────────────────────────────────────

const statusEl   = document.getElementById('status')
const controlsEl = document.getElementById('controls')
const detectBtn  = document.getElementById('detectBtn')
const saveBtn    = document.getElementById('saveBtn')
const clearBtn   = document.getElementById('clearBtn')
const loginPrompt   = document.getElementById('login-prompt')
const loginLink     = document.getElementById('loginLink')
const detectorWrap  = document.getElementById('detector-wrapper')
const detector      = document.getElementById('detector')

// ── State ─────────────────────────────────────────────────────────────────────

const params    = new URLSearchParams(location.search)
const projectID = params.get('projectID')
const pageID    = params.get('pageID')

let userToken   = null
let canvasID    = null   // IIIF Canvas URI
let imageURL    = null   // full image URL derived from the canvas
let imageDims   = { w: 0, h: 0 }  // natural image dimensions
let canvasDims  = { w: 0, h: 0 }  // canvas dimensions (for selector scaling)
let detectedLines = []

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(msg, type = '') {
    statusEl.textContent = msg
    statusEl.className = type
}

function getToken() {
    // Accept token from URL (first load) or localStorage (subsequent loads)
    const fromUrl = params.get('idToken')
    if (fromUrl) {
        localStorage.setItem('userToken', fromUrl)
        // Clean token from URL bar
        const clean = new URL(location.href)
        clean.searchParams.delete('idToken')
        history.replaceState(null, '', clean.toString())
        return fromUrl
    }
    return localStorage.getItem('userToken')
}

function isTokenExpired(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]))
        return payload.exp * 1000 < Date.now()
    } catch {
        return true
    }
}

function requireLogin() {
    loginLink.href = `${TPEN3_URL}/login?returnTo=${encodeURIComponent(location.href)}`
    loginPrompt.style.display = 'block'
    setStatus('Please log in to continue.', 'error')
}

// ── TPEN Services helpers ─────────────────────────────────────────────────────

async function fetchJSON(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userToken}`,
            ...(options.headers ?? {})
        }
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
    return res.json()
}

/** Extract the trailing ID segment from a TPEN URI or bare ID string. */
function extractId(uri) {
    return (uri ?? '').split('/').pop()
}

/**
 * Load a TPEN 3 page and return the resolved AnnotationPage object.
 */
async function loadPage(projID, pgID) {
    return fetchJSON(`${SERVICES_URL}/project/${projID}/page/${extractId(pgID)}`)
}

/**
 * Resolve a Canvas URI to a plain object (tries IIIF Presentation API v3/v2).
 */
async function loadCanvas(uri) {
    return fetch(uri, { headers: { Accept: 'application/json' } }).then(r => r.ok ? r.json() : null)
}

/**
 * Extract the full image URL from a IIIF Canvas object.
 */
function getImageURLFromCanvas(canvas) {
    // Presentation API v3
    const body = canvas?.items?.[0]?.items?.[0]?.body
    if (body?.id) return body.id
    if (body?.['@id']) return body['@id']
    // Presentation API v2
    const res = canvas?.images?.[0]?.resource
    if (res?.['@id']) return res['@id']
    return null
}

/**
 * Build a Web Annotation in IIIF / W3C format from a detected line box.
 * Coordinates are stored relative to the Canvas dimensions (not image pixels),
 * consistent with TPEN 3 conventions.
 *
 * @param {{ x:number, y:number, width:number, height:number }} line — image-space coordinates
 * @returns {object}
 */
function lineToAnnotation(line) {
    // Scale from image-space to canvas-space
    const scaleX = imageDims.w ? canvasDims.w / imageDims.w : 1
    const scaleY = imageDims.h ? canvasDims.h / imageDims.h : 1
    const x = Math.round(line.x * scaleX)
    const y = Math.round(line.y * scaleY)
    const w = Math.round(line.width * scaleX)
    const h = Math.round(line.height * scaleY)

    return {
        type: 'Annotation',
        motivation: 'transcribing',
        body: [],
        target: {
            source: canvasID,
            type: 'SpecificResource',
            selector: {
                type: 'FragmentSelector',
                conformsTo: 'http://www.w3.org/TR/media-frags/',
                value: `xywh=pixel:${x},${y},${w},${h}`
            }
        }
    }
}

// ── Detection ─────────────────────────────────────────────────────────────────

// Handle the lines-detected event from the custom element (registered once at startup)
function onLinesDetected(e) {
    detectedLines = e.detail.lines
    if (detectedLines.length) {
        saveBtn.disabled  = false
        clearBtn.disabled = false
        setStatus(`Detected ${detectedLines.length} line(s). Review them, then click "Save Lines as Annotations".`, 'success')
    } else {
        setStatus('No lines detected. Try a different image or adjust the image quality.', 'error')
    }
    detectBtn.disabled = false
}

async function runDetection() {
    if (!imageURL) { setStatus('No image loaded.', 'error'); return }
    detectBtn.disabled = true
    saveBtn.disabled   = true
    clearBtn.disabled  = true
    setStatus('Loading image and detecting lines…')

    // Remove existing src to force re-processing when re-running
    detector.removeAttribute('src')
    detector.setAttribute('src', imageURL)
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function saveAnnotations() {
    if (!detectedLines.length) return
    saveBtn.disabled = true
    setStatus('Saving annotations…')

    const annotations = detectedLines.map(lineToAnnotation)

    try {
        await fetchJSON(
            `${SERVICES_URL}/project/${projectID}/page/${extractId(pageID)}`,
            { method: 'PUT', body: JSON.stringify({ items: annotations }) }
        )
        setStatus(`Saved ${annotations.length} annotation(s) to TPEN 3.`, 'success')
    } catch (err) {
        setStatus(`Save failed: ${err.message}`, 'error')
        saveBtn.disabled = false
    }
}

// ── Initialise ────────────────────────────────────────────────────────────────

async function init() {
    if (!projectID || !pageID) {
        setStatus('Missing required URL parameters: projectID and pageID.', 'error')
        return
    }

    userToken = getToken()
    if (!userToken || isTokenExpired(userToken)) {
        requireLogin()
        return
    }

    setStatus('Loading page from TPEN 3…')
    let page
    try {
        page = await loadPage(projectID, pageID)
    } catch (err) {
        setStatus(`Could not load page: ${err.message}`, 'error')
        return
    }

    const targetCanvas = page.target
    if (!targetCanvas) {
        setStatus('The TPEN 3 page does not reference a canvas.', 'error')
        return
    }
    const canvasURI = typeof targetCanvas === 'string' ? targetCanvas
        : (targetCanvas.id ?? targetCanvas['@id'] ?? targetCanvas.source)
    if (!canvasURI) {
        setStatus('Could not determine canvas URI from the page.', 'error')
        return
    }
    canvasID = canvasURI

    setStatus('Loading canvas…')
    let canvas
    try {
        canvas = await loadCanvas(canvasURI)
    } catch {
        canvas = null
    }

    if (canvas) {
        canvasDims.w = canvas.width ?? canvas['@width'] ?? 0
        canvasDims.h = canvas.height ?? canvas['@height'] ?? 0
        imageURL = getImageURLFromCanvas(canvas)
    }

    if (!imageURL) {
        // If canvas resolution fails (e.g. CORS), treat the canvas URI as the image URL
        imageURL = canvasURI
    }

    // Probe natural image dimensions so we can scale selectors correctly
    await new Promise(resolve => {
        const probe = new Image()
        probe.crossOrigin = 'anonymous'
        probe.onload  = () => { imageDims.w = probe.naturalWidth; imageDims.h = probe.naturalHeight; resolve() }
        probe.onerror = () => resolve()
        probe.src = imageURL
    })
    if (!canvasDims.w) canvasDims.w = imageDims.w
    if (!canvasDims.h) canvasDims.h = imageDims.h

    detectorWrap.style.display = 'block'
    controlsEl.style.display   = 'flex'
    setStatus('Image ready. Click "Detect Lines" to start automatic line detection.')

    // Wire up the lines-detected event once (handles multiple detect runs)
    detector.addEventListener('lines-detected', onLinesDetected)

    // Wire up controls
    detectBtn.addEventListener('click', runDetection)
    saveBtn.addEventListener('click', saveAnnotations)
    clearBtn.addEventListener('click', () => {
        detector.removeAttribute('src')
        detectedLines = []
        saveBtn.disabled  = true
        clearBtn.disabled = true
        setStatus('Detection cleared. Click "Detect Lines" to run again.')
    })
}

init()
