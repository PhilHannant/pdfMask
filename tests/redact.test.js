// End-to-end tests for the redactor.
//
// The core promise is that marked content is removed from the downloaded
// file, not just covered up. These tests build a PDF with secrets planted in
// every place we know content can hide, redact it through the real page in a
// real browser, then search every byte of the result.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { PDFDocument, StandardFonts, PDFName, degrees } = require('pdf-lib');
const { startServer, routeLocalLibs, findStrings, ROOT } = require('./helpers');

const SECRETS = {
    text: 'SECRET-ACCOUNT-12345678',
    form: 'FORM-SECRET-777',
    rotated: 'ROTATED-SECRET-999',
    title: 'SECRET-TITLE-555',
    author: 'SECRET-AUTHOR-321'
};
const KEPT = {
    pageOneHeading: 'Public heading stays visible',
    pageTwo: 'Page two keeps its text'
};

let browser, server, baseUrl, tmp, fixture, boxes;

// Build the fixture and work out where each secret sits, as a fraction of the
// page as it is displayed (after rotation), padded so the box fully covers it.
async function buildFixture() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.setTitle(SECRETS.title);
    doc.setAuthor(SECRETS.author);
    const W = 595, H = 842, size = 18, pad = 8;

    const p1 = doc.addPage([W, H]);
    p1.drawText(KEPT.pageOneHeading, { x: 50, y: 780, size, font });
    p1.drawText(SECRETS.text, { x: 50, y: 700, size, font });
    const field = doc.getForm().createTextField('client.name');
    field.setText(SECRETS.form);
    field.addToPage(p1, { x: 50, y: 600, width: 250, height: 30 });

    const p2 = doc.addPage([W, H]);
    p2.drawText(KEPT.pageTwo, { x: 50, y: 780, size, font });
    // A link on an untouched page pointing at the redacted page. If the
    // redactor copies page 2 naively, this drags page 1's original content
    // into the output.
    const link = doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: [50, 700, 300, 730], Border: [0, 0, 0],
        Dest: [p1.ref, PDFName.of('XYZ'), null, null, null]
    });
    p2.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]));

    const p3 = doc.addPage([W, H]);
    p3.setRotation(degrees(90));
    p3.drawText(SECRETS.rotated, { x: 100, y: 400, size, font });

    // Unrotated page: display x = pdf x, display y = H - pdf y.
    const upright = (x0, y0, x1, y1) => ({
        x0: (x0 - pad) / W, x1: (x1 + pad) / W,
        y0: (H - y1 - pad) / H, y1: (H - y0 + pad) / H
    });
    // Rotated 90° clockwise: display x = pdf y, display y = pdf x.
    const rotated = (x0, y0, x1, y1) => ({
        x0: (y0 - pad) / H, x1: (y1 + pad) / H,
        y0: (x0 - pad) / W, y1: (x1 + pad) / W
    });
    const width = t => font.widthOfTextAtSize(t, size);

    return {
        bytes: await doc.save(),
        boxes: {
            1: [upright(50, 700 - 5, 50 + width(SECRETS.text), 700 + size), upright(50, 600, 300, 630)],
            3: [rotated(100, 400 - 5, 100 + width(SECRETS.rotated), 400 + size)]
        }
    };
}

async function openRedactor(file) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
    await routeLocalLibs(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.setInputFiles('#pdfFile', file);
    return { page, context, errors };
}

async function drawBox(page, b) {
    const r = await page.locator('#selection-canvas').boundingBox();
    await page.mouse.move(r.x + b.x0 * r.width, r.y + b.y0 * r.height);
    await page.mouse.down();
    await page.mouse.move(r.x + b.x1 * r.width, r.y + b.y1 * r.height, { steps: 5 });
    await page.mouse.up();
}

async function goToPage(page, n) {
    for (;;) {
        const info = await page.textContent('#pageInfo');
        const current = Number(info.match(/Page (\d+)/)[1]);
        if (current === n) break;
        await page.click(current < n ? '#nextPage' : '#prevPage');
        await page.waitForFunction(c => !document.getElementById('pageInfo').textContent.startsWith(`Page ${c} `), current);
    }
}

// Ask the page's own pdf.js for each page's text and displayed size.
async function inspectPdf(page, bytes) {
    return page.evaluate(async data => {
        const doc = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
        const pages = [];
        for (let i = 1; i <= doc.numPages; i++) {
            const p = await doc.getPage(i);
            const vp = p.getViewport({ scale: 1 });
            const text = (await p.getTextContent()).items.map(it => it.str).join(' ');
            pages.push({ text, width: Math.round(vp.width), height: Math.round(vp.height) });
        }
        return pages;
    }, Array.from(bytes));
}

before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmask-'));
    const built = await buildFixture();
    fixture = path.join(tmp, 'client-file.pdf');
    fs.writeFileSync(fixture, built.bytes);
    boxes = built.boxes;
    ({ server, url: baseUrl } = await startServer());
    browser = await chromium.launch();
});

after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('fixture really contains every secret (so the scanner is trustworthy)', () => {
    const found = findStrings(fs.readFileSync(fixture), Object.values(SECRETS));
    assert.deepEqual(found.sort(), Object.values(SECRETS).sort());
});

test('redacted content is removed from the file, everything else survives', async () => {
    const { page, context, errors } = await openRedactor(fixture);
    await page.waitForFunction(() => document.getElementById('pageInfo').textContent.includes('Page 1 of 3'));

    for (const b of boxes[1]) await drawBox(page, b);
    // A click without a drag must not create a box.
    await drawBox(page, { x0: 0.9, y0: 0.9, x1: 0.9, y1: 0.9 });
    assert.match(await page.textContent('#pageInfo'), /2 areas marked on 1 page/);

    await goToPage(page, 3);
    const canvas = await page.locator('#selection-canvas').boundingBox();
    assert.ok(canvas.width > canvas.height, 'rotated page should display in landscape');
    for (const b of boxes[3]) await drawBox(page, b);
    // Undo removes only the last box.
    await drawBox(page, { x0: 0.7, y0: 0.7, x1: 0.8, y1: 0.8 });
    await page.click('#undoBtn');
    assert.match(await page.textContent('#pageInfo'), /3 areas marked on 2 pages/);

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#applyBtn')]);
    assert.equal(download.suggestedFilename(), 'client-file-redacted.pdf');
    const output = fs.readFileSync(await download.path());

    // 1. No secret appears anywhere in the output, in any encoding, in any stream.
    assert.deepEqual(findStrings(output, Object.values(SECRETS)), [], 'secret found in redacted output');

    // 2. Structure is preserved and untouched content is still real text.
    const pages = await inspectPdf(page, output);
    assert.equal(pages.length, 3);
    assert.match(pages[1].text, new RegExp(KEPT.pageTwo));
    assert.equal(pages[0].text.trim(), '', 'redacted page should have no extractable text');
    assert.deepEqual([pages[0].width, pages[0].height], [595, 842]);
    assert.deepEqual([pages[2].width, pages[2].height], [842, 595]);

    // 3. Visible content outside the boxes survives on the redacted page:
    // the heading is no longer text, but it is still in the image. Check
    // that the top of page 1 is not blank.
    const headingInk = await page.evaluate(async data => {
        const doc = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
        const p = await doc.getPage(1);
        const vp = p.getViewport({ scale: 1 });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        const px = c.getContext('2d').getImageData(40, 40, 300, 30).data;
        let dark = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] < 128) dark++;
        return dark;
    }, Array.from(output));
    assert.ok(headingInk > 50, 'heading outside the boxes should still be visible');

    assert.deepEqual(errors, []);
    await context.close();
});

test('password-protected PDFs get a clear message', async () => {
    const { page, context } = await openRedactor(path.join(ROOT, 'tests/fixtures/password-protected.pdf'));
    await page.waitForFunction(() => /password/i.test(document.getElementById('status').textContent));
    assert.equal(await page.isDisabled('#applyBtn'), true);
    await context.close();
});
