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

## Privacy by construction

The site's promise is that files never leave the device. Three things back that up, and `/security/` explains them to visitors:

- **No third-party code on tool pages.** The libraries are served from the site itself. `npm run build` copies them from exactly pinned npm packages into `vendor/`, in folders named after their version (`vendor/pdfjs-3.11.174/`), so they can be cached for a year and upgrades can't leave stale copies behind. `vendor/` is generated and not committed.
- **A strict Content Security Policy** in `_headers`. Tool pages may only load scripts from the site and cannot connect to any other server; Redact, Merge and the checker cannot make network requests at all once loaded. Information pages additionally allow Cloudflare Web Analytics. The `/*` rule is a fallback that is a superset of every page's own rule, because Cloudflare joins matching rules and the browser enforces all of them.
- **The tools work offline** once a page has loaded, because the pdf.js worker and the unlock engine start with the page.

The libraries are [PDF.js](https://github.com/mozilla/pdf.js) 3.11.174 (opened with `isEvalSupported: false`, the fix for CVE-2024-4367 in versions before 4.2.67), [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1, and [qpdf](https://github.com/qpdf/qpdf) compiled to WebAssembly by [qpdf-wasm](https://github.com/neslinesli93/qpdf-wasm) 0.3.0. pdf-lib can't read encrypted PDFs, which is why Unlock uses qpdf.

To upgrade a library, change its version in `package.json`, update the paths that mention the old version (the site tests list them), then build and run the tests.

## Development

`app.js` is the source; the site loads the minified `app.min.js`. The build creates `vendor/` and `app.min.js`, and Cloudflare runs it on every deploy. To build locally (for example to preview the site or run the tests):

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
- **Security** (`tests/security.test.js`) loads every page under its security policy and fails if anything is blocked or any request goes to another server. On each tool page it then tries to send data out by fetch, WebSocket, image, outside script, inline script and eval, and checks the browser refuses each one. Finally it loads each tool, switches the network off and checks the tool still works without making a request.
- **Site** (`tests/site.test.js`) checks titles, descriptions, canonical URLs, structured data, the sitemap, shared nav and footer, internal links, that no page makes compliance claims, and that `_headers`, the pages and the pinned library versions all agree.

The test server applies `_headers` the way Cloudflare does, so every browser test runs under the real security policy, and each one fails if the policy has to block anything. The tests need `vendor/`, so run `npm run build` first.

GitHub Actions builds the site and runs the tests on every push and pull request.

## Deployment

Deployed with Cloudflare Workers Builds as a Worker serving static assets (`wrangler.jsonc`):

- Build command: `npm install && npm run build`
- Deploy command: `npx wrangler deploy`

`.assetsignore` keeps tests, source and config files off the live site. `_headers` sets the security headers. Unknown URLs are served `404.html`.

The build command matters: without it there is no `vendor/` and the tools can't load. Pull request previews run the same build, so a preview is a quick way to confirm it.
