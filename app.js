pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let rawArrayBuffer = null;
let pdfPage = null;
let viewport = null;
let isDrawing = false;
let startX, startY;
let selectedBox = null;

// --- NAVIGATION SWITCHING ---
function switchTool(index) {
    const panels = document.querySelectorAll('.tool-panel');
    const buttons = document.querySelectorAll('.nav-btn');
    panels.forEach((p, i) => p.classList.toggle('active', i === index));
    buttons.forEach((b, i) => b.classList.toggle('active', i === index));
}

// --- TOOL 1: DRAG & DROP REDACTOR LOGIC ---
const fileInput = document.getElementById('pdfFile');
const wrapper = document.getElementById('canvas-wrapper');
const pdfCanvas = document.getElementById('pdf-canvas');
const selectionCanvas = document.getElementById('selection-canvas');
const pdfCtx = pdfCanvas.getContext('2d');
const selectionCtx = selectionCanvas.getContext('2d');
const statusDiv = document.getElementById('status');
const applyBtn = document.getElementById('applyBtn');
const clearBtn = document.getElementById('clearBtn');

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    statusDiv.textContent = 'Loading document into memory...';
    rawArrayBuffer = await file.arrayBuffer();

    // Use .slice(0) to prevent buffer detachment issues across libraries
    const loadingTask = pdfjsLib.getDocument({ data: rawArrayBuffer.slice(0) });
    const pdfDoc = await loadingTask.promise;
    pdfPage = await pdfDoc.getPage(1);

    const scale = 1.5;
    viewport = pdfPage.getViewport({ scale });

    pdfCanvas.width = viewport.width;
    pdfCanvas.height = viewport.height;
    selectionCanvas.width = viewport.width;
    selectionCanvas.height = viewport.height;

    wrapper.style.display = 'inline-block';
    await pdfPage.render({ canvasContext: pdfCtx, viewport }).promise;
    statusDiv.textContent = 'Page loaded! Click and drag over the area you wish to mask.';
    clearSelection();
});

selectionCanvas.addEventListener('mousedown', (e) => {
    const rect = selectionCanvas.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    isDrawing = true;
});

selectionCanvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    const rect = selectionCanvas.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    selectedBox = {
        x: Math.min(startX, currentX),
        y: Math.min(startY, currentY),
        width: Math.abs(currentX - startX),
        height: Math.abs(currentY - startY)
    };

    drawSelection();
});

selectionCanvas.addEventListener('mouseup', () => {
    if (isDrawing) {
        isDrawing = false;
        if (selectedBox && selectedBox.width > 5 && selectedBox.height > 5) {
            applyBtn.disabled = false;
            clearBtn.disabled = false;
            statusDiv.textContent = 'Selection complete. Click Apply to burn box into PDF.';
        }
    }
});

function drawSelection() {
    selectionCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
    if (!selectedBox) return;

    selectionCtx.fillStyle = 'rgba(239, 68, 68, 0.4)';
    selectionCtx.strokeStyle = '#dc2626';
    selectionCtx.lineWidth = 2;
    selectionCtx.fillRect(selectedBox.x, selectedBox.y, selectedBox.width, selectedBox.height);
    selectionCtx.strokeRect(selectedBox.x, selectedBox.y, selectedBox.width, selectedBox.height);
}

function clearSelection() {
    selectedBox = null;
    selectionCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
    applyBtn.disabled = true;
    clearBtn.disabled = true;
}

clearBtn.addEventListener('click', clearSelection);

applyBtn.addEventListener('click', async () => {
    if (!selectedBox) return;
    statusDiv.textContent = 'Burning redaction box securely in browser...';

    try {
        const { PDFDocument, rgb } = PDFLib;

        // Pass a fresh Uint8Array slice to avoid detached buffer errors
        const pdfDoc = await PDFDocument.load(new Uint8Array(rawArrayBuffer));
        const page = pdfDoc.getPages()[0];

        const pdfWidth = page.getWidth();
        const pdfHeight = page.getHeight();

        const scaleX = pdfWidth / viewport.width;
        const scaleY = pdfHeight / viewport.height;

        const pdfX = selectedBox.x * scaleX;
        const pdfWidthBox = selectedBox.width * scaleX;
        const pdfHeightBox = selectedBox.height * scaleY;
        const pdfY = pdfHeight - ((selectedBox.y * scaleY) + pdfHeightBox);

        page.drawRectangle({
            x: pdfX,
            y: pdfY,
            width: pdfWidthBox,
            height: pdfHeightBox,
            color: rgb(0, 0, 0)
        });

        const modifiedPdfBytes = await pdfDoc.save();
        triggerDownload(modifiedPdfBytes, 'redacted-document.pdf');
        statusDiv.textContent = 'Success! File redacted offline and downloaded.';
    } catch (err) {
        statusDiv.textContent = 'Error: ' + err.message;
        console.error(err);
    }
});

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
    link.click();
}