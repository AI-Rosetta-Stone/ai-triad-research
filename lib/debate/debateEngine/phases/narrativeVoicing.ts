// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DebateEngineInternals } from '../internals.js';
import type { TranscriptEntry } from '../../types.js';
import { getGlobalRecorder } from '../../../flight-recorder/index.js';
import { adapterEmbedder } from '../embedTexts.js';
import { narrativeVoicingPrompt } from '../../prompts.js';
import {
  NARRATIVE_VOICING_KIND,
  parseNarrativeVoicing,
  formatNarrativeVoicingEntry,
  truncateNarrativeMaterial,
  embedNarrativeReferences,
  scoreTurnAgainstNarrative,
} from '../../narrativeVoicing.js';
import { getRelevantTaxonomyContext } from '../taxonomyContext.js';
import { resolveStageModel } from '../modelResolution.js';

// ── Phase: Opening narrative voicing (h3) ──────────────────

/**
 * Moderator retells each camp's story before the openings. No-op unless
 * `config.narrativeVoicing` is on. Idempotent on resume. A failure logs a WARN and the
 * debate proceeds without a voicing — it is an experiment, never a blocker.
 */
export async function runNarrativeVoicing(engine: DebateEngineInternals): Promise<void> {
  if (!engine.config.narrativeVoicing) return;
  engine.session.narrative_voicing_enabled = true;
  if (engine.session.narrative_voicing) return;

  const povers = engine.config.activePovers;
  if (povers.length === 0) return;

  engine.progress('opening', undefined, 'Moderator is voicing each camp\'s story');
  const model = resolveStageModel(engine, 'moderator');
  try {
    const materials = [];
    for (const p of povers) {
      const info = engine.getSoulForSpeaker(p);
      const context = await getRelevantTaxonomyContext(engine, info.pov);
      materials.push({ pov: info.pov, label: info.label, context: truncateNarrativeMaterial(context) });
    }
    const prompt = narrativeVoicingPrompt(engine.session.topic.final, materials, engine.session.topic.background || undefined);
    const text = await engine.generateWithModel(prompt, 'Narrative voicing', model);
    const narratives = parseNarrativeVoicing(text, povers);
    if (!narratives) {
      engine.warn('Narrative voicing', 'response missing one or more camps', 'Openings proceed without the moderator\'s narrative voicing');
      return;
    }

    const entry = engine.addEntry({
      type: 'system',
      speaker: 'moderator',
      content: formatNarrativeVoicingEntry(narratives),
      taxonomy_refs: [],
      metadata: { kind: NARRATIVE_VOICING_KIND },
    });
    engine.recordDiagnostic(entry.id, { prompt, raw_response: text, model });
    engine.session.narrative_voicing = { entry_id: entry.id, model, narratives };
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: engine.session?.id, message: 'Narrative voicing failed — openings proceed without it', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    engine.warn('Narrative voicing', err, 'Openings proceed without the moderator\'s narrative voicing');
  }
}

/**
 * After the openings: embed each camp's (possibly amended) narrative as its drift reference
 * and score every opening against it — the openings are the baseline.
 */
export async function finalizeNarrativeReference(engine: DebateEngineInternals): Promise<void> {
  const voicing = engine.session.narrative_voicing;
  if (!voicing) return;
  try {
    await embedNarrativeReferences(voicing.narratives, adapterEmbedder(engine.adapter, engine.session?.id));
    for (const e of engine.session.transcript) {
      if (e.type === 'opening') await updateNarrativeSimilarity(engine, e);
    }
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: engine.session?.id, message: 'Narrative reference embedding failed — narrative drift series will be absent', error: { name: (err as Error).name ?? 'Error', message: String(err) } });
  }
}

/** Score one debater turn against that debater's own camp narrative. */
export async function updateNarrativeSimilarity(engine: DebateEngineInternals, entry: TranscriptEntry): Promise<void> {
  const voicing = engine.session.narrative_voicing;
  if (!voicing) return;
  try {
    const sim = await scoreTurnAgainstNarrative(voicing.narratives, entry.speaker, entry.content, adapterEmbedder(engine.adapter, engine.session?.id));
    if (sim === null) return;
    voicing.similarity_series ??= {};
    voicing.similarity_series[entry.id] = sim;
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: engine.session?.id, message: 'Narrative similarity update failed', error: { name: (err as Error).name ?? 'Error', message: String(err) } });
  }
}
