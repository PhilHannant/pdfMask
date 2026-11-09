// End-to-end tests for Unlock PDF and Remove PDF Password.
//
// Each fixture is the same one-page PDF protected a different way. Unlocking
// must produce a file that is no longer encrypted and still contains the
// page's real text, for every common type of PDF encryption.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const { startServer, routeLocalLibs, hasLocalQpdf, findStrings, ROOT } = require('./helpers');

const FIXTURES = path.join(ROOT, 'tests/fixtures/unlock');
const PAGE_TEXT = 'Restricted test file';
const PASSWORD = 'pa ss£!';
// The first run downloads and compiles the unlock engine.
const ENGINE_TIMEOUT = 60000;

const skip = process.env.PDFMASK_LOCAL_LIBS && !hasLocalQpdf()
    ? 'PDFMASK_LOCAL_LIBS has no qpdf.js/qpdf.wasm, and these tests need the unlock engine'
    : false;

let browser, server, baseUrl;

before(async () => {
    if (skip) return;
    ({ server, url: baseUrl } = await startServer());
    browser = await chromium.launch();
});

after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
});

async function openTool(pagePath) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1200 }, acceptDownloads: true });
    await routeLocalLibs(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl + pagePath, { waitUntil: 'networkidle' });
    return { page, context, errors };
}

async function statusMatches(page, pattern) {
    try {
        await page.waitForFunction(
            p => new RegExp(p, 'i').test(document.getElementById('unlockStatus').textContent),
            pattern.source, { timeout: ENGINE_TIMEOUT });
    } catch (err) {
        const actual = await page.textContent('#unlockStatus');
        throw new Error(`Expected the status to match ${pattern}, but it says: "${actual}"`);
    }
}

async function unlockAndRead(page) {
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: ENGINE_TIMEOUT }),
        page.click('#unlockBtn')
    ]);
    return { name: download.suggestedFilename(), bytes: fs.readFileSync(await download.path()) };
}

// pdf-lib refuses encrypted files unless told otherwise, so a plain load is
// a strict check that the protection is gone.
async function assertUnlocked(bytes, label) {
    await assert.doesNotReject(PDFDocument.load(bytes), `${label}: output is still encrypted`);
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 1, `${label}: page count changed`);
    assert.deepEqual(findStrings(bytes, [PAGE_TEXT]), [PAGE_TEXT], `${label}: page text was lost`);
}

for (const kind of ['rc4-40', 'rc4-128', 'aes-128', 'aes-256']) {
    test(`removes restrictions from a ${kind} PDF without asking for a password`, { skip }, async () => {
        const { page, context, errors } = await openTool('unlock-pdf/');
        await page.setInputFiles('#unlockFile', path.join(FIXTURES, `restricted-${kind}.pdf`));
        await statusMatches(page, /has restrictions/);
        assert.equal(await page.isVisible('#unlockPassword'), false, 'password box should stay hidden');

        const out = await unlockAndRead(page);
        assert.equal(out.name, `restricted-${kind}-unlocked.pdf`);
        await assertUnlocked(out.bytes, kind);
        await statusMatches(page, /^Done/);
        assert.deepEqual(errors, []);
        await context.close();
    });
}

test('removes a known password, and rejects a wrong one', { skip }, async () => {
    const { page, context, errors } = await openTool('remove-pdf-password/');
    await page.setInputFiles('#unlockFile', path.join(FIXTURES, 'password-aes-256.pdf'));
    await statusMatches(page, /needs a password/);
    assert.equal(await page.isVisible('#unlockPassword'), true);

    await page.fill('#unlockPassword', 'wrong password');
    await page.click('#unlockBtn');
    await statusMatches(page, /isn't right/);

    // Includes a space and a £ sign, to check non-ASCII passwords work.
    await page.fill('#unlockPassword', PASSWORD);
    const out = await unlockAndRead(page);
    await assertUnlocked(out.bytes, 'password');
    await statusMatches(page, /opens without a password/);
    assert.deepEqual(errors, []);
    await context.close();
});

test('says so when a file is damaged rather than asking for a password', { skip }, async () => {
    const { page, context } = await openTool('unlock-pdf/');
    await page.setInputFiles('#unlockFile', { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nnot really a pdf') });
    await statusMatches(page, /couldn't be read/);
    assert.equal(await page.isVisible('#unlockPassword'), false);
    assert.equal(await page.isDisabled('#unlockBtn'), true);
    await context.close();
});

test('says so when a PDF is not locked', { skip }, async () => {
    const { page, context } = await openTool('unlock-pdf/');
    await page.setInputFiles('#unlockFile', path.join(FIXTURES, 'not-locked.pdf'));
    await statusMatches(page, /isn't locked/);
    assert.equal(await page.isDisabled('#unlockBtn'), true);
    await context.close();
});
