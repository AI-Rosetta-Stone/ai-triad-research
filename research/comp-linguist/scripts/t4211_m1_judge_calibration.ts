#!/usr/bin/env npx tsx
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4211 M1: run the custodian check (lib/debate/prompts/reflectionTagCheck.ts) over every past Skeptic
 * reflection edit, as the editor will run it for an UNTAGGED seat (relation `umbrella_on_tagged` or
 * `untagged_target`). Read-only on data; writes one JSONL row per edit, and resumes from that file.
 *
 * Usage:
 *   npx tsx research/comp-linguist/scripts/t4211_m1_judge_calibration.ts \
 *     [--data <ai-triad-data root>] [--model gemini-3.5-flash-lite] [--out <results.jsonl>] [--limit N]
 *
 * The data root defaults to $AI_TRIAD_DATA_ROOT, then ../ai-triad-data next to this repo.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCLIAdapter } from '../../../lib/debate/aiAdapter.js';
import { classifyTagRelation } from '../../../lib/debate/reflectionScope.js';
import {
  buildCustodianCheckPrompt,
  parseCustodianCheckOutput,
  type CustodianCheckSoul,
} from '../../../lib/debate/prompts/reflectionTagCheck.js';
import { loadPovTagRegistry } from '../../../lib/schema/povTags.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOUL_DIR = path.join(REPO_ROOT, 'lib/debate/soul-docs');

interface StoredEdit {
  edit_type?: string;
  node_id?: string | null;
  current_label?: string;
  current_description?: string;
  proposed_label?: string;
  proposed_description?: string;
  rationale?: string;
}

interface Row {
  key: string;
  debate_id: string;
  node_id: string;
  edit_type: string;
  target_tags: string[];
  relation: string;
  custodians: string[];
  model: string;
  outcome: 'checked' | 'unchecked' | 'error';
  verdicts?: unknown;
  unchecked?: string;
  error?: string;
  raw?: string;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function dataRoot(): string {
  return arg('--data') ?? process.env.AI_TRIAD_DATA_ROOT ?? path.join(path.dirname(REPO_ROOT), 'ai-triad-data');
}

function loadSoul(id: string): CustodianCheckSoul {
  const doc = JSON.parse(fs.readFileSync(path.join(SOUL_DIR, `${id}.soul.json`), 'utf8'));
  return {
    soul: id,
    label: doc.label,
    value_hierarchy: doc.value_hierarchy ?? [],
    boundaries: { hardcoded: doc.boundaries?.hardcoded ?? [], softcoded: doc.boundaries?.softcoded ?? [] },
  };
}

function* skepticEdits(root: string): Generator<{ debateId: string; index: number; edit: StoredEdit }> {
  const dir = path.join(root, 'debates');
  for (const f of fs.readdirSync(dir).filter(n => /^debate-.*\.json$/.test(n)).sort()) {
    let d: { id?: string; transcript?: Array<{ type?: string; metadata?: { reflection_results?: Array<{ pover?: string; edits?: StoredEdit[] }> } }> };
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      console.warn(`WARN: skipping unreadable ${f}`);
      continue;
    }
    let index = 0;
    for (const entry of d.transcript ?? []) {
      if (entry.type !== 'reflection') continue;
      for (const r of entry.metadata?.reflection_results ?? []) {
        if (r.pover !== 'skeptic') continue;
        for (const edit of r.edits ?? []) yield { debateId: d.id ?? f, index: index++, edit };
      }
    }
  }
}

async function main(): Promise<number> {
  const root = dataRoot();
  const model = arg('--model') ?? 'gemini-3.5-flash-lite';
  const out = path.resolve(arg('--out') ?? 'm1-results.jsonl');
  const limit = Number(arg('--limit') ?? Infinity);

  const skp = JSON.parse(fs.readFileSync(path.join(root, 'taxonomy/Origin/skeptic.json'), 'utf8'));
  const nodes: Array<{ id: string; pov_tags?: string[] }> = Array.isArray(skp) ? skp : skp.nodes;
  const tagsById = new Map(nodes.map(n => [n.id, n.pov_tags ?? []]));
  const registry = loadPovTagRegistry().povs.skeptic ?? [];

  const done = new Set<string>();
  if (fs.existsSync(out)) {
    for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Row;
      if (row.outcome !== 'error') done.add(row.key);
    }
  }

  const adapter = createCLIAdapter(REPO_ROOT);
  const soulCache = new Map<string, CustodianCheckSoul>();
  const soul = (id: string) => soulCache.get(id) ?? soulCache.set(id, loadSoul(id)).get(id)!;
  let ran = 0;

  for (const { debateId, index, edit } of skepticEdits(root)) {
    const nodeId = edit.node_id;
    const editType = (edit.edit_type ?? 'revise').toLowerCase();
    if (!nodeId || !tagsById.has(nodeId)) continue;
    if (!['revise', 'qualify', 'deprecate'].includes(editType)) continue;
    // The live pipeline drops no-op edits before the check runs (t/3813), so they're out of M1.
    const norm = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim();
    if (editType !== 'deprecate' && norm(edit.current_label) === norm(edit.proposed_label)
      && norm(edit.current_description) === norm(edit.proposed_description)) continue;
    const key = `${debateId}#${index}`;
    if (done.has(key)) continue;
    if (ran >= limit) break;

    const targetTags = tagsById.get(nodeId)!;
    const { relation, custodians } = classifyTagRelation(null, targetTags, registry);
    const souls = custodians.map(soul);
    const base: Omit<Row, 'outcome'> = { key, debate_id: debateId, node_id: nodeId, edit_type: editType, target_tags: targetTags, relation, custodians, model };

    const prompt = buildCustodianCheckPrompt({
      editType: editType as 'revise' | 'qualify' | 'deprecate',
      currentLabel: edit.current_label ?? '',
      currentDescription: edit.current_description ?? '',
      proposedLabel: edit.proposed_label ?? '',
      proposedDescription: edit.proposed_description ?? '',
      rationale: edit.rationale ?? '',
      nodeTags: targetTags,
      seatTag: null,
      custodians: souls,
    });

    let row: Row;
    try {
      const raw = await adapter.generateText(prompt, model, { temperature: 0 });
      const parsed = parseCustodianCheckOutput(raw, souls);
      row = 'unchecked' in parsed
        ? { ...base, outcome: 'unchecked', unchecked: parsed.unchecked, raw }
        : { ...base, outcome: 'checked', verdicts: parsed.verdicts };
    } catch (e) {
      row = { ...base, outcome: 'error', error: e instanceof Error ? e.message : String(e) };
      console.warn(`WARN: ${key} failed, will retry on the next run: ${row.error.slice(0, 160)}`);
    }
    fs.appendFileSync(out, JSON.stringify(row) + '\n');
    ran++;
    if (ran % 10 === 0) console.log(`${ran} edits checked`);
  }
  console.log(`Done: ${ran} new rows in ${out}`);
  return 0;
}

main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
