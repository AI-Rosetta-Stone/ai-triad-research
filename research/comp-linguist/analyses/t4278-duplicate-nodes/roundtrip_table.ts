/**
 * t/4353 / t/4278 normalisation prep: the per-writer round-trip table (SO e/343#8, #12).
 * For each target file, re-serialise the parsed committed content with each writer's ACTUAL serialiser
 * and compare it with the committed bytes (CRLF normalised to LF first, so a line-ending difference is
 * reported separately rather than hiding a format difference).
 *
 * Writers measured here (TS, run in-process):
 *   - TS-pretty: JSON.stringify(obj, null, 2) + '\n'. This is writeJsonFileAtomic (fileIO.ts:355), used by
 *     writeTaxonomyFile for the POV files.
 *   - TS-pretty-noNL: JSON.stringify(obj, null, 2) with no trailing newline (embeddings.ts:404).
 *   - TS-hybrid-edges: serializeEdgesJson (lib/edges/serializeEdges.ts), used by writeEdgesFile and
 *     modulateEdgeWeights. This is the designed edges.json format (docs/edges-json-format.md).
 * The Python and PS rows are produced by roundtrip_table_py.py and roundtrip_table.ps1 alongside this.
 *
 * Usage, from the repo root: npx tsx <this> <ai-triad-data root> <rev>
 */
import { execFileSync } from 'child_process';
import { serializeEdgesJson } from '../../../../lib/edges/serializeEdges';

const [dataRoot, rev] = process.argv.slice(2);
const FILES = ['taxonomy/Origin/skeptic.json', 'taxonomy/Origin/safetyist.json',
  'taxonomy/Origin/accelerationist.json', 'taxonomy/Origin/edges.json', 'taxonomy/Origin/embeddings.json'];
const WRITERS: Record<string, (o: unknown) => string> = {
  'TS-pretty+NL': o => JSON.stringify(o, null, 2) + '\n',
  'TS-pretty-noNL': o => JSON.stringify(o, null, 2),
  'TS-hybrid-edges': o => serializeEdgesJson(o),
};

for (const f of FILES) {
  const raw = execFileSync('git', ['-C', dataRoot, 'show', `${rev}:${f}`], { maxBuffer: 1 << 30 }).toString('utf-8');
  const crlf = raw.includes('\r\n');
  const text = raw.replace(/\r\n/g, '\n');
  const obj = JSON.parse(text);
  const row: string[] = [];
  for (const [name, w] of Object.entries(WRITERS)) {
    let out: string;
    try { out = w(obj); } catch { row.push(`${name}=n/a`); continue; }
    if (out === text) { row.push(`${name}=MATCH`); continue; }
    let i = 0; while (i < out.length && i < text.length && out[i] === text[i]) i++;
    row.push(`${name}=diff@${i}(${(out.length / text.length).toFixed(3)}x)`);
  }
  console.log(`${f.split('/').pop()}${crlf ? ' [CRLF on disk]' : ''}: ${row.join('  ')}`);
}
