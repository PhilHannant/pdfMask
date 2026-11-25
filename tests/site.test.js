// Site-wide SEO and consistency checks. These run without a browser.
//
// Every page is hand-written HTML sharing the same nav and footer, so these
// tests catch the drift that creeps in when pages are added or edited:
// duplicate titles, wrong canonical URLs, broken JSON-LD, missing sitemap
// entries, mismatched navigation and broken internal links.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, parseHeadersFile, headersFor } = require('./helpers');
const { vendorPaths } = require('../scripts/vendor');

const ORIGIN = 'https://pdfmask.co.uk';
const SKIP_DIRS = new Set(['.git', '.github', 'node_modules', 'tests', 'assets', 'vendor', 'scripts']);

function findPages(dir = ROOT, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) findPages(path.join(dir, entry.name), found);
        } else if (entry.name.endsWith('.html')) {
            found.push(path.join(dir, entry.name));
        }
    }
    return found;
}

function urlFor(file) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    return ORIGIN + '/' + rel.replace(/(^|\/)index\.html$/, '$1');
}

const pages = findPages().map(file => {
    const html = fs.readFileSync(file, 'utf8');
    const pick = re => (html.match(re) || [])[1];
    return {
        file: path.relative(ROOT, file),
        url: urlFor(file),
        html,
        title: pick(/<title>([^<]*)<\/title>/),
        description: pick(/<meta name="description"\s+content="([^"]*)"/),
        canonical: pick(/<link rel="canonical" href="([^"]*)"/),
        noindex: /<meta name="robots" content="noindex/.test(html),
        h1s: html.match(/<h1[\s>]/g) || [],
        nav: pick(/(<header class="navbar">[\s\S]*?<\/header>)/),
        footer: pick(/(<footer class="site-footer">[\s\S]*?<\/footer>)/)
    };
});
const indexable = pages.filter(p => !p.noindex);

test('every page has exactly one h1 and the shared nav and footer', () => {
    const canonicalNav = s => s && s.replace(/ aria-current="page"/g, '');
    const [first] = pages;
    for (const p of pages) {
        assert.equal(p.h1s.length, 1, `${p.file} should have one h1`);
        assert.ok(p.nav, `${p.file} is missing the nav`);
        assert.ok(p.footer, `${p.file} is missing the footer`);
        assert.equal(canonicalNav(p.nav), canonicalNav(first.nav), `${p.file} nav differs from ${first.file}`);
        assert.equal(p.footer, first.footer, `${p.file} footer differs from ${first.file}`);
        assert.ok((p.nav.match(/aria-current/g) || []).length <= 1, `${p.file} marks more than one nav link as current`);
    }
});

test('indexable pages have unique titles, descriptions and correct canonical URLs', () => {
    const seenTitles = new Map();
    const seenDescriptions = new Map();
    for (const p of indexable) {
        assert.ok(p.title, `${p.file} has no title`);
        assert.ok(p.title.length <= 65, `${p.file} title is ${p.title.length} chars: ${p.title}`);
        assert.ok(p.description, `${p.file} has no meta description`);
        assert.ok(p.description.length >= 70 && p.description.length <= 170,
            `${p.file} description is ${p.description.length} chars`);
        assert.equal(p.canonical, p.url, `${p.file} canonical should be its own URL`);
        assert.ok(!seenTitles.has(p.title), `${p.file} repeats the title of ${seenTitles.get(p.title)}`);
        assert.ok(!seenDescriptions.has(p.description), `${p.file} repeats the description of ${seenDescriptions.get(p.description)}`);
        seenTitles.set(p.title, p.file);
        seenDescriptions.set(p.description, p.file);
    }
});

test('structured data is valid JSON and breadcrumbs point at real pages', () => {
    const urls = new Set(pages.map(p => p.url));
    for (const p of pages) {
        for (const [, json] of p.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
            let data;
            assert.doesNotThrow(() => { data = JSON.parse(json); }, `${p.file} has invalid JSON-LD`);
            const nodes = data['@graph'] || [data];
            for (const node of nodes.filter(n => n['@type'] === 'BreadcrumbList')) {
                const items = node.itemListElement;
                assert.equal(items[items.length - 1].item, p.url, `${p.file} breadcrumb should end at the page itself`);
                for (const item of items) assert.ok(urls.has(item.item), `${p.file} breadcrumb links to unknown ${item.item}`);
            }
        }
    }
});

test('the sitemap lists exactly the indexable pages', () => {
    const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
    const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).sort();
    assert.deepEqual(listed, indexable.map(p => p.url).sort());
    const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
    assert.match(robots, new RegExp(`Sitemap: ${ORIGIN}/sitemap.xml`));
});

test('internal links and assets all resolve', () => {
    for (const p of pages) {
        for (const [, href] of p.html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
            let target = path.join(ROOT, href);
            if (href.endsWith('/')) target = path.join(target, 'index.html');
            assert.ok(fs.existsSync(target), `${p.file} links to missing ${href}`);
        }
    }
});

test('pages make no compliance claims', () => {
    // Pages should describe how pdfMask fits a task, and leave the rules to
    // the ICO and the user. They mustn't promise anyone is compliant.
    for (const p of pages) {
        const text = p.html.replace(/<[^>]+>/g, ' ');
        assert.doesNotMatch(text, /\bcomplian(t|ce guaranteed)\b|\bmakes you compliant\b|\bGDPR[- ]proof\b/i, `${p.file} makes a compliance claim`);
    }
});

// ---------------------------------------------------------------------------
// Security policy (_headers)
// ---------------------------------------------------------------------------

const TOOL_PAGES = ['/redact-pdf/', '/redaction-checker/', '/merge-pdf/', '/unlock-pdf/', '/remove-pdf-password/'];
const VENDOR = vendorPaths();
const WORKER_SCRIPTS = [VENDOR['pdfjs-dist'] + 'pdf.worker.min.js', '/unlock-worker.js'];
const ANALYTICS = 'https://static.cloudflareinsights.com';
const rules = parseHeadersFile();
const pathOf = p => new URL(p.url).pathname;

// "a; b c; d e" -> { a: [], b: ['c'], d: ['e'] }
function parsePolicy(policy) {
    const directives = {};
    for (const part of policy.split(';').map(x => x.trim()).filter(Boolean)) {
        const [name, ...sources] = part.split(/\s+/);
        directives[name] = sources.filter(x => x !== "'none'");
    }
    return directives;
}

const hasPolicy = rule => rule.set.some(([name]) => name === 'content-security-policy');
const ownRules = urlPath => rules.filter(r => r.path !== '/*' && hasPolicy(r) && (r.path === urlPath ||
    (r.path.includes('*') && urlPath.startsWith(r.path.split('*')[0]))));
const cspOf = rule => parsePolicy(rule.set.find(([name]) => name === 'content-security-policy')[1]);
const fallback = cspOf(rules.find(r => r.path === '/*'));

test('every page and worker has its own security policy, narrower than the fallback', () => {
    // Cloudflare joins the fallback and the page's own policy, and the browser
    // enforces both. That only works if the fallback allows everything the
    // page's policy allows.
    for (const urlPath of [...pages.filter(p => p.file !== '404.html').map(pathOf), ...WORKER_SCRIPTS]) {
        const own = ownRules(urlPath);
        assert.equal(own.length, 1, `${urlPath} should have exactly one rule of its own in _headers`);
        const policy = cspOf(own[0]);
        assert.deepEqual(policy['default-src'], [], `${urlPath} should start from default-src 'none'`);
        for (const [directive, sources] of Object.entries(policy)) {
            assert.ok(directive in fallback, `${urlPath} uses ${directive}, which the /* fallback lacks`);
            for (const source of sources) {
                assert.ok(fallback[directive].includes(source), `${urlPath} allows ${source} in ${directive}, but the /* fallback doesn't`);
            }
        }
    }
});

test('pages that open files load and connect to nothing outside this site', () => {
    for (const urlPath of [...TOOL_PAGES, ...WORKER_SCRIPTS]) {
        const header = headersFor(urlPath, rules)['content-security-policy'];
        const policy = cspOf(ownRules(urlPath)[0]);
        const allowed = Object.values(policy).flat();
        for (const source of allowed) {
            assert.ok(["'self'", "'wasm-unsafe-eval'"].includes(source), `${urlPath} allows ${source}`);
        }
        const usesWasm = /unlock|remove-pdf-password/.test(urlPath);
        assert.deepEqual(policy['connect-src'], usesWasm ? ["'self'"] : [], `${urlPath} connect-src`);
        assert.equal(policy['script-src'].includes("'wasm-unsafe-eval'"), usesWasm, `${urlPath} wasm`);
        assert.ok(!/'unsafe-inline'|'unsafe-eval'|\*|https?:/.test(header.split(', ').pop()), `${urlPath} policy is too loose`);
    }
});

test('information pages allow only the analytics script from outside', () => {
    for (const p of pages.filter(p => p.file !== '404.html' && !TOOL_PAGES.includes(pathOf(p)))) {
        const policy = cspOf(ownRules(pathOf(p))[0]);
        const external = Object.values(policy).flat().filter(x => !x.startsWith("'"));
        assert.deepEqual(external, [ANALYTICS], `${p.file} external sources`);
        assert.ok(!Object.values(policy).flat().includes("'wasm-unsafe-eval'"), `${p.file} should not allow WebAssembly`);
    }
});

test('pages contain nothing the security policy would block', () => {
    for (const p of pages) {
        assert.doesNotMatch(p.html, /\sstyle="/, `${p.file} has an inline style attribute`);
        assert.doesNotMatch(p.html, /<style[\s>]/, `${p.file} has an inline <style> block`);
        assert.doesNotMatch(p.html, /\son[a-z]+="/, `${p.file} has an inline event handler`);
        for (const [tag] of p.html.matchAll(/<script\b[^>]*>/g)) {
            assert.ok(/\ssrc="\/[^/]/.test(tag) || /type="application\/ld\+json"/.test(tag),
                `${p.file} has a script that isn't served from this site: ${tag}`);
        }
        for (const [, url] of p.html.matchAll(/<(?:link rel="(?:stylesheet|icon|preconnect|preload)"|img|iframe|source)\b[^>]*(?:href|src)="([^"]+)"/g)) {
            assert.ok(url.startsWith('/') && !url.startsWith('//'), `${p.file} loads ${url} from outside this site`);
        }
    }
});

test('every reference to a library uses the version pinned in package.json', () => {
    // Libraries are served from folders named after their version. After an
    // upgrade, this lists every place that still points at the old one.
    const sources = [...pages.map(p => [p.file, p.html]),
        ...['app.js', 'unlock-worker.js', '_headers'].map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')])];
    const current = Object.values(VENDOR);
    for (const [file, text] of sources) {
        for (const [ref] of text.matchAll(/\/vendor\/[a-z-]+-\d[\w.]*\//g)) {
            assert.ok(current.includes(ref), `${file} refers to ${ref}, but package.json pins ${current.join(', ')}`);
        }
        assert.doesNotMatch(text, /\/vendor\/(pdfjs|pdf-lib|qpdf|qpdf-wasm)\//, `${file} has a library path without a version`);
    }
});

test('tool code has no references to other servers', () => {
    for (const file of ['app.js', 'unlock-worker.js']) {
        const code = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\/.*$/gm, '');
        assert.doesNotMatch(code, /https?:\/\//, `${file} refers to an outside URL in code`);
    }
});
