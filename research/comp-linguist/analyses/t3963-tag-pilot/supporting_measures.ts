/**
 * t/3963 supporting measures (pre-registered in t/3963#3, unchanged by #7): the crux overlap A1 vs A3,
 * and the tagged-selected share. Also the boost check for TAG_BOOST_INCREMENT (register §142).
 *
 * EXPLORATORY. #3 names these measures but doesn't operationalise them, and this script was written
 * after the stage-2 data existed. Every choice below is therefore post-data. Report it as descriptive,
 * never as a decision rule.
 *
 *  - Crux overlap. A debate's crux set is the union of its neutral-evaluation cruxes over all
 *    checkpoints (baseline, midpoint, final), deduplicated by description. Two cruxes match if their
 *    MiniLM cosine is >= tau (greedy, one to one). Soft Jaccard = matches / (|A| + |B| - matches).
 *    It's reported at tau = 0.75, 0.80 and 0.85, for the between-wing pair (A1, A3) and, as its noise
 *    reference, the within-wing pairs (A1, A2) and (A3, A4).
 *  - Tagged share. This is a CITED share, not an injected one: the debate file records only the count
 *    of injected Skeptic nodes, not their ids. A debate's Skeptic set is the unique skp-* node ids in
 *    the taxonomy_refs of its Skeptic turns. A node counts as tagged if its pov_tags include the tag;
 *    nodes carrying both tags count for both.
 *  - Boost check. For each wing: the Prioritize arm's tagged share against A0 (the boost does nothing)
 *    and the Scope arm (the boost behaves like Scope).
 *
 * Usage, from a worktree root (set AI_TRIAD_ONNX_MODEL_DIR):
 *   npx tsx research/comp-linguist/analyses/t3963-tag-pilot/supporting_measures.ts <skeptic.json> <stage dir> [<stage dir> ...]
 */
import * as fs from 'fs';
import * as path from 'path';
import { computeEmbeddings } from '../../../../lib/embeddings/onnxEmbedding';
import { cosineSimilarity } from '../../../../lib/embeddings/similarity';

const ARMS = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'] as const;
const TAUS = [0.75, 0.8, 0.85];
const ARM_TAG: Record<string, string> = { a1: 'critical', a2: 'critical', a3: 'institutional', a4: 'institutional' };

type Debate = {
  transcript?: { speaker?: string; taxonomy_refs?: { node_id?: string }[] }[];
  neutral_evaluations?: { cruxes?: { description?: string }[] }[];
};

function softJaccard(a: number[][], b: number[][], tau: number): number {
  if (a.length === 0 && b.length === 0) return NaN;
  const pairs: [number, number, number][] = [];
  a.forEach((u, i) => b.forEach((v, j) => pairs.push([cosineSimilarity(u, v), i, j])));
  pairs.sort((x, y) => y[0] - x[0]);
  const usedA = new Set<number>(), usedB = new Set<number>();
  let m = 0;
  for (const [s, i, j] of pairs) {
    if (s < tau) break;
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i); usedB.add(j); m++;
  }
  return m / (a.length + b.length - m);
}

const median = (xs: number[]) => {
  const s = xs.filter(x => !Number.isNaN(x)).sort((x, y) => x - y);
  if (s.length === 0) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;

async function main(): Promise<void> {
  const [skepticFile, ...dirs] = process.argv.slice(2);
  if (!skepticFile || dirs.length === 0) {
    throw new Error('usage: supporting_measures.ts <skeptic.json> <stage dir> [<stage dir> ...]');
  }
  const tags = new Map<string, string[]>();
  for (const n of JSON.parse(fs.readFileSync(skepticFile, 'utf-8')).nodes) tags.set(n.id, n.pov_tags ?? []);

  // motion -> arm -> debate
  const byMotion = new Map<string, Map<string, Debate>>();
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      const m = /^t3963s\d-(m\d+)-(a\d)-debate\.json$/.exec(f);
      if (!m) continue;
      if (!byMotion.has(m[1])) byMotion.set(m[1], new Map());
      byMotion.get(m[1])!.set(m[2], JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
    }
  }
  const motions = [...byMotion.keys()].sort();

  // Crux overlap
  const cruxVecs = async (d: Debate): Promise<number[][]> => {
    const texts = [...new Set((d.neutral_evaluations ?? []).flatMap(e => e.cruxes ?? [])
      .map(c => (c.description ?? '').trim()).filter(Boolean))];
    return texts.length ? computeEmbeddings(texts) : [];
  };
  const crux: Record<string, Record<string, number[]>> = {};
  const cruxCounts: Record<string, number[]> = {};
  for (const mo of motions) {
    const arms = byMotion.get(mo)!;
    if (!['a1', 'a2', 'a3', 'a4'].every(a => arms.has(a))) continue;
    const v: Record<string, number[][]> = {};
    for (const a of ['a1', 'a2', 'a3', 'a4']) v[a] = await cruxVecs(arms.get(a)!);
    cruxCounts[mo] = ['a1', 'a2', 'a3', 'a4'].map(a => v[a].length);
    for (const tau of TAUS) {
      const k = tau.toFixed(2);
      crux[k] ??= { between_a1_a3: [], within_a1_a2: [], within_a3_a4: [] };
      crux[k].between_a1_a3.push(softJaccard(v.a1, v.a3, tau));
      crux[k].within_a1_a2.push(softJaccard(v.a1, v.a2, tau));
      crux[k].within_a3_a4.push(softJaccard(v.a3, v.a4, tau));
    }
  }
  const cruxSummary = Object.fromEntries(Object.entries(crux).map(([k, o]) =>
    [k, Object.fromEntries(Object.entries(o).map(([p, xs]) => [p, { median: r3(median(xs)), per_motion: xs.map(r3) }]))]));

  // Tagged share (cited)
  const shares: Record<string, Record<string, number[]>> = {};
  let unknownIds = 0;
  for (const mo of motions) {
    for (const [arm, d] of byMotion.get(mo)!) {
      const ids = new Set((d.transcript ?? []).filter(e => e.speaker === 'skeptic')
        .flatMap(e => e.taxonomy_refs ?? []).map(r => r.node_id ?? '').filter(id => id.startsWith('skp-')));
      const known = [...ids].filter(id => tags.has(id));
      unknownIds += ids.size - known.length;
      if (known.length === 0) continue;
      shares[arm] ??= { critical: [], institutional: [], n_cited: [] };
      for (const t of ['critical', 'institutional']) {
        shares[arm][t].push(known.filter(id => tags.get(id)!.includes(t)).length / known.length);
      }
      shares[arm].n_cited.push(known.length);
    }
  }
  const shareSummary = Object.fromEntries(ARMS.filter(a => shares[a]).map(a => [a, {
    debates: shares[a].n_cited.length,
    median_cited_nodes: median(shares[a].n_cited),
    critical_share: r3(median(shares[a].critical)),
    institutional_share: r3(median(shares[a].institutional)),
  }]));

  // The corpus base rate: what an untargeted draw would give.
  const all = [...tags.values()];
  const base = {
    nodes: all.length,
    critical: r3(all.filter(t => t.includes('critical')).length / all.length),
    institutional: r3(all.filter(t => t.includes('institutional')).length / all.length),
  };

  const boost = (['critical', 'institutional'] as const).map(t => {
    const [scope, prio] = t === 'critical' ? ['a1', 'a2'] : ['a3', 'a4'];
    const s = (a: string) => shareSummary[a]?.[`${t}_share` as 'critical_share'];
    return { tag: t, a0: s('a0'), prioritize: s(prio), scope: s(scope) };
  });

  console.log(JSON.stringify({
    label: 'EXPLORATORY: post-data operationalisation of pre-registered supporting measures',
    motions_with_a1_to_a4: Object.keys(cruxCounts).length,
    crux_counts_a1_a2_a3_a4: cruxCounts,
    crux_soft_jaccard: cruxSummary,
    tagged_cited_share: shareSummary,
    corpus_base_rate: base,
    boost_check: boost,
    cited_ids_not_in_taxonomy: unknownIds,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
