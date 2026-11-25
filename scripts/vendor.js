// Copies the third-party libraries the tools need out of node_modules and
// into vendor/, so the site serves every script itself and never loads code
// from another server.
//
// Each library goes in a folder named after its exact version, for example
// vendor/pdfjs-3.11.174/. Because the address changes whenever the version
// does, browsers can cache these files for a long time (see _headers), which
// is also what lets the tools keep working offline once a page has loaded.
//
// The versions are pinned exactly in package.json. To upgrade a library,
// change its version there, update the paths that mention the old version
// (tests/site.test.js lists any it finds), then run
// `npm install && npm run build` and the tests. vendor/ is generated, so it
// isn't committed.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// package -> [folder prefix inside vendor/, files to copy]
const LIBRARIES = {
    'pdfjs-dist': ['pdfjs', ['build/pdf.min.js', 'build/pdf.worker.min.js', 'LICENSE']],
    'pdf-lib': ['pdf-lib', ['dist/pdf-lib.min.js', 'LICENSE.md']],
    '@neslinesli93/qpdf-wasm': ['qpdf-wasm', ['dist/qpdf.js', 'dist/qpdf.wasm', 'LICENSE']]
};

// Licence files are copied when the package ships one.
const OPTIONAL = new Set(['LICENSE', 'LICENSE.md']);

const pinned = require(path.join(ROOT, 'package.json')).devDependencies;

// Where each library is served from, e.g. { 'pdfjs-dist': '/vendor/pdfjs-3.11.174/' }.
function vendorPaths() {
    return Object.fromEntries(Object.entries(LIBRARIES)
        .map(([pkg, [prefix]]) => [pkg, `/vendor/${prefix}-${pinned[pkg]}/`]));
}

function build() {
    fs.rmSync(path.join(ROOT, 'vendor'), { recursive: true, force: true });
    for (const [pkg, [prefix, files]] of Object.entries(LIBRARIES)) {
        const pkgDir = path.join(ROOT, 'node_modules', pkg);
        const manifest = path.join(pkgDir, 'package.json');
        if (!fs.existsSync(manifest)) {
            throw new Error(`${pkg} is not installed. Run "npm install" first.`);
        }
        const { version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (version !== pinned[pkg]) {
            throw new Error(`${pkg} is ${version} in node_modules, but package.json pins ${pinned[pkg]}.`);
        }
        const outDir = path.join(ROOT, 'vendor', `${prefix}-${version}`);
        fs.mkdirSync(outDir, { recursive: true });
        for (const file of files) {
            const from = path.join(pkgDir, file);
            if (!fs.existsSync(from)) {
                if (OPTIONAL.has(path.basename(file))) continue;
                throw new Error(`${pkg}@${version} has no ${file}.`);
            }
            fs.copyFileSync(from, path.join(outDir, path.basename(file)));
        }
    }
    console.log('vendor/ ready: ' + Object.values(vendorPaths()).join(', '));
}

if (require.main === module) build();

module.exports = { vendorPaths };
