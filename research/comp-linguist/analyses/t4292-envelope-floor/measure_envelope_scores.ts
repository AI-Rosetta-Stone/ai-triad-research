/**
 * t/4292 step 1: score distributions of the inquiry grounding envelope's per-camp top-3, before any floor
 * is chosen. Offline, no model spend.
 *
 * Uses the PRODUCTION selector (buildGroundingEnvelope) and the PRODUCTION query embedder (the server's
 * ONNX all-MiniLM-L6-v2, which the server documents as vector-identical to the corpus). Scores are
 * recomputed with the same cosineSimilarity for the selected nodes and for each camp's full distribution,
 * and the selection is cross-checked against an independent top-3 so a mismatch is caught, not assumed.
 *
 * Run from the repo root of a worktree, with AI_TRIAD_ONNX_MODEL_DIR set (offline, never fetch):
 *   npx tsx research/comp-linguist/analyses/t4292-envelope-floor/measure_envelope_scores.ts > out.json
 */
import { loadTaxonomy } from '../../../../lib/debate/taxonomyLoader';
import { buildGroundingEnvelope } from '../../../../lib/debate/inquiryGrounding';
import { cosineSimilarity } from '../../../../lib/embeddings/similarity';
import { computeEmbeddings } from '../../../../lib/embeddings/onnxEmbedding';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));  // ESM: no __dirname
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(HERE, 'questions.json'), 'utf-8')) as
  { id: string; kind: string; source: string; text: string }[];
const CAMP_OF: Record<string, string> = { accelerationist: 'acc', safetyist: 'saf', skeptic: 'skp' };

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const tax = loadTaxonomy(repoRoot);
  const povNodes = [...tax.accelerationist.nodes, ...tax.safetyist.nodes, ...tax.skeptic.nodes];
  const embeddedPov: Record<string, { pov: string; vector: number[] }> = {};
  for (const n of povNodes) {
    const e = tax.embeddings[n.id];
    if (e?.vector?.length) embeddedPov[n.id] = { pov: e.pov, vector: e.vector };
  }
  const label = new Map(povNodes.map(n => [n.id, (n as { label?: string }).label ?? '']));
  const embed = (texts: string[]) => computeEmbeddings(texts);

  const out: unknown[] = [];
  for (const q of QUESTIONS) {
    const { envelope } = await buildGroundingEnvelope(q.text, {
      povNodes, situationNodes: tax.situations.nodes, nodeEmbeddings: tax.embeddings as never,
    }, embed);
    const [qv] = await embed([q.text]);
    const perCamp: Record<string, unknown> = {};
    for (const camp of ['acc', 'saf', 'skp']) {
      const all = Object.entries(embeddedPov)
        .filter(([, e]) => CAMP_OF[e.pov] === camp || e.pov === camp)
        .map(([id, e]) => ({ id, score: cosineSimilarity(qv, e.vector) }))
        .sort((a, b) => b.score - a.score);
      const refs = ((envelope.nodesByCamp as Record<string, { nodeId: string }[]>)[camp] ?? []).map(r => r.nodeId);
      const independentTop = all.slice(0, refs.length).map(x => x.id);
      perCamp[camp] = {
        selected: refs.map(id => ({ id, label: label.get(id), score: all.find(x => x.id === id)?.score })),
        selection_matches_independent_top: JSON.stringify(refs) === JSON.stringify(independentTop),
        camp_n: all.length,
        camp_p50: all[Math.floor(all.length / 2)]?.score,
        camp_p90: all[Math.floor(all.length * 0.1)]?.score,
        camp_max: all[0]?.score,
      };
    }
    out.push({ ...q, anchor: envelope.anchorSituationId ?? null, camps: perCamp });
  }
  process.stdout.write(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
