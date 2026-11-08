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
const { ROOT } = require('./helpers');

const ORIGIN = 'https://pdfmask.co.uk';
const SKIP_DIRS = new Set(['.git', '.github', 'node_modules', 'tests', 'assets']);

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
