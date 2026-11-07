// Tests for the redaction checker.
//
// The checker must catch the ways real "redactions" leak, without crying wolf
// on ordinary documents. The fixture mixes both: hidden text it must report,
// and look-alikes it must leave alone (white text on a dark banner, pale grey
// text, an invisible OCR layer over a scanned image of the same words).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright');
const {
    PDFDocument, StandardFonts, PDFName, PDFString, rgb,
    pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize,
    moveText, showText, setTextRenderingMode, TextRenderingMode
} = require('pdf-lib');
const { startServer, routeLocalLibs } = require('./helpers');

const MUST_FIND = [
    'BLACKBOX-SECRET-111', 'WHITEBOX-SECRET-222', 'INVISIBLE-SECRET-333', 'IMAGE-COVERED-444',
    // Boxes over one word in the middle of a line: the most common real case.
    'MIDLINE-SECRET-555', 'WHITEOUT-SECRET-666'
];
const MUST_NOT_FIND = ['Visible paragraph text', 'White text on a navy banner', 'Pale grey footnote', 'Scanned words'];

let browser, server, baseUrl, tmp;

// Minimal greyscale PNG encoder, so the fixture needs no image files.
function greyPng(width, height, shade) {
    const rows = [];
    for (let y = 0; y < height; y++) {
        const row = Buffer.alloc(width + 1);
        for (let x = 0; x < width; x++) row[x + 1] = shade(x, y);
        rows.push(row);
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = buf => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
        return Buffer.concat([len, body, sum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// Black bars on white, standing in for a scanned image of some words.
const scannedPng = (w, h) => greyPng(w, h, (x, y) => (y > h * 0.2 && y < h * 0.8 && x % 12 < 7 ? 0 : 255));
const solidPng = (w, h, v) => greyPng(w, h, () => v);

async function buildLeakyPdf() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.setTitle('Case file - Mr J Smith');
    doc.attach(Buffer.from('original notes'), 'notes.txt', { mimeType: 'text/plain' });

    // Page 1: classic fake redactions mixed with normal content.
    const p1 = doc.addPage([595, 842]);
    p1.drawText('Visible paragraph text', { x: 50, y: 780, size: 14, font });
    p1.drawText('BLACKBOX-SECRET-111', { x: 50, y: 720, size: 14, font });
    p1.drawRectangle({ x: 45, y: 714, width: 200, height: 22, color: rgb(0, 0, 0) });
    p1.drawText('WHITEBOX-SECRET-222', { x: 50, y: 660, size: 14, font });
    p1.drawRectangle({ x: 45, y: 654, width: 200, height: 22, color: rgb(1, 1, 1) });
    p1.drawRectangle({ x: 40, y: 580, width: 400, height: 40, color: rgb(0.06, 0.09, 0.3) });
    p1.drawText('White text on a navy banner', { x: 50, y: 594, size: 14, font, color: rgb(1, 1, 1) });
    p1.drawText('Pale grey footnote', { x: 50, y: 540, size: 10, font, color: rgb(0.7, 0.7, 0.7) });

    // Invisible text (rendering mode 3) on a blank area.
    const fontKey = p1.node.newFontDictionary('F_hidden', font.ref);
    p1.pushOperators(
        pushGraphicsState(), beginText(), setFontAndSize(fontKey, 14),
        setTextRenderingMode(TextRenderingMode.Invisible), moveText(50, 480),
        showText(font.encodeText('INVISIBLE-SECRET-333')), endText(), popGraphicsState()
    );

    // Text covered by an opaque image.
    const cover = await doc.embedPng(solidPng(8, 8, 30));
    p1.drawText('IMAGE-COVERED-444', { x: 50, y: 420, size: 14, font });
    p1.drawImage(cover, { x: 45, y: 414, width: 200, height: 22 });

    // A box over a single word partway along a line of visible text.
    const coverWord = (page, before, word, after, y, colour) => {
        page.drawText(`${before}${word}${after}`, { x: 50, y, size: 12, font });
        const x = 50 + font.widthOfTextAtSize(before, 12);
        page.drawRectangle({ x: x - 1, y: y - 3, width: font.widthOfTextAtSize(word, 12) + 2, height: 15, color: colour });
    };
    coverWord(p1, 'Claimant: Mr A ', 'MIDLINE-SECRET-555', ' of Leeds, represented by', 360, rgb(0, 0, 0));
    coverWord(p1, 'Account reference ', 'WHITEOUT-SECRET-666', ' was closed in May', 330, rgb(1, 1, 1));

    // An Acrobat-style redaction mark that was never applied.
    const mark = doc.context.obj({
        Type: 'Annot', Subtype: 'Redact', Rect: [45, 774, 250, 796],
        Contents: PDFString.of('Marked for redaction')
    });
    p1.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(mark)]));

    // Page 2: a "scan" with an invisible OCR layer over visible words. Normal,
    // must not be flagged.
    const p2 = doc.addPage([595, 842]);
    const scan = await doc.embedPng(scannedPng(300, 30));
    p2.drawImage(scan, { x: 50, y: 700, width: 300, height: 30 });
    const ocrKey = p2.node.newFontDictionary('F_ocr', font.ref);
    p2.pushOperators(
        pushGraphicsState(), beginText(), setFontAndSize(ocrKey, 24),
        setTextRenderingMode(TextRenderingMode.Invisible), moveText(52, 706),
        showText(font.encodeText('Scanned words')), endText(), popGraphicsState()
    );

    const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
    return appendIncrementalUpdate(bytes);
}

// Simulate "edit and save" in a viewer: append a second revision to the file
// instead of rewriting it, as Acrobat and others do.
function appendIncrementalUpdate(bytes) {
    const text = bytes.toString('latin1');
    const prev = Number(text.match(/startxref\s+(\d+)\s+%%EOF\s*$/)[1]);
    const size = Number(text.match(/\/Size (\d+)/)[1]);
    const root = text.match(/\/Root (\d+ 0 R)/)[1];
    const obj = `${size} 0 obj\n<< /Title (Case file - Mr J Smith) /Producer (Edited) >>\nendobj\n`;
    const offset = bytes.length;
    const xrefAt = offset + obj.length;
    const update = obj +
        `xref\n${size} 1\n${String(offset).padStart(10, '0')} 00000 n \n` +
        `trailer\n<< /Size ${size + 1} /Root ${root} /Info ${size} 0 R /Prev ${prev} >>\n` +
        `startxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.concat([bytes, Buffer.from(update, 'latin1')]);
}

async function check(file) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await routeLocalLibs(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl + 'redaction-checker/', { waitUntil: 'networkidle' });
    await page.setInputFiles('#checkFile', file);
    await page.waitForSelector('#checkResults .verdict', { timeout: 30000 });
    const result = {
        verdict: await page.getAttribute('#checkResults .verdict', 'class'),
        text: await page.textContent('#checkResults'),
        leaks: await page.$$eval('#checkResults .leak', els => els.map(e => e.textContent)),
        errors
    };
    await context.close();
    return result;
}

before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfmask-check-'));
    ({ server, url: baseUrl } = await startServer());
    browser = await chromium.launch();
});

after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('finds every hidden secret and nothing else', async () => {
    const file = path.join(tmp, 'leaky.pdf');
    fs.writeFileSync(file, await buildLeakyPdf());
    const r = await check(file);

    assert.match(r.verdict, /\bbad\b/);
    assert.deepEqual(r.leaks.slice().sort(), MUST_FIND.slice().sort(),
        'hidden text reported should be exactly the planted secrets');
    for (const visible of MUST_NOT_FIND) {
        assert.ok(!r.leaks.includes(visible), `wrongly flagged visible text: ${visible}`);
    }
    assert.match(r.text, /1 redaction mark that was never applied/);
    assert.match(r.text, /edited and saved 2 times/);
    assert.match(r.text, /Title: "Case file - Mr J Smith"/);
    assert.match(r.text, /notes\.txt/);
    assert.deepEqual(r.errors, []);
});

test('a clean document passes', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText('Nothing to hide here', { x: 50, y: 780, size: 14, font });
    const file = path.join(tmp, 'clean.pdf');
    fs.writeFileSync(file, await doc.save());
    const r = await check(file);
    assert.match(r.verdict, /\bok\b/);
    assert.deepEqual(r.leaks, []);
    assert.match(r.text, /No problems found/);
});
