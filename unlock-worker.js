// pdfMask unlock worker.
//
// Runs qpdf (https://qpdf.sourceforge.io, Apache License 2.0), compiled to
// WebAssembly by qpdf-wasm (https://github.com/neslinesli93/qpdf-wasm, ISC
// licence), in a background thread so large files don't freeze the page.
// The PDF stays in this browser tab's memory: nothing is uploaded.
//
// Each qpdf command runs in a fresh qpdf instance, so one run can never
// affect the next.

const QPDF_WASM = 'https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/';

importScripts(QPDF_WASM + 'qpdf.js');

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
// --is-encrypted:      0 = encrypted, 2 = not encrypted
// --requires-password: 0 = a password is needed to open it,
//                      3 = encrypted, but it opens without one (restrictions only)

self.onmessage = async ({ data }) => {
    const { id, op, bytes, password } = data;
    const reply = (message, transfer = []) => self.postMessage({ id, ...message }, transfer);

    try {
        if (op === 'inspect') {
            const encrypted = await qpdf(['--is-encrypted', '/in.pdf'], bytes);
            if (encrypted.code !== 0) {
                reply({ encrypted: false });
                return;
            }
            const required = await qpdf(['--requires-password', '/in.pdf'], bytes);
            reply({ encrypted: true, needsPassword: required.code === 0 });
            return;
        }

        if (op === 'unlock') {
            const args = password ? ['--password=' + password] : [];
            const result = await qpdf([...args, '--decrypt', '/in.pdf', '/out.pdf'], bytes);
            const ok = (result.code === 0 || result.code === 3) && result.output && result.output.length > 0;
            if (ok) {
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
