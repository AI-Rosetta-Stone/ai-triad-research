// t/631 headless check: run under the PACKED app's own Electron binary with ELECTRON_RUN_AS_NODE=1, so module
// loading goes through the app.asar layer like the main process. Imports the packed extractor via the asar path
// and extracts the two fixtures. No window opens.
// Gate (t/631, DevOps packed-extract job): exit 1 when the text-layer fixture does not extract.
// Usage: ELECTRON_RUN_AS_NODE=1 "<exe>" packed-extract-check.cjs <resources dir> <fixtures dir>
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const [resources, fixtures] = process.argv.slice(2);
  const mod = join(resources, 'app.asar', 'dist', 'main', 'lib', 'extraction', 'extractDocumentText.js');
  const { extractDocumentText } = await import(pathToFileURL(mod).href);
  let failed = false;
  for (const name of ['t276-fixture-text.pdf', 't276-fixture-image-only.pdf']) {
    try {
      const r = await extractDocumentText(new Uint8Array(readFileSync(join(fixtures, name))), name);
      console.log(`${name}: OK format=${r.format} words=${r.text.split(/\s+/).filter(Boolean).length}`);
    } catch (e) {
      const inner = e && e.innerError ? String(e.innerError.message || e.innerError).split('\n')[0] : '';
      console.log(`${name}: THREW code=${e && e.code} problem=${e && (e.problem || e.message)} inner=${inner}`);
      // The text-layer fixture must extract. The image-only fixture has no text layer, so a refusal there is expected.
      if (name === 't276-fixture-text.pdf') failed = true;
    }
  }
  if (failed) process.exitCode = 1;
})().catch((e) => { console.log('FATAL', e && (e.stack || e)); process.exitCode = 1; });
