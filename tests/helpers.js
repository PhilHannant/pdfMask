// Shared helpers for the browser tests: a static server for the site, an
// optional route that swaps the CDN libraries for local copies (for offline
// runs), and a scanner that looks for text anywhere inside a PDF's bytes.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.png': 'image/png',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf'
};

function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
        });
    });
}

// Set PDFMASK_LOCAL_LIBS to a folder containing pdf.min.js, pdf.worker.min.js
// and pdf-lib.min.js to run without reaching the CDNs. CI uses the real CDNs.
async function routeLocalLibs(context) {
    const dir = process.env.PDFMASK_LOCAL_LIBS;
    if (!dir) return;
    const serve = name => route => route.fulfill({
        body: fs.readFileSync(path.join(dir, name)),
        contentType: 'text/javascript',
        headers: { 'Access-Control-Allow-Origin': '*' }
    });
    await context.route('**/pdf.js/3.11.174/pdf.min.js', serve('pdf.min.js'));
    await context.route('**/pdf.js/3.11.174/pdf.worker.min.js', serve('pdf.worker.min.js'));
    await context.route('**/pdf-lib@1.17.1/dist/pdf-lib.min.js', serve('pdf-lib.min.js'));
}

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

module.exports = { startServer, routeLocalLibs, findStrings, ROOT };
