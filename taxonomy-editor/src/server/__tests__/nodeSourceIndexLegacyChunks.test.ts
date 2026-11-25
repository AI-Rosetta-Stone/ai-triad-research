// @vitest-environment node

/**
 * t/586 (t/572, spec 6.2 as amended by t/571): the hosted node-source index folds a summary into its base only when the
 * legacy-chunk manifest lists it. A chunk of the canonical carries chunk_of, a chunk of a marked copy carries via (both
 * stripped from SourceReference); either way the surviving quote is attributed to the canonical. A listed chunk whose base
 * is not in the corpus is reported and left as its own source (TL p/50#178: the live reader degrades loudly, the
 * build-time PowerShell refusal is the gate). Every fixture path is inside fs.mkdtemp.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as fileIO from '../storage/fileIO.js';
import { resetNodeSourceIndexCacheForTests, setLegacyChunkManifestPathForTests } from '../storage/nodeSourceIndex.js';
import { log } from '../logger.js';

let dataRoot: string;
let sourcesRoot: string;
let manifestDir: string;

function writeSummary(docId: string, nodeId: string, verbatim: string): void {
  const summary = { pov_summaries: { accelerationist: { key_points: [
    { taxonomy_node_id: nodeId, stance: 'supports', point: 'p', verbatim, excerpt_context: 'c' },
  ] } } };
  fs.writeFileSync(path.join(dataRoot, 'summaries', `${docId}.json`), JSON.stringify(summary));
}

function writeSourceMeta(docId: string, meta: Record<string, unknown>): void {
  const dir = path.join(sourcesRoot, docId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta));
}

function useManifest(chunks: Record<string, string> | null): void {
  const p = path.join(manifestDir, 'source-identity-legacy-chunks.json');
  if (chunks === null) { setLegacyChunkManifestPathForTests(path.join(manifestDir, 'absent.json')); return; }
  fs.writeFileSync(p, JSON.stringify({ version: 1, spec: 'docs/specs/source-identity.md#62-resolver', chunks }));
  setLegacyChunkManifestPathForTests(p);
}

describe('node source index: legacy-chunk manifest (t/586, spec 6.2)', () => {
  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't586-data-'));
    sourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't586-sources-'));
    manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 't586-manifest-'));
    fs.mkdirSync(path.join(dataRoot, 'summaries'), { recursive: true });
    process.env.AI_TRIAD_DATA_ROOT = dataRoot;
    process.env.AI_TRIAD_SOURCES_ROOT = sourcesRoot;
    resetNodeSourceIndexCacheForTests();
  });

  afterEach(() => {
    setLegacyChunkManifestPathForTests(null);
    vi.restoreAllMocks();
    for (const d of [dataRoot, sourcesRoot, manifestDir]) fs.rmSync(d, { recursive: true, force: true });
    delete process.env.AI_TRIAD_DATA_ROOT;
    delete process.env.AI_TRIAD_SOURCES_ROOT;
  });

  it('a listed chunk of the canonical folds in: its distinct quote is attributed to the base', async () => {
    useManifest({ 'report-2026-1': 'report-2026' });
    writeSourceMeta('report-2026', { title: 'The Report', url: 'https://example.com/report' });
    writeSummary('report-2026', 'n1', 'The base says one thing.');
    writeSummary('report-2026-1', 'n1', 'The chunk says something else.');

    const { sources } = await fileIO.getNodeSources('n1');
    expect(sources).toHaveLength(2);
    expect(sources.every(s => s.docId === 'report-2026' && s.canonicalDocId === 'report-2026' && s.title === 'The Report')).toBe(true);
    expect(new Set(sources.map(s => s.verbatim))).toEqual(new Set(['The base says one thing.', 'The chunk says something else.']));
    expect(sources.some(s => 'chunk_of' in s || 'via' in s)).toBe(false); // SourceReference keeps its shape
  });

  it("a listed chunk's near-equal quote is deduped against the base (the base's wording wins)", async () => {
    useManifest({ 'report-2026-1': 'report-2026' });
    writeSourceMeta('report-2026', { title: 'The Report' });
    writeSummary('report-2026', 'n1', 'The US will double down on exporting its tech stack.');
    writeSummary('report-2026-1', 'n1', 'the US will double-down on exporting its tech stack');

    const { sources } = await fileIO.getNodeSources('n1');
    expect(sources).toHaveLength(1);
    expect(sources[0].verbatim).toBe('The US will double down on exporting its tech stack.');
  });

  it("a listed chunk of a marked copy lands on the copy's canonical", async () => {
    useManifest({ 'mirror-2026-1': 'mirror-2026' });
    writeSourceMeta('report-2026', { title: 'The Report', url: 'https://example.com/report' });
    writeSourceMeta('mirror-2026', { title: 'Mirror', url: 'https://example.com/mirror', duplicate_of: 'report-2026' });
    writeSummary('report-2026', 'n1', 'From the original.');
    writeSummary('mirror-2026-1', 'n1', 'From a chunk of the mirror.');

    const { sources } = await fileIO.getNodeSources('n1');
    expect(sources).toHaveLength(2);
    expect(sources.every(s => s.docId === 'report-2026' && s.canonicalDocId === 'report-2026')).toBe(true);
  });

  it('an unlisted -N summary with no source dir stays its own source (the folder-only rule is gone)', async () => {
    useManifest({});
    writeSourceMeta('report-2026', { title: 'The Report' });
    writeSummary('report-2026', 'n1', 'The base says one thing.');
    writeSummary('report-2026-1', 'n1', 'An unlisted part.');

    const { sources } = await fileIO.getNodeSources('n1');
    expect(sources.map(s => s.docId).sort()).toEqual(['report-2026', 'report-2026-1']);
  });

  it('a listed chunk whose base is not in the corpus is left unfolded and logged at error level, without failing the build', async () => {
    useManifest({ 'orphan-2026-1': 'orphan-2026' });
    const errorSpy = vi.spyOn(log.server, 'error').mockImplementation(() => undefined as unknown as ReturnType<typeof log.server.error>);
    writeSourceMeta('other-2026', { title: 'Other' });
    writeSummary('other-2026', 'n1', 'Unrelated.');
    writeSummary('orphan-2026-1', 'n1', 'A chunk whose base is gone.');

    const { sources } = await fileIO.getNodeSources('n1');
    expect(sources.map(s => s.docId).sort()).toEqual(['orphan-2026-1', 'other-2026']);
    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ code: 'missing_base', ids: ['orphan-2026-1'] }), expect.any(String));
  });

  it('a missing manifest file folds nothing, with a WARN', async () => {
    useManifest(null);
    const warnSpy = vi.spyOn(log.server, 'warn').mockImplementation(() => undefined as unknown as ReturnType<typeof log.server.warn>);
    writeSourceMeta('report-2026', { title: 'The Report' });
    writeSummary('report-2026', 'n1', 'The base says one thing.');
    writeSummary('report-2026-1', 'n1', 'The chunk says something else.');

    const { sources } = await fileIO.getNodeSources('n1');
    expect(sources.map(s => s.docId).sort()).toEqual(['report-2026', 'report-2026-1']);
    expect(warnSpy.mock.calls.some(([, msg]) => typeof msg === 'string' && msg.includes('legacy-chunk manifest not found'))).toBe(true);
  });

  it('the shipped manifest is found at the repo root (docs/specs) and loads', async () => {
    setLegacyChunkManifestPathForTests(null);
    const warnSpy = vi.spyOn(log.server, 'warn').mockImplementation(() => undefined as unknown as ReturnType<typeof log.server.warn>);
    writeSourceMeta('report-2026', { title: 'The Report' });
    writeSummary('report-2026', 'n1', 'x');
    await fileIO.getNodeSources('n1');
    expect(warnSpy.mock.calls.some(([, msg]) => typeof msg === 'string' && msg.includes('legacy-chunk manifest not found'))).toBe(false);
  });
});
