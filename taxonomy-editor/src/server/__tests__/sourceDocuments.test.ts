import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveSourceDocument, readSourceDocumentPdf, loadSnapshot } from '../storage/fileIO';

// Source documents are resolved relative to AI_TRIAD_SOURCES_ROOT (see config.getSourcesRoot).
let sourcesRoot: string;
const PDF_BYTES = Buffer.from('%PDF-1.4\n%fake pdf body\n%%EOF');

function makeSource(id: string, opts: { snapshot?: string; pdf?: Buffer; metadata?: Record<string, unknown> }) {
  const dir = path.join(sourcesRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.metadata) fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(opts.metadata));
  if (opts.snapshot !== undefined) fs.writeFileSync(path.join(dir, 'snapshot.md'), opts.snapshot);
  if (opts.pdf) {
    const rawDir = path.join(dir, 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, `${id}.pdf`), opts.pdf);
  }
}

describe('source document resolution', () => {
  beforeAll(() => {
    sourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'src-docs-'));
    process.env.AI_TRIAD_SOURCES_ROOT = sourcesRoot;
  });

  afterAll(() => {
    delete process.env.AI_TRIAD_SOURCES_ROOT;
    fs.rmSync(sourcesRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean slate each test so leftover dirs don't cross-contaminate.
    for (const entry of fs.readdirSync(sourcesRoot)) {
      fs.rmSync(path.join(sourcesRoot, entry), { recursive: true, force: true });
    }
  });

  it('AC#1: returns markdown content for a markdown source', async () => {
    makeSource('md-doc', { snapshot: '# Hello\n\nbody text', metadata: { source_type: 'html' } });
    const res = await resolveSourceDocument('md-doc');
    expect(res).toEqual({ available: true, type: 'markdown', content: '# Hello\n\nbody text' });
  });

  it('AC#2: prefers markdown snapshot over PDF for inline display with claim highlighting', async () => {
    makeSource('pdf-doc', { snapshot: 'extracted text', pdf: PDF_BYTES, metadata: { source_type: 'pdf' } });
    const res = await resolveSourceDocument('pdf-doc');
    expect(res).toEqual({ available: true, type: 'markdown', content: 'extracted text' });
  });

  it('serves a PDF even without metadata when only a raw PDF exists', async () => {
    makeSource('raw-only', { pdf: PDF_BYTES });
    const res = await resolveSourceDocument('raw-only');
    expect(res).toEqual({ available: true, type: 'pdf', path: '/api/source-documents/raw-only/file' });
  });

  it('prefers markdown when the source type is not a PDF, even if a PDF is present', async () => {
    makeSource('mixed', { snapshot: 'snap', pdf: PDF_BYTES, metadata: { source_type: 'html' } });
    const res = await resolveSourceDocument('mixed');
    expect(res.type).toBe('markdown');
    expect(res.content).toBe('snap');
  });

  it('AC#3: returns { available: false } for a missing document', async () => {
    const res = await resolveSourceDocument('does-not-exist');
    expect(res).toEqual({ available: false, type: null });
  });

  it('rejects unsafe ids', async () => {
    await expect(resolveSourceDocument('../etc/passwd')).rejects.toThrow();
  });

  it('readSourceDocumentPdf returns the raw bytes for a PDF source', async () => {
    makeSource('pdf-doc', { pdf: PDF_BYTES, metadata: { source_type: 'pdf' } });
    const buf = await readSourceDocumentPdf('pdf-doc');
    expect(buf).not.toBeNull();
    expect(Buffer.compare(buf!, PDF_BYTES)).toBe(0);
  });

  it('readSourceDocumentPdf returns null when no PDF exists', async () => {
    makeSource('md-doc', { snapshot: 'no pdf here' });
    expect(await readSourceDocumentPdf('md-doc')).toBeNull();
  });

  // t/4394/t/4411: a pre-#3671 PDF snapshot may carry console-code-page mojibake
  // (cp1252-as-cp437: U+2019 written as Æ). Both display paths repair on read;
  // the file itself is untouched.
  it('resolveSourceDocument repairs cp1252-as-cp437 mojibake in the returned content', async () => {
    makeSource('mojibake-doc', { snapshot: 'The governmentÆs plan is clear.' });
    const res = await resolveSourceDocument('mojibake-doc');
    expect(res).toEqual({ available: true, type: 'markdown', content: 'The government’s plan is clear.' });
  });

  it('loadSnapshot repairs cp1252-as-cp437 mojibake in the returned content', async () => {
    makeSource('mojibake-doc-2', { snapshot: 'The governmentÆs plan is clear.' });
    expect(await loadSnapshot('mojibake-doc-2')).toBe('The government’s plan is clear.');
  });

  it('leaves clean snapshots byte-identical (no false-positive repair)', async () => {
    makeSource('clean-doc', { snapshot: 'Café au lait, s’il vous plaît.' });
    const res = await resolveSourceDocument('clean-doc');
    expect(res.content).toBe('Café au lait, s’il vous plaît.');
  });
});
