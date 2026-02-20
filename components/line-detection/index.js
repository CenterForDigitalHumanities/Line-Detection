/**
 * <handwriting-line-detector> — Web Component
 *
 * Loads an image, runs automatic handwriting-line detection entirely in the
 * browser (no backend required) and overlays bounding boxes on the image.
 *
 * Attributes:
 *   src   — URL of the image to analyse (required)
 *
 * Events dispatched on the element:
 *   lines-detected  — fired when detection completes; detail: { lines }
 *
 * @module handwriting-line-detector
 */

import { resizeImageIfNeeded, detectHandwritingLines } from './detection.js'

class HandwritingLineDetector extends HTMLElement {
    constructor() {
        super()
        this.attachShadow({ mode: 'open' })
        this._lines = []
    }

    static get observedAttributes() {
        return ['src']
    }

    async attributeChangedCallback(name, _old, newValue) {
        if (name === 'src' && newValue) await this._processImage(newValue)
    }

    /** @returns {Array} The most recently detected lines */
    get lines() { return this._lines }

    async _processImage(imageUrl) {
        this._showLoading()
        try {
            const image = await this._loadImage(imageUrl)
            const resized = resizeImageIfNeeded(image, 2048)
            const lines = await detectHandwritingLines(resized)

            // Scale coordinates back when the image was resized
            if (resized !== image) {
                const sx = (image.naturalWidth || image.width) / resized.width
                const sy = (image.naturalHeight || image.height) / resized.height
                this._lines = lines.map(l => ({ x: l.x * sx, y: l.y * sy, width: l.width * sx, height: l.height * sy }))
            } else {
                this._lines = lines
            }

            this._render(imageUrl, this._lines, image.naturalWidth || image.width, image.naturalHeight || image.height)
            this.dispatchEvent(new CustomEvent('lines-detected', { bubbles: true, detail: { lines: this._lines } }))
        } catch (err) {
            this._showError(err.message)
        }
    }

    /** Load an image cross-origin (IIIF and most public image servers allow this). */
    _loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => resolve(img)
            img.onerror = () => reject(new Error(`Could not load image: ${url}`))
            img.src = url
        })
    }

    _showLoading() {
        const style = document.createElement('style')
        style.textContent = ':host { display: block; } .loading { padding: 20px; text-align: center; font-family: sans-serif; }'
        const div = document.createElement('div')
        div.className = 'loading'
        div.textContent = 'Detecting lines…'
        this.shadowRoot.replaceChildren(style, div)
    }

    _showError(msg) {
        const div = document.createElement('div')
        div.textContent = `Error: ${msg}`
        const p = document.createElement('p')
        p.textContent = 'This may be due to CORS restrictions on the image server.'
        const style = document.createElement('style')
        style.textContent = ':host { display: block; } .error { padding: 20px; color: red; font-family: sans-serif; text-align: center; }'
        div.className = 'error'
        div.appendChild(document.createElement('br'))
        div.appendChild(p)
        this.shadowRoot.replaceChildren(style, div)
    }

    _render(imageUrl, lines, naturalWidth, naturalHeight) {
        const style = document.createElement('style')
        style.textContent = `
            :host { display: block; }
            .container { position: relative; display: inline-block; max-width: 100%; }
            img { display: block; max-width: 100%; width: 100%; height: auto; }
            .box {
                position: absolute;
                border: 2px solid red;
                pointer-events: none;
                box-sizing: border-box;
            }`

        const container = document.createElement('div')
        container.className = 'container'

        const img = document.createElement('img')
        img.src = imageUrl
        img.alt = 'Handwriting image'
        img.crossOrigin = 'anonymous'
        container.appendChild(img)

        lines.forEach(l => {
            const box = document.createElement('div')
            box.className = 'box'
            box.dataset.x = l.x
            box.dataset.y = l.y
            box.dataset.w = l.width
            box.dataset.h = l.height
            container.appendChild(box)
        })

        this.shadowRoot.replaceChildren(style, container)

        const updateBoxes = () => {
            if (!img.naturalHeight) return
            this.shadowRoot.querySelectorAll('.box').forEach(box => {
                const x = +box.dataset.x, y = +box.dataset.y, w = +box.dataset.w, h = +box.dataset.h
                box.style.left   = `${(x / naturalWidth) * 100}%`
                box.style.top    = `${(y / naturalHeight) * 100}%`
                box.style.width  = `${(w / naturalWidth) * 100}%`
                box.style.height = `${(h / naturalHeight) * 100}%`
            })
        }
        img.addEventListener('load', updateBoxes)
        if (img.complete) updateBoxes()
    }
}

customElements.define('handwriting-line-detector', HandwritingLineDetector)
export default HandwritingLineDetector
