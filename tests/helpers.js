// Shared helpers for the tests: a static server that behaves like Cloudflare
// (including the _headers file, so pages run under the real security policy),
// a page opener that records anything that shouldn't happen, and a scanner
// that looks for text anywhere inside a PDF's bytes.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { vendorPaths } = require('../scripts/vendor');

const ROOT = path.resolve(__dirname, '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf'
};

// ---------------------------------------------------------------------------
// _headers, as Cloudflare applies it to static assets:
// https://developers.cloudflare.com/workers/static-assets/headers/
// A block is a path (exact, or with one * splat) followed by indented
// "Name: value" lines. Every matching block applies, in order. A header set
// by more than one block has its values joined with a comma. "! Name" removes
// a header set by an earlier block.
// ---------------------------------------------------------------------------

function parseHeadersFile(text = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8')) {
    const rules = [];
    let current = null;
    for (const raw of text.split('\n')) {
        if (!raw.trim() || raw.trim().startsWith('#')) continue;
        if (!/^\s/.test(raw)) {
            current = { path: raw.trim(), set: [], unset: [] };
            rules.push(current);
        } else if (raw.trim().startsWith('!')) {
            current.unset.push(raw.trim().slice(1).trim().toLowerCase());
        } else {
            const at = raw.indexOf(':');
            current.set.push([raw.slice(0, at).trim().toLowerCase(), raw.slice(at + 1).trim()]);
        }
    }
    return rules;
}

function ruleMatches(rulePath, urlPath) {
    if (!rulePath.includes('*')) return rulePath === urlPath;
    const [before, after] = rulePath.split('*');
    return urlPath.length >= before.length + after.length && urlPath.startsWith(before) && urlPath.endsWith(after);
}

function headersFor(urlPath, rules = parseHeadersFile()) {
    const headers = {};
    for (const rule of rules.filter(r => ruleMatches(r.path, urlPath))) {
        for (const name of rule.unset) delete headers[name];
        for (const [name, value] of rule.set) {
            headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
        }
    }
    return headers;
}

function startServer() {
    const rules = parseHeadersFile();
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const extra = headersFor(urlPath, rules);
        // Same rules as Cloudflare's static assets: /page/ serves page/index.html.
        let file = path.join(ROOT, urlPath);
        if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404, { ...extra, 'Content-Type': MIME['.html'] });
            fs.createReadStream(path.join(ROOT, '404.html')).on('error', () => res.end()).pipe(res);
            return;
        }
        res.writeHead(200, { ...extra, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
        });
    });
}

// Open a page and record everything that would mean the site misbehaved:
// script errors, anything the security policy had to block, and any request
// to a server other than the site itself. Tests assert `problems` is empty.
async function openPage(browser, url, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, ...options });
    const page = await context.newPage();
    const problems = [];
    const origin = new URL(url).origin;
    page.on('pageerror', e => problems.push(`script error: ${e.message}`));
    page.on('console', m => {
        if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    context.on('request', r => {
        const target = r.url();
        if (!target.startsWith(origin + '/') && !/^(blob|data):/.test(target)) {
            problems.push(`request to another server: ${target}`);
        }
    });
    await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', e => {
            console.error(`security policy blocked ${e.blockedURI || 'inline code'} (${e.violatedDirective})`);
        });
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    return { page, context, problems };
}

// vendor/ is built from npm packages (npm run build). The unlock engine isn't
// available everywhere the tests run, so tests that need it check first.
const hasVendored = (pkg, file) => fs.existsSync(path.join(ROOT, vendorPaths()[pkg], file));

// Every way a string can be stored in a PDF that we care about: plain bytes,
// UTF-16BE (pdf-lib writes metadata and form values this way), and both of
// those as hex strings.
function encodings(text) {
    const latin1 = Buffer.from(text, 'latin1');
    const utf16 = Buffer.from(text, 'utf16le').swap16();
    return [
        latin1,
        utf16,
        Buffer.from(latin1.toString('hex').toUpperCase()),
        Buffer.from(latin1.toString('hex')),
        Buffer.from(utf16.toString('hex').toUpperCase()),
        Buffer.from(utf16.toString('hex'))
    ];
}

// Return the raw file plus every stream we can decompress (content streams,
// object streams, XObjects, fonts), so nothing hidden in a compressed
// object escapes the search.
function pdfLayers(bytes) {
    const buf = Buffer.from(bytes);
    const layers = [buf];
    let at = 0;
    for (;;) {
        const start = buf.indexOf('stream', at, 'latin1');
        if (start === -1) break;
        let dataStart = start + 'stream'.length;
        if (buf[dataStart] === 0x0d) dataStart++;
        if (buf[dataStart] === 0x0a) dataStart++;
        const end = buf.indexOf('endstream', dataStart, 'latin1');
        if (end === -1) break;
        const data = buf.subarray(dataStart, end);
        try { layers.push(zlib.inflateSync(data)); } catch { /* not Flate, or not a stream */ }
        at = end + 'endstream'.length;
    }
    return layers;
}

function findStrings(bytes, needles) {
    const layers = pdfLayers(bytes);
    return needles.filter(n => encodings(n).some(e => layers.some(l => l.includes(e))));
}

module.exports = { startServer, openPage, hasVendored, parseHeadersFile, headersFor, findStrings, ROOT };
