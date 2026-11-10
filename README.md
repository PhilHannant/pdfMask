# pdfMask

**[pdfmask.co.uk](https://pdfmask.co.uk)**: free, private PDF tools that run entirely in your browser. Files are never uploaded.

- **[Redact PDF](https://pdfmask.co.uk/redact-pdf/):** permanently remove sensitive text, numbers and images
- **[Redaction checker](https://pdfmask.co.uk/redaction-checker/):** find text still hidden under black boxes and other redaction leaks
- **[Merge PDFs](https://pdfmask.co.uk/merge-pdf/):** combine several PDFs into one file
- **[Unlock PDF](https://pdfmask.co.uk/unlock-pdf/)** and **[Remove PDF password](https://pdfmask.co.uk/remove-pdf-password/):** remove restrictions, or a password you know
- **[Guides](https://pdfmask.co.uk/guides/):** subject access requests, bank statements and payslips, disclosure

Built for UK legal, finance and HR teams handling confidential client documents.

## Site structure

Plain static HTML, one folder per page (`redact-pdf/index.html` is served at `/redact-pdf/`). Every page shares `assets/site.css` and the same nav and footer markup; the site tests check they stay identical. When adding a page, also add it to `sitemap.xml`.

`app.js` holds all the tools. Each tool starts only on the page that contains its controls.

Unlock uses [qpdf](https://github.com/qpdf/qpdf) (Apache License 2.0) compiled to WebAssembly by [qpdf-wasm](https://github.com/neslinesli93/qpdf-wasm) (ISC licence), pinned to version 0.3.0 and loaded from jsdelivr inside `unlock-worker.js`, only when someone picks a file. pdf-lib can't read encrypted PDFs, which is why Unlock doesn't use it.

## Development

`app.js` is the source; the site loads the minified `app.min.js`, which Cloudflare builds on every deploy. To build it locally (for example to preview the site):

```sh
npm install
npm run build
```

## Tests

```sh
npx playwright install chromium   # first time only
npm test
```

- **Redaction** (`tests/redact.test.js`) builds a PDF with secrets hidden in page text, a form field, document metadata, a rotated page and a link from an untouched page, redacts it through the real page in Chromium, and fails if any secret survives anywhere in the downloaded file. The result must also pass the redaction checker.
- **Redaction checker** (`tests/checker.test.js`) plants text under black boxes, white boxes, images and invisible text, including single words partway along a line, plus an unapplied redaction mark, an earlier saved version, document properties and an attachment. The checker must report every one, and must not flag look-alikes such as white text on a dark banner, pale grey text or a scanned page's invisible text layer.
- **Unlock** (`tests/unlock.test.js`) unlocks PDFs restricted with 40- and 128-bit RC4 and 128- and 256-bit AES, and one that needs a password (including a space and a £ sign). Each output must no longer be encrypted and must keep its text. A wrong password must be rejected with a clear message.
- **Site** (`tests/site.test.js`) checks titles, descriptions, canonical URLs, structured data, the sitemap, shared nav and footer, internal links, and that no page makes compliance claims.

Tests load pdf.js and pdf-lib from the same CDNs as the live site. To run offline, set `PDFMASK_LOCAL_LIBS` to a folder containing `pdf.min.js`, `pdf.worker.min.js` and `pdf-lib.min.js`, plus `qpdf.js` and `qpdf.wasm` from qpdf-wasm (without those, the unlock tests are skipped).

GitHub Actions builds `app.min.js` from `app.js` and runs the tests on every push and pull request.

## Deployment

Deployed with Cloudflare Workers Builds as a Worker serving static assets (`wrangler.jsonc`):

- Build command: `npm install && npm run build`
- Deploy command: `npx wrangler deploy`

`.assetsignore` keeps tests, source and config files off the live site. Unknown URLs are served `404.html`.
