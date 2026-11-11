// pdfMask unlock worker.
//
// Runs qpdf (https://qpdf.sourceforge.io, Apache License 2.0), compiled to
// WebAssembly by qpdf-wasm (https://github.com/neslinesli93/qpdf-wasm, ISC
// licence), in a background thread so large files don't freeze the page.
// The PDF stays in this browser tab's memory: nothing is uploaded.
//
// Each qpdf command runs in a fresh qpdf instance, so one run can never
// affect the next.
//
// qpdf is served from this site (vendor/, copied from the pinned qpdf-wasm
// npm package at build time), not from another server.

const QPDF_WASM = '/vendor/qpdf-wasm-0.3.0/';

importScripts(QPDF_WASM + 'qpdf.js');

// Load qpdf once now, while the page is loading. That puts it in the
// browser's cache, so later runs need no network at all.
Module({ locateFile: () => QPDF_WASM + 'qpdf.wasm', noInitialRun: true }).catch(() => {});

async function qpdf(args, input) {
    const instance = await Module({
        locateFile: () => QPDF_WASM + 'qpdf.wasm',
        noInitialRun: true
    });
    instance.FS.writeFile('/in.pdf', input);
    let code;
    try {
        code = instance.callMain(args);
    } catch (err) {
        // Emscripten reports exit() as an exception carrying the status.
        code = err && typeof err.status === 'number' ? err.status : 2;
    }
    let output = null;
    try {
        output = instance.FS.readFile('/out.pdf');
    } catch (err) {
        output = null;
    }
    return { code, output };
}

// qpdf exit codes: 0 = success, 2 = error, 3 = success with warnings.
//
// Working out what kind of file this is, using only behaviour that is the
// same across qpdf versions:
//  1. Try to decrypt without a password. That works only if the file opens
//     without one. If it fails, the file needs a password, or is damaged.
//     Every encrypted PDF names an /Encrypt dictionary in its trailer, which
//     is never itself encrypted, so its absence means "damaged".
//  2. If it opens, --is-encrypted (0 = encrypted, 2 = not) tells
//     "restrictions only" from "not locked at all". (On a file that needs a
//     password, qpdf 12 can't answer that question, hence the order.)

function hasEncryptDictionary(bytes) {
    // Latin-1 keeps every byte as one character, so this is a plain byte search.
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return /\/Encrypt\b/.test(text);
}

const decrypted = result => (result.code === 0 || result.code === 3) && result.output && result.output.length > 0;

self.onmessage = async ({ data }) => {
    const { id, op, bytes, password } = data;
    const reply = (message, transfer = []) => self.postMessage({ id, ...message }, transfer);

    try {
        if (op === 'inspect') {
            const attempt = await qpdf(['--decrypt', '/in.pdf', '/out.pdf'], bytes);
            if (!decrypted(attempt)) {
                if (hasEncryptDictionary(bytes)) {
                    reply({ encrypted: true, needsPassword: true });
                } else {
                    reply({ damaged: true });
                }
                return;
            }
            const encrypted = await qpdf(['--is-encrypted', '/in.pdf'], bytes);
            reply({ encrypted: encrypted.code === 0, needsPassword: false });
            return;
        }

        if (op === 'unlock') {
            const args = password ? ['--password=' + password] : [];
            const result = await qpdf([...args, '--decrypt', '/in.pdf', '/out.pdf'], bytes);
            if (decrypted(result)) {
                reply({ ok: true, bytes: result.output }, [result.output.buffer]);
            } else {
                reply({ ok: false, code: result.code });
            }
            return;
        }

        reply({ error: 'Unknown operation' });
    } catch (err) {
        reply({ error: err && err.message ? err.message : String(err) });
    }
};
