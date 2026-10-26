# pdfMask

Private PDF tools (redact, merge, unlock) that run entirely in the browser. Files are never uploaded.

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

The redaction test builds a PDF with secrets hidden in page text, a form field, document metadata, a rotated page and a link from an untouched page, redacts it through the real page in Chromium, and fails if any secret survives anywhere in the downloaded file.

Tests load pdf.js and pdf-lib from the same CDNs as the live site. To run offline, set `PDFMASK_LOCAL_LIBS` to a folder containing `pdf.min.js`, `pdf.worker.min.js` and `pdf-lib.min.js`.

GitHub Actions builds `app.min.js` from `app.js` and runs the tests on every push and pull request.

## Deployment

Deployed with Cloudflare Workers Builds as a Worker serving static assets (`wrangler.jsonc`):

- Build command: `npm install && npm run build`
- Deploy command: `npx wrangler deploy`

`.assetsignore` keeps tests, source and config files off the live site.
