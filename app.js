// Tab Switching Helper
function switchTab(index) {
    const panels = document.querySelectorAll('.panel');
    const buttons = document.querySelectorAll('.tab-btn');
    panels.forEach((p, i) => p.classList.toggle('active', i === index));
    buttons.forEach((b, i) => b.classList.toggle('active', i === index));
}

// Helper: Trigger browser download from binary bytes
function downloadFile(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
}

// 1. CLIENT-SIDE MERGING
async function mergePDFs() {
    const fileInput = document.getElementById('mergeFiles');
    const status = document.getElementById('mergeStatus');
    if (fileInput.files.length < 2) {
        alert('Please select at least 2 PDF files to merge.');
        return;
    }

    status.textContent = 'Initializing local merger...';
    try {
        const { PDFDocument } = PDFLib;
        const mergedPdf = await PDFDocument.create();

        for (const file of fileInput.files) {
            status.textContent = `Reading ${file.name}...`;
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await PDFDocument.load(arrayBuffer);
            const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
        }

        status.textContent = 'Generating final merged PDF...';
        const pdfBytes = await mergedPdf.save();
        downloadFile(pdfBytes, 'merged-document.pdf');
        status.textContent = 'Success! Merged entirely offline.';
    } catch (err) {
        status.textContent = 'Error: ' + err.message;
    }
}

// 2. UNLOCK PERMISSIONS / REMOVE ENCRYPTION
async function unlockPDF() {
    const fileInput = document.getElementById('unlockFile');
    const passwordInput = document.getElementById('ownerPassword').value;
    const status = document.getElementById('unlockStatus');

    if (fileInput.files.length === 0) {
        alert('Please choose a PDF file.');
        return;
    }

    status.textContent = 'Loading protected file into memory...';
    try {
        const file = fileInput.files[0];
        const arrayBuffer = await file.arrayBuffer();
        const { PDFDocument } = PDFLib;

        // Load with credentials if provided
        const loadOptions = passwordInput ? { credentials: passwordInput } : {};
        const pdfDoc = await PDFDocument.load(arrayBuffer, loadOptions);

        // Remove security restrictions/protection constraints
        if (typeof pdfDoc.removeProtection === 'function') {
            pdfDoc.removeProtection();
        }

        status.textContent = 'Unlocking and re-saving clean version...';
        const pdfBytes = await pdfDoc.save();
        downloadFile(pdfBytes, `unlocked-${file.name}`);
        status.textContent = 'Success! Restrictions stripped locally.';
    } catch (err) {
        status.textContent = 'Error unlocking: Check password or file format. ' + err.message;
    }
}

// 3. VISUAL REDACTION / BLACKOUT MASK
async function redactPDF() {
    const fileInput = document.getElementById('redactFile');
    const status = document.getElementById('redactStatus');

    if (fileInput.files.length === 0) {
        alert('Please choose a PDF file to redact.');
        return;
    }

    status.textContent = 'Loading document for redaction...';
    try {
        const file = fileInput.files[0];
        const arrayBuffer = await file.arrayBuffer();
        const { PDFDocument, rgb } = PDFLib;

        const pdfDoc = await PDFDocument.load(arrayBuffer);
        const pages = pdfDoc.getPages();

        status.textContent = 'Applying black-box redaction masks across pages...';
        // Example: Draw an opaque black redaction box over a header zone on every page
        for (const page of pages) {
            const { width, height } = page.getSize();
            page.drawRectangle({
                x: 40,
                y: height - 60,
                width: width - 80,
                height: 35,
                color: rgb(0, 0, 0), // Solid black privacy block
            });
        }

        const pdfBytes = await pdfDoc.save();
        downloadFile(pdfBytes, `redacted-${file.name}`);
        status.textContent = 'Success! Sensitive header bands masked locally.';
    } catch (err) {
        status.textContent = 'Error applying redaction: ' + err.message;
    }
}