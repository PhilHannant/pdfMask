pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// --- NAVIGATION SWITCHING ---
function switchTool(index) {
    const panels = document.querySelectorAll('.tool-panel');
    const buttons = document.querySelectorAll('.nav-btn');
    panels.forEach((p, i) => p.classList.toggle('active', i === index));
    buttons.forEach((b, i) => b.classList.toggle('active', i === index));
}

// --- TOOL 1: REDACTOR ---
//
// How redaction works:
// A box drawn over a PDF page is only cosmetic, because the text, images and
// vector content underneath stay in the file and can be copied or extracted.
// To remove them, every page that has at least one redaction box is rendered
// to an image with the boxes painted solid black, and that image replaces the
// original page. Nothing from the original page survives in the output.
// Pages with no boxes are copied across unchanged so they keep selectable text.

const REDACT_RENDER_SCALE = 3;      // 216 dpi for rasterised pages
const REDACT_JPEG_QUALITY = 0.92;
const MIN_BOX_PX = 4;               // ignore accidental clicks

const fileInput = document.getElementById('pdfFile');
const wrapper = document.getElementById('canvas-wrapper');
const pdfCanvas = document.getElementById('pdf-canvas');
const selectionCanvas = document.getElementById('selection-canvas');
const pdfCtx = pdfCanvas.getContext('2d');
const selectionCtx = selectionCanvas.getContext('2d');
const statusDiv = document.getElementById('status');
const applyBtn = document.getElementById('applyBtn');
const clearBtn = document.getElementById('clearBtn');
const undoBtn = document.getElementById('undoBtn');
const prevBtn = document.getElementById('prevPage');
const nextBtn = document.getElementById('nextPage');
const pageInfo = document.getElementById('pageInfo');
const pageNav = document.getElementById('page-nav');

let rawArrayBuffer = null;
let sourceFileName = 'document.pdf';
let pdfJsDoc = null;
let currentPage = 1;
let renderTask = null;
// Boxes are stored per page in normalised coordinates (0–1 of the rendered
// page), so they stay correct at any display size or render scale.
let boxesByPage = new Map();
let drag = null;

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    resetRedactor();
    sourceFileName = file.name || 'document.pdf';
    statusDiv.textContent = 'Opening document on your device…';

    try {
        rawArrayBuffer = await file.arrayBuffer();
        // pdf.js may transfer the buffer it is given, so pass a copy.
        pdfJsDoc = await pdfjsLib.getDocument({ data: rawArrayBuffer.slice(0) }).promise;
    } catch (err) {
        rawArrayBuffer = null;
        statusDiv.textContent = err && err.name === 'PasswordException'
            ? 'This PDF needs a password to open. Remove the password first, then try again.'
            : 'Could not open this PDF: ' + (err && err.message ? err.message : err);
        return;
    }

    wrapper.style.display = 'inline-block';
    pageNav.style.display = 'flex';
    await showPage(1);
    statusDiv.textContent = 'Click and drag over anything you want to remove. You can mark several areas on any page.';
});

function resetRedactor() {
    if (renderTask) renderTask.cancel();
    if (pdfJsDoc) pdfJsDoc.destroy();
    pdfJsDoc = null;
    rawArrayBuffer = null;
    boxesByPage = new Map();
    currentPage = 1;
    drag = null;
    updateControls();
}

async function showPage(pageNum) {
    if (!pdfJsDoc) return;
    currentPage = pageNum;
    const page = await pdfJsDoc.getPage(pageNum);

    // Fit the page to the available width, rendered sharply on high-DPI screens.
    const available = Math.max(wrapper.parentElement.clientWidth - 2, 200);
    const base = page.getViewport({ scale: 1 });
    const cssScale = Math.min(1.5, available / base.width);
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: cssScale * dpr });

    for (const c of [pdfCanvas, selectionCanvas]) {
        c.width = Math.floor(viewport.width);
        c.height = Math.floor(viewport.height);
        c.style.width = Math.floor(viewport.width / dpr) + 'px';
        c.style.height = Math.floor(viewport.height / dpr) + 'px';
    }

    if (renderTask) renderTask.cancel();
    renderTask = page.render({ canvasContext: pdfCtx, viewport });
    try {
        await renderTask.promise;
    } catch (err) {
        if (err && err.name === 'RenderingCancelledException') return;
        throw err;
    } finally {
        renderTask = null;
    }
    drawBoxes();
    updateControls();
}

function pointerToNormalised(e) {
    const rect = selectionCanvas.getBoundingClientRect();
    return {
        x: Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1),
        y: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
    };
}

selectionCanvas.addEventListener('pointerdown', (e) => {
    if (!pdfJsDoc) return;
    e.preventDefault();
    selectionCanvas.setPointerCapture(e.pointerId);
    const p = pointerToNormalised(e);
    drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
});

selectionCanvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pointerToNormalised(e);
    drag.x1 = p.x;
    drag.y1 = p.y;
    drawBoxes();
});

function endDrag() {
    if (!drag) return;
    const box = normaliseDrag(drag);
    drag = null;
    const rect = selectionCanvas.getBoundingClientRect();
    if (box.w * rect.width >= MIN_BOX_PX && box.h * rect.height >= MIN_BOX_PX) {
        if (!boxesByPage.has(currentPage)) boxesByPage.set(currentPage, []);
        boxesByPage.get(currentPage).push(box);
    }
    drawBoxes();
    updateControls();
}

selectionCanvas.addEventListener('pointerup', endDrag);
selectionCanvas.addEventListener('pointercancel', endDrag);

function normaliseDrag(d) {
    return {
        x: Math.min(d.x0, d.x1),
        y: Math.min(d.y0, d.y1),
        w: Math.abs(d.x1 - d.x0),
        h: Math.abs(d.y1 - d.y0)
    };
}

function drawBoxes() {
    const W = selectionCanvas.width;
    const H = selectionCanvas.height;
    selectionCtx.clearRect(0, 0, W, H);
    selectionCtx.lineWidth = 2 * (window.devicePixelRatio || 1);

    const boxes = (boxesByPage.get(currentPage) || []).slice();
    if (drag) boxes.push(normaliseDrag(drag));

    for (const b of boxes) {
        selectionCtx.fillStyle = 'rgba(15, 23, 42, 0.75)';
        selectionCtx.strokeStyle = '#dc2626';
        selectionCtx.fillRect(b.x * W, b.y * H, b.w * W, b.h * H);
        selectionCtx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
    }
}

function totalBoxes() {
    let n = 0;
    for (const list of boxesByPage.values()) n += list.length;
    return n;
}

function updateControls() {
    const pageCount = pdfJsDoc ? pdfJsDoc.numPages : 0;
    const onPage = (boxesByPage.get(currentPage) || []).length;
    const total = totalBoxes();
    const pagesMarked = [...boxesByPage.values()].filter(l => l.length).length;

    prevBtn.disabled = !pdfJsDoc || currentPage <= 1;
    nextBtn.disabled = !pdfJsDoc || currentPage >= pageCount;
    undoBtn.disabled = onPage === 0;
    clearBtn.disabled = onPage === 0;
    applyBtn.disabled = total === 0;

    pageInfo.textContent = pdfJsDoc
        ? `Page ${currentPage} of ${pageCount}` +
          (total ? ` · ${total} area${total === 1 ? '' : 's'} marked on ${pagesMarked} page${pagesMarked === 1 ? '' : 's'}` : '')
        : '';
}

let resizeTimer = null;
window.addEventListener('resize', () => {
    if (!pdfJsDoc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => showPage(currentPage), 200);
});

prevBtn.addEventListener('click',() => { if (currentPage > 1) showPage(currentPage - 1); });
nextBtn.addEventListener('click', () => { if (pdfJsDoc && currentPage < pdfJsDoc.numPages) showPage(currentPage + 1); });

undoBtn.addEventListener('click', () => {
    const list = boxesByPage.get(currentPage);
    if (list && list.length) list.pop();
    drawBoxes();
    updateControls();
});

clearBtn.addEventListener('click', () => {
    boxesByPage.delete(currentPage);
    drawBoxes();
    updateControls();
});

applyBtn.addEventListener('click', async () => {
    if (!pdfJsDoc || totalBoxes() === 0) return;
    applyBtn.disabled = true;
    statusDiv.textContent = 'Removing the marked content on your device…';

    try {
        const bytes = await buildRedactedPdf((done, total) => {
            statusDiv.textContent = `Removing the marked content on your device… page ${done} of ${total}`;
        });
        triggerDownload(bytes, redactedFileName(sourceFileName));
        statusDiv.textContent = 'Done. Marked areas have been permanently removed and the file has downloaded. ' +
            'Redacted pages are now images, so their text can no longer be selected or searched.';
    } catch (err) {
        statusDiv.textContent = 'Error: ' + (err && err.message ? err.message : err);
        console.error(err);
    } finally {
        updateControls();
    }
});

async function buildRedactedPdf(onProgress) {
    const { PDFDocument, PDFName } = PDFLib;
    const pageCount = pdfJsDoc.numPages;

    // Load the original with pdf-lib so untouched pages can be copied as-is.
    // If that isn't possible (encrypted or damaged file), rasterise every page.
    let src = null;
    try {
        src = await PDFDocument.load(new Uint8Array(rawArrayBuffer), { ignoreEncryption: true });
        if (src.isEncrypted) src = null;
    } catch (err) {
        src = null;
    }
    if (src) stripCrossPageReferences(src, PDFName);

    // A brand-new document: no metadata, bookmarks, attachments or scripts
    // carry over from the original.
    const out = await PDFDocument.create();
    out.setProducer('pdfMask');
    out.setCreator('pdfMask');

    for (let i = 1; i <= pageCount; i++) {
        const boxes = boxesByPage.get(i) || [];
        if (boxes.length === 0 && src) {
            const [copied] = await out.copyPages(src, [i - 1]);
            out.addPage(copied);
        } else {
            await addRasterisedPage(out, i, boxes);
        }
        onProgress(i, pageCount);
    }

    return out.save();
}

// Copying a page with pdf-lib also copies every object it references. Some
// annotation entries point at other pages (a link's destination, a form
// field's parent and its widgets), which could drag a redacted page's original
// content into the output. Remove those references before copying.
function stripCrossPageReferences(doc, PDFName) {
    for (const page of doc.getPages()) {
        const annots = page.node.Annots();
        if (!annots) continue;
        for (let i = 0; i < annots.size(); i++) {
            const annot = annots.lookup(i);
            if (!annot || typeof annot.delete !== 'function') continue;
            annot.delete(PDFName.of('P'));
            annot.delete(PDFName.of('Dest'));
            annot.delete(PDFName.of('A'));
            annot.delete(PDFName.of('IRT'));
            const subtype = annot.lookup(PDFName.of('Subtype'));
            if (subtype && subtype.toString() === '/Widget') annot.delete(PDFName.of('Parent'));
        }
    }
}

async function addRasterisedPage(out, pageNum, boxes) {
    const page = await pdfJsDoc.getPage(pageNum);
    const pointSize = page.getViewport({ scale: 1 });   // page size in PDF points, rotation applied
    const viewport = page.getViewport({ scale: REDACT_RENDER_SCALE });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Include form field values and other annotations in the image, so they
    // are covered by the boxes like everything else.
    await page.render({
        canvasContext: ctx,
        viewport,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE
    }).promise;

    // Paint the boxes, rounded outwards so no partial pixels leak at the edges.
    ctx.fillStyle = '#000000';
    for (const b of boxes) {
        const x0 = Math.floor(b.x * canvas.width) - 1;
        const y0 = Math.floor(b.y * canvas.height) - 1;
        const x1 = Math.ceil((b.x + b.w) * canvas.width) + 1;
        const y1 = Math.ceil((b.y + b.h) * canvas.height) + 1;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }

    const jpeg = await new Promise((resolve, reject) =>
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not encode page image')),
            'image/jpeg', REDACT_JPEG_QUALITY));
    const image = await out.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));

    const newPage = out.addPage([pointSize.width, pointSize.height]);
    newPage.drawImage(image, { x: 0, y: 0, width: pointSize.width, height: pointSize.height });

    canvas.width = canvas.height = 0;   // free memory before the next page
    page.cleanup();
}

function redactedFileName(name) {
    const base = name.replace(/\.pdf$/i, '');
    return base + '-redacted.pdf';
}

// --- TOOL 2 & 3 LOGIC ---
async function executeMerge() {
    const input = document.getElementById('mergeFiles');
    const status = document.getElementById('mergeStatus');
    if (input.files.length < 2) { alert('Select at least 2 files.'); return; }
    status.textContent = 'Merging locally...';
    try {
        const { PDFDocument } = PDFLib;
        const merged = await PDFDocument.create();
        for (const file of input.files) {
            const buf = await file.arrayBuffer();
            const pdf = await PDFDocument.load(new Uint8Array(buf));
            const pages = await merged.copyPages(pdf, pdf.getPageIndices());
            pages.forEach(p => merged.addPage(p));
        }
        triggerDownload(await merged.save(), 'merged-output.pdf');
        status.textContent = 'Success!';
    } catch(e) { status.textContent = 'Error: ' + e.message; }
}

async function executeUnlock() {
    const input = document.getElementById('unlockFile');
    const status = document.getElementById('unlockStatus');
    if (!input.files.length) { alert('Select a file.'); return; }
    status.textContent = 'Stripping restrictions locally...';
    try {
        const { PDFDocument } = PDFLib;
        const buf = await input.files[0].arrayBuffer();
        const pdf = await PDFDocument.load(new Uint8Array(buf));
        if (typeof pdf.removeProtection === 'function') pdf.removeProtection();
        triggerDownload(await pdf.save(), 'unlocked-output.pdf');
        status.textContent = 'Success!';
    } catch(e) { status.textContent = 'Error: ' + e.message; }
}

function triggerDownload(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}
