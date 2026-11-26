// t/631 headless check: run under the PACKED app's own Electron binary with ELECTRON_RUN_AS_NODE=1, so module
// loading goes through the app.asar layer like the main process. Imports the packed extractor via the asar path
// and extracts the fixtures. No window opens.
// Gate (t/631, DevOps packed-extract job): exit 1 unless BOTH required fixtures extract, each as its own format:
// the text-layer PDF (pdfjs-dist) and the DOCX (mammoth). PDF alone does not pass (TL t/631#24).
// Output, one line per fixture: "<name>: OK format=<pdf|docx> words=<n>" or "<name>: THREW code=...".
// The job asserts the formats by name, so keep "OK format=pdf" and "OK format=docx" stable.
// Usage: ELECTRON_RUN_AS_NODE=1 "<exe>" packed-extract-check.cjs <resources dir> <fixtures dir>
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

// `format` set: the fixture must extract, as that format. Unset: informational; a refusal is expected
// (the image-only PDF has no text layer).
const FIXTURES = [
  { name: 't276-fixture-text.pdf', format: 'pdf' },
  { name: 't276-fixture-text.docx', format: 'docx' },
  { name: 't276-fixture-image-only.pdf' },
];

(async () => {
  const [resources, fixtures] = process.argv.slice(2);
  const mod = join(resources, 'app.asar', 'dist', 'main', 'lib', 'extraction', 'extractDocumentText.js');
  const { extractDocumentText } = await import(pathToFileURL(mod).href);
  let failed = false;
  for (const { name, format } of FIXTURES) {
    try {
      const r = await extractDocumentText(new Uint8Array(readFileSync(join(fixtures, name))), name);
      const words = r.text.split(/\s+/).filter(Boolean).length;
      console.log(`${name}: OK format=${r.format} words=${words}`);
      if (format && (r.format !== format || words === 0)) {
        console.log(`${name}: WRONG expected format=${format} with at least one word`);
        failed = true;
      }
    } catch (e) {
      const inner = e && e.innerError ? String(e.innerError.message || e.innerError).split('\n')[0] : '';
      console.log(`${name}: THREW code=${e && e.code} problem=${e && (e.problem || e.message)} inner=${inner}`);
      if (format) failed = true;
    }
  }
  if (failed) process.exitCode = 1;
})().catch((e) => { console.log('FATAL', e && (e.stack || e)); process.exitCode = 1; });
