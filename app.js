// pdfMask: every tool runs in the browser. Files are read into memory and
// processed here; nothing is uploaded.
//
// One script serves every page. Each tool starts only if its controls are on
// the current page, so pages without a tool don't need the PDF libraries.
//
// The libraries are served from this site (vendor/, copied from pinned npm
// packages at build time), never from another server. The site's security
// policy (_headers) also stops these pages connecting anywhere else.

// pdf.js does its parsing in a background worker. Starting it with the page,
// not on first use, means nothing has to be fetched once you choose a file,
// so the tools keep working even with the network switched off.
let pdfWorker = null;
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-3.11.174/pdf.worker.min.js';
    pdfWorker = new pdfjsLib.PDFWorker();
}

const byId = id => document.getElementById(id);

// Every PDF is opened through here. isEvalSupported is switched off because
// pdf.js before 4.2.67 can be tricked by a malicious PDF into running code
// when it is on (CVE-2024-4367). The security policy blocks eval as well.
function openPdf(data) {
    return pdfjsLib.getDocument({ data, worker: pdfWorker, isEvalSupported: false }).promise;
}

if (byId('pdfFile')) initRedactor();
if (byId('mergeFiles')) initMerge();
if (byId('checkFile')) initChecker();
if (byId('unlockFile')) initUnlock();

function errorText(err) {
    return err && err.message ? err.message : String(err);
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

// =====================================================================
// REDACTOR
//
// A box drawn over a PDF page is only cosmetic, because the text, images and
// vector content underneath stay in the file and can be copied or extracted.
// To remove them, every page that has at least one redaction box is rendered
// to an image with the boxes painted solid black, and that image replaces the
// original page. Nothing from the original page survives in the output.
// Pages with no boxes are copied across unchanged so they keep selectable text.
// =====================================================================

function initRedactor() {
    const REDACT_RENDER_SCALE = 3;      // 216 dpi for rasterised pages
    const REDACT_JPEG_QUALITY = 0.92;
    const MIN_BOX_PX = 4;               // ignore accidental clicks

    const fileInput = byId('pdfFile');
    const wrapper = byId('canvas-wrapper');
    const pdfCanvas = byId('pdf-canvas');
    const selectionCanvas = byId('selection-canvas');
    const pdfCtx = pdfCanvas.getContext('2d');
    const selectionCtx = selectionCanvas.getContext('2d');
    const statusDiv = byId('status');
    const applyBtn = byId('applyBtn');
    const clearBtn = byId('clearBtn');
    const undoBtn = byId('undoBtn');
    const prevBtn = byId('prevPage');
    const nextBtn = byId('nextPage');
    const pageInfo = byId('pageInfo');
    const pageNav = byId('page-nav');

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
            pdfJsDoc = await openPdf(rawArrayBuffer.slice(0));
        } catch (err) {
            rawArrayBuffer = null;
            statusDiv.textContent = err && err.name === 'PasswordException'
                ? 'This PDF needs a password to open. Remove the password first with pdfMask\'s Remove PDF Password tool, then try again.'
                : 'Could not open this PDF: ' + errorText(err);
            return;
        }

        wrapper.hidden = false;
        pageNav.hidden = false;
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

    prevBtn.addEventListener('click', () => { if (currentPage > 1) showPage(currentPage - 1); });
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
            statusDiv.textContent = 'Error: ' + errorText(err);
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
    // field's parent and its widgets), which could drag a redacted page's
    // original content into the output. Remove those references before copying.
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
        return name.replace(/\.pdf$/i, '') + '-redacted.pdf';
    }
}

// =====================================================================
// MERGE
// =====================================================================

function initMerge() {
    const input = byId('mergeFiles');
    const list = byId('mergeList');
    const button = byId('mergeBtn');
    const status = byId('mergeStatus');

    input.addEventListener('change', () => {
        list.innerHTML = '';
        for (const file of input.files) {
            const li = document.createElement('li');
            li.textContent = file.name;
            list.appendChild(li);
        }
        button.disabled = input.files.length < 2;
        status.textContent = input.files.length === 1 ? 'Choose at least two PDFs to merge.' : '';
    });

    button.addEventListener('click', async () => {
        if (input.files.length < 2) {
            status.textContent = 'Choose at least two PDFs to merge.';
            return;
        }
        button.disabled = true;
        status.textContent = 'Merging on your device…';
        try {
            const { PDFDocument } = PDFLib;
            const merged = await PDFDocument.create();
            for (const file of input.files) {
                let pdf;
                try {
                    pdf = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
                } catch (err) {
                    throw new Error(/encrypted/i.test(errorText(err))
                        ? `"${file.name}" is password-protected or restricted, so it can't be merged. Unlock it first with pdfMask's Unlock PDF tool, then try again.`
                        : `"${file.name}" couldn't be read as a PDF.`);
                }
                const pages = await merged.copyPages(pdf, pdf.getPageIndices());
                pages.forEach(p => merged.addPage(p));
            }
            triggerDownload(await merged.save(), 'merged.pdf');
            status.textContent = `Done. ${input.files.length} files merged into one PDF and downloaded.`;
        } catch (err) {
            status.textContent = 'Error: ' + errorText(err);
        } finally {
            button.disabled = input.files.length < 2;
        }
    });
}

// =====================================================================
// UNLOCK / REMOVE PASSWORD
//
// pdf-lib can't read encrypted PDFs, and restricted PDFs are always
// encrypted, so this tool uses qpdf compiled to WebAssembly instead. It runs
// in a worker (unlock-worker.js), which starts with the page and loads qpdf
// straight away, so nothing needs fetching once you choose a file.
//
// Flow: inspect the file first. If it only has restrictions, it can be
// decrypted straight away. If it needs a password to open, ask for it.
// (Supplying a password to a restrictions-only file makes qpdf fail, so
// the password box only appears when one is actually needed.)
// =====================================================================

function initUnlock() {
    const input = byId('unlockFile');
    const passwordRow = byId('unlockPasswordRow');
    const passwordInput = byId('unlockPassword');
    const button = byId('unlockBtn');
    const status = byId('unlockStatus');

    let worker = null;
    let nextId = 1;
    const pending = new Map();
    let file = null;
    let bytes = null;
    let needsPassword = false;

    function startWorker() {
        if (worker) return;
        worker = new Worker('/unlock-worker.js');
        worker.onmessage = ({ data }) => {
            const done = pending.get(data.id);
            pending.delete(data.id);
            if (done) done.resolve(data);
        };
        worker.onerror = (e) => {
            e.preventDefault();
            for (const done of pending.values()) done.reject(new Error('engine'));
            pending.clear();
            worker.terminate();
            worker = null;
        };
    }

    function ask(op, extra = {}) {
        startWorker();
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            // Send a copy: the original is kept for a retry with another password.
            worker.postMessage({ id, op, bytes: bytes.slice(), ...extra });
        });
    }

    function engineError(err) {
        return err && err.message === 'engine'
            ? 'Couldn\'t load the unlock engine. Reload the page and try again.'
            : 'Error: ' + errorText(err);
    }

    startWorker();

    function reset() {
        passwordRow.hidden = true;
        passwordInput.value = '';
        button.disabled = true;
        needsPassword = false;
    }

    input.addEventListener('change', async () => {
        reset();
        file = input.files[0] || null;
        bytes = null;
        if (!file) {
            status.textContent = '';
            return;
        }
        status.textContent = 'Checking the file on your device…';
        try {
            bytes = new Uint8Array(await file.arrayBuffer());
            const info = await ask('inspect');
            if (info.error) throw new Error(info.error);
            if (info.damaged) {
                status.textContent = 'This file couldn\'t be read as a PDF. It may be damaged.';
                return;
            }
            if (!info.encrypted) {
                status.textContent = 'This PDF isn\'t locked. It has no password or restrictions to remove.';
                return;
            }
            needsPassword = info.needsPassword;
            if (needsPassword) {
                passwordRow.hidden = false;
                status.textContent = 'This PDF needs a password to open. Enter it to save a copy that opens without one.';
                passwordInput.focus();
            } else {
                status.textContent = 'This PDF has restrictions. Click Unlock to save a copy without them.';
            }
            button.disabled = false;
        } catch (err) {
            status.textContent = engineError(err);
        }
    });

    passwordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !button.disabled) button.click();
    });

    button.addEventListener('click', async () => {
        if (!bytes) return;
        if (needsPassword && !passwordInput.value) {
            status.textContent = 'Enter the PDF\'s password first.';
            passwordInput.focus();
            return;
        }
        button.disabled = true;
        status.textContent = 'Unlocking on your device…';
        try {
            const result = await ask('unlock', needsPassword ? { password: passwordInput.value } : {});
            if (result.error) throw new Error(result.error);
            if (result.ok) {
                triggerDownload(result.bytes, file.name.replace(/\.pdf$/i, '') + '-unlocked.pdf');
                status.textContent = needsPassword
                    ? 'Done. The unlocked copy has downloaded and opens without a password.'
                    : 'Done. The unlocked copy has downloaded without its restrictions.';
            } else if (needsPassword) {
                status.textContent = 'That password isn\'t right. Check it and try again.';
                passwordInput.select();
            } else {
                status.textContent = 'This PDF couldn\'t be unlocked. It may be damaged or use an unsupported type of protection.';
            }
        } catch (err) {
            status.textContent = engineError(err);
        } finally {
            button.disabled = !bytes;
        }
    });
}

// =====================================================================
// REDACTION CHECKER
//
// Looks for the common ways a "redacted" PDF still leaks:
//  1. Text that is still in the file but can't be seen on the page, because
//     a box, an image or a white rectangle has been drawn over it, or it is
//     set to be invisible. Each piece of text is located on the rendered page;
//     if the pixels where it should appear are a flat colour, the text is
//     there but hidden.
//  2. Redaction marks that were added but never applied.
//  3. Things worth checking: earlier saved versions still inside the file,
//     document properties, attachments and comments.
// =====================================================================

function initChecker() {
    const CHECK_SCALE = 2;
    const MAX_PREVIEW_PAGES = 5;

    const input = byId('checkFile');
    const status = byId('checkStatus');
    const results = byId('checkResults');

    input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        results.innerHTML = '';
        status.textContent = 'Checking on your device…';

        let doc;
        let bytes;
        try {
            bytes = new Uint8Array(await file.arrayBuffer());
            doc = await openPdf(bytes.slice());
        } catch (err) {
            status.textContent = err && err.name === 'PasswordException'
                ? 'This PDF needs a password to open, so it can\'t be checked.'
                : 'Could not open this PDF: ' + errorText(err);
            return;
        }

        try {
            const report = await checkDocument(doc, bytes, (n, total) => {
                status.textContent = `Checking on your device… page ${n} of ${total}`;
            });
            status.textContent = '';
            renderReport(report, doc);
        } catch (err) {
            status.textContent = 'Error while checking: ' + errorText(err);
            console.error(err);
        }
    });

    async function checkDocument(doc, bytes, onProgress) {
        const report = { pages: doc.numPages, hidden: [], unappliedMarks: [], notes: [] };

        for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            const hidden = await findHiddenText(page);
            if (hidden.length) report.hidden.push({ page: n, items: hidden });

            const annots = await page.getAnnotations();
            const marks = annots.filter(a => a.subtype === 'Redact').length;
            if (marks) report.unappliedMarks.push({ page: n, count: marks });

            const comments = annots.filter(a => ['Text', 'FreeText', 'Popup'].includes(a.subtype));
            if (comments.length) report.notes.push(`Page ${n} has ${comments.length} comment${comments.length === 1 ? '' : 's'} or note${comments.length === 1 ? '' : 's'}. Check they don't mention anything you've redacted.`);

            page.cleanup();
            onProgress(n, doc.numPages);
        }

        const saves = countSavedVersions(bytes);
        if (saves > 1) {
            report.notes.unshift(`This file has been edited and saved ${saves} times without being rebuilt. Some tools keep earlier versions inside the file, which can include content from before redaction. Re-save it as a fresh copy (for example with pdfMask's redactor) to be sure.`);
        }

        try {
            const { info } = await doc.getMetadata();
            const props = ['Title', 'Author', 'Subject', 'Keywords']
                .filter(k => info && typeof info[k] === 'string' && info[k].trim())
                .map(k => `${k}: "${info[k].trim()}"`);
            if (props.length) report.notes.push(`The document properties include ${props.join(', ')}. Make sure these don't reveal anything you've redacted.`);
        } catch (err) { /* no metadata */ }

        try {
            // pdf.js 3 returns a plain object; later versions return a Map.
            const attachments = await doc.getAttachments();
            const list = !attachments ? [] : attachments instanceof Map ? [...attachments.values()] : Object.values(attachments);
            const names = list.map(a => a.filename || 'unnamed file');
            if (names.length) report.notes.push(`The file contains ${names.length} attached file${names.length === 1 ? '' : 's'} (${names.join(', ')}). Attachments aren't redacted with the pages.`);
        } catch (err) { /* no attachments */ }

        return report;
    }

    // Each saved revision of a PDF ends with %%EOF. A linearised ("fast web
    // view") file legitimately has two.
    function countSavedVersions(bytes) {
        const text = new TextDecoder('latin1').decode(bytes);
        const eofs = (text.match(/%%EOF/g) || []).length;
        const linearised = /\/Linearized/.test(text.slice(0, 2048));
        return Math.max(1, linearised ? eofs - 1 : eofs);
    }

    async function findHiddenText(page) {
        const viewport = page.getViewport({ scale: CHECK_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        const content = await page.getTextContent();
        const hidden = [];
        for (const item of content.items) {
            // Ignore punctuation, rules drawn with underscores and the control
            // characters some fonts produce: only real words can leak.
            const raw = item.str || '';
            const str = raw.replace(/[\u0000-\u001f\u007f�￿]/g, '');
            if (!meaningful(str)) continue;
            const geo = textGeometry(item, viewport, canvas);
            if (!geo) continue;
            // Unmappable glyphs can take up any amount of space, and accents
            // placed as separate characters sit above other letters, so letter
            // positions along such a line can't be estimated reliably.
            geo.reliable = str.length === raw.length && !/[\p{M}\p{Lm}\p{Sk}]/u.test(str);
            for (const part of hiddenParts(str, geo, pixels, canvas.width)) {
                if (meaningful(part.text)) hidden.push(part);
            }
        }
        canvas.width = canvas.height = 0;
        return hidden;
    }

    // Where a text item sits on the rendered page, in canvas pixels, and
    // which way it reads. Works for rotated pages and rotated text.
    function textGeometry(item, viewport, canvas) {
        const [a, b, c, d, e, f] = item.transform;
        const sx = Math.hypot(a, b);
        const sy = Math.hypot(c, d);
        if (!sx || !sy || !item.width) return null;
        const dir = [a / sx, b / sx];
        const up = [c / sy, d / sy];
        const at = (u, v) => viewport.convertToViewportPoint(e + dir[0] * u + up[0] * v, f + dir[1] * u + up[1] * v);
        // Cover the body of the glyphs, not the full line height, so text
        // that is only partly overlapped by neighbouring lines isn't missed.
        const lo = 0.1 * sy;
        const hi = 0.6 * sy;
        const corners = [at(0, lo), at(item.width, lo), at(0, hi), at(item.width, hi)];
        const xs = corners.map(p => p[0]);
        const ys = corners.map(p => p[1]);
        const box = {
            x0: Math.max(0, Math.floor(Math.min(...xs)) + 1),
            y0: Math.max(0, Math.floor(Math.min(...ys))),
            x1: Math.min(canvas.width, Math.ceil(Math.max(...xs)) - 1),
            y1: Math.min(canvas.height, Math.ceil(Math.max(...ys)))
        };
        if (box.x1 - box.x0 < 3 || box.y1 - box.y0 < 3) return null;
        const start = at(0, 0);
        const end = at(item.width, 0);
        const horizontal = Math.abs(end[0] - start[0]) >= Math.abs(end[1] - start[1]);
        return {
            box,
            horizontal,
            // Position along the reading direction, in canvas pixels.
            from: horizontal ? start[0] : start[1],
            to: horizontal ? end[0] : end[1]
        };
    }

    // At least three letters or digits. Shorter fragments are usually stray
    // pieces of words whose reported position can be slightly off.
    const meaningful = s => (s.match(/[\p{L}\p{N}]/gu) || []).length >= 3;

    const luminance = (px, i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

    // Find stretches of a line of text where nothing is visible.
    //
    // Walk along the line one pixel column at a time. Where text is visible,
    // columns cut through glyphs and contain both ink and background. Where a
    // box covers the text, columns are a single flat colour. A flat stretch
    // in a colour different from the line's background, at least about one
    // character wide, is a box drawn over text. A flat stretch in the
    // background colour is either a gap between words or a white box, so it
    // only counts if it is several characters wide and lines up with letters.
    function hiddenParts(str, geo, pixels, width) {
        const { box, horizontal } = geo;
        const [a0, a1] = horizontal ? [box.x0, box.x1] : [box.y0, box.y1];
        const [c0, c1] = horizontal ? [box.y0, box.y1] : [box.x0, box.x1];

        const cols = [];
        // The line's background colour comes from columns where letters are
        // visible, so a large box on the line can't be mistaken for it.
        const visible = [];
        for (let a = a0; a < a1; a++) {
            let min = 255, max = 0, sum = 0;
            const values = [];
            for (let c = c0; c < c1; c++) {
                const i = ((horizontal ? c : a) * width + (horizontal ? a : c)) * 4;
                const v = luminance(pixels, i);
                if (v < min) min = v;
                if (v > max) max = v;
                sum += v;
                values.push(v);
            }
            const flat = max - min <= 40;
            if (!flat) visible.push(...values);
            cols.push({ flat, shade: sum / (c1 - c0) });
        }

        // The whole line is flat: hidden, whatever colour covers it.
        if (!visible.length) {
            const shades = cols.map(c => c.shade);
            return Math.max(...shades) - Math.min(...shades) <= 40 ? [{ text: str, box }] : [];
        }

        // Finding hidden words partway along a line depends on knowing where
        // each letter sits. Without that, only a fully hidden line is reported.
        if (!geo.reliable) return [];

        const background = mostCommonShade(visible);
        const span = Math.abs(geo.to - geo.from) || 1;
        const charWidth = span / str.length;
        const edges = charEdges(str);
        const parts = [];

        for (let i = 0; i < cols.length;) {
            if (!cols[i].flat) { i++; continue; }
            let j = i;
            while (j + 1 < cols.length && cols[j + 1].flat && Math.abs(cols[j + 1].shade - cols[i].shade) <= 30) j++;
            const runWidth = j - i + 1;
            const covered = Math.abs(cols[i].shade - background) > 40;
            const t0 = Math.min(1, Math.max(0, (a0 + i - geo.from) / (geo.to - geo.from)));
            const t1 = Math.min(1, Math.max(0, (a0 + j + 1 - geo.from) / (geo.to - geo.from)));
            const [k0, k1] = charRange(edges, Math.min(t0, t1), Math.max(t0, t1));
            const under = [...str].slice(k0, k1).join('');
            const letters = under.replace(/\s/g, '').length;
            const looksHidden = covered
                ? runWidth >= 0.8 * charWidth && letters > 0
                : runWidth >= 3 * charWidth && letters >= 0.8 * under.length;
            if (looksHidden) {
                const text = wordsUnder(str, edges, Math.min(t0, t1), Math.max(t0, t1)) || wholeWords(str, k0, k1);
                if (text) {
                    parts.push({
                        text,
                        box: horizontal
                            ? { x0: a0 + i, x1: a0 + j + 1, y0: box.y0, y1: box.y1 }
                            : { x0: box.x0, x1: box.x1, y0: a0 + i, y1: a0 + j + 1 }
                    });
                }
            }
            i = j + 1;
        }
        return parts;
    }

    function mostCommonShade(values) {
        const buckets = new Array(26).fill(0);
        for (const v of values) buckets[Math.min(25, Math.floor(v / 10))]++;
        return buckets.indexOf(Math.max(...buckets)) * 10 + 5;
    }

    // Approximate where each character starts and ends along the line, as a
    // fraction of its width, using typical proportional font widths.
    let measureCtx = null;
    function charEdges(str) {
        if (!measureCtx) {
            measureCtx = document.createElement('canvas').getContext('2d');
            measureCtx.font = '100px Helvetica, Arial, sans-serif';
        }
        const widths = [...str].map(ch => Math.max(1, measureCtx.measureText(ch).width));
        const total = widths.reduce((s, w) => s + w, 0);
        const edges = [0];
        for (const w of widths) edges.push(edges[edges.length - 1] + w / total);
        return edges;
    }

    function charRange(edges, t0, t1) {
        let k0 = 0;
        while (k0 < edges.length - 2 && edges[k0 + 1] <= t0) k0++;
        let k1 = edges.length - 1;
        while (k1 > k0 + 1 && edges[k1 - 1] >= t1) k1--;
        return [k0, k1];
    }

    // The words that sit mostly under a covered stretch. Letter positions are
    // estimates, so a word counts if at least half of it is covered.
    function wordsUnder(str, edges, t0, t1) {
        const chars = [...str];
        const words = [];
        let start = null;
        for (let k = 0; k <= chars.length; k++) {
            const space = k === chars.length || /\s/.test(chars[k]);
            if (!space && start === null) start = k;
            if (space && start !== null) {
                const w0 = edges[start];
                const w1 = edges[k];
                const overlap = Math.max(0, Math.min(w1, t1) - Math.max(w0, t0));
                if (overlap >= 0.5 * (w1 - w0)) words.push(chars.slice(start, k).join(''));
                start = null;
            }
        }
        return words.join(' ');
    }

    // Widen to whole words: the estimate of which letters sit under a box is
    // approximate, and whole words are easier to recognise.
    function wholeWords(str, k0, k1) {
        const chars = [...str];
        while (k0 > 0 && /\S/.test(chars[k0 - 1])) k0--;
        while (k1 < chars.length && /\S/.test(chars[k1])) k1++;
        return chars.slice(k0, k1).join('').trim();
    }

    function renderReport(report, doc) {
        const hiddenCount = report.hidden.reduce((n, p) => n + p.items.length, 0);
        const markCount = report.unappliedMarks.reduce((n, p) => n + p.count, 0);
        const problem = hiddenCount > 0 || markCount > 0;

        const verdict = el('div', 'verdict ' + (problem ? 'bad' : report.notes.length ? 'warn' : 'ok'));
        if (problem) {
            const parts = [];
            if (hiddenCount) parts.push(`${hiddenCount} piece${hiddenCount === 1 ? '' : 's'} of hidden text on ${report.hidden.length} page${report.hidden.length === 1 ? '' : 's'}`);
            if (markCount) parts.push(`${markCount} redaction mark${markCount === 1 ? '' : 's'} that ${markCount === 1 ? 'was' : 'were'} never applied`);
            verdict.append(`⚠️ This file is not safely redacted. Found ${parts.join(' and ')}.`);
            verdict.appendChild(el('p', '', 'Anyone who receives this file can copy that text out. Redact the original again with a tool that removes content, such as pdfMask Redact, then check the new file.'));
        } else if (report.notes.length) {
            verdict.append('✓ No hidden text found under boxes or in unapplied redaction marks.');
            verdict.appendChild(el('p', '', 'There are a few other things worth checking before you share it, listed below.'));
        } else {
            verdict.append(`✓ No problems found across ${report.pages} page${report.pages === 1 ? '' : 's'}.`);
            verdict.appendChild(el('p', '', 'No hidden text, unapplied redaction marks, earlier saved versions, document properties, attachments or comments were found.'));
        }
        results.appendChild(verdict);

        const findings = el('div', 'findings');
        results.appendChild(findings);

        if (problem) {
            const fix = el('p');
            const link = el('a', 'action-btn', 'Redact it properly with pdfMask');
            link.href = '/redact-pdf/';
            fix.appendChild(link);
            findings.appendChild(fix);
        }

        report.hidden.forEach((p, idx) => {
            const card = el('div', 'finding');
            card.appendChild(el('h3', '', `Page ${p.page}: hidden text`));
            const ul = el('ul');
            for (const item of p.items.slice(0, 20)) {
                const li = el('li');
                li.appendChild(el('span', 'leak', item.text.length > 120 ? item.text.slice(0, 117) + '…' : item.text));
                ul.appendChild(li);
            }
            if (p.items.length > 20) ul.appendChild(el('li', '', `…and ${p.items.length - 20} more`));
            card.appendChild(ul);
            if (idx < MAX_PREVIEW_PAGES) drawPreview(doc, p).then(c => card.appendChild(c)).catch(() => {});
            findings.appendChild(card);
        });

        if (report.unappliedMarks.length) {
            const card = el('div', 'finding');
            card.appendChild(el('h3', '', 'Redaction marks that were never applied'));
            const ul = el('ul');
            for (const m of report.unappliedMarks) {
                ul.appendChild(el('li', '', `Page ${m.page}: ${m.count} area${m.count === 1 ? '' : 's'} marked for redaction, but the content underneath is still there.`));
            }
            card.appendChild(ul);
            findings.appendChild(card);
        }

        if (report.notes.length) {
            const card = el('div', 'finding');
            card.appendChild(el('h3', '', 'Also worth checking'));
            const ul = el('ul');
            for (const note of report.notes) ul.appendChild(el('li', '', note));
            card.appendChild(ul);
            findings.appendChild(card);
        }

        findings.appendChild(el('p', 'status', 'This checker looks for the most common redaction mistakes. It can\'t guarantee a document is safe to share, so always review it yourself too.'));
    }

    // A small picture of the page with each piece of hidden text outlined.
    async function drawPreview(doc, p) {
        const page = await doc.getPage(p.page);
        const viewport = page.getViewport({ scale: CHECK_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.setAttribute('aria-label', `Page ${p.page} with hidden text outlined in red`);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 4;
        for (const { box } of p.items) {
            ctx.strokeRect(box.x0 - 4, box.y0 - 4, box.x1 - box.x0 + 8, box.y1 - box.y0 + 8);
        }
        canvas.style.width = Math.min(canvas.width / CHECK_SCALE, 480) + 'px';
        return canvas;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }
}
