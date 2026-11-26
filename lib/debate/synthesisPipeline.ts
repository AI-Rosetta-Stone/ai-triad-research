// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── Session-write map (t/1300 condition 1) ─────────────────
// Method                      → session field(s) written
// runSynthesis                → transcript[concluding], diagnostics.entries[*]
// runMissingArgumentsPass     → missing_arguments
// runTaxonomyRefinementPass   → taxonomy_suggestions  (post-debate entries merged with turn-validator hints)
// runDialecticTracePass       → dialectic_traces
// runExtractionCoverage       → diagnostics.entries[*].extraction_coverage  (via computeExtractionCoverage)
// runNeutralCheckpoint        → neutral_evaluations[], neutral_speaker_mapping, transcript[system]
// compressContext             → context_summaries[], context_rot.stages[]
// ────────────────────────────────────────────────────────────

import type { AIAdapter } from './aiAdapter.js';
import type { DebateConfig } from './debateEngine.js';
import type { DebateSession, TranscriptEntry, SpeakerId, MissingArgument } from './types.js';
import type { LoadedTaxonomy } from './taxonomyLoader.js';
import type { EntryDiagnostics } from './types.js';
import type { SpeakerMapping, NeutralEvaluation } from './neutralEvaluator.js';
import { POVER_INFO, POV_KEYS } from './types.js';
import { formatRecentTranscript, parseJsonRobust } from './helpers.js';
import { runSynthesisPhases } from './synthesisPhases.js';
import { missingArgumentsPrompt, taxonomyRefinementPrompt } from './prompts.js';
import { generateDialecticTraces } from './dialecticTrace.js';
import { computeExtractionCoverage } from './calibrationLogger.js';
import { runNeutralEvaluation, buildSpeakerMapping, resolveEvaluatorModel } from './neutralEvaluator.js';
import { buildMediumTierSummary, buildDistantTierSummary } from './tieredCompression.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { computeNodeEngagement, type EngagementTranscriptEntry } from './reflectionScope.js';
import { POV_PREFIXES } from './nodeIdUtils.js';

export interface SynthesisContext {
  session: DebateSession;
  config: DebateConfig;
  taxonomy: LoadedTaxonomy;
  adapter: AIAdapter;
  generate: (prompt: string, label: string, timeoutMs?: number) => Promise<string>;
  generateWithEvaluator: (prompt: string, label: string) => Promise<string>;
  addEntry: (entry: Omit<TranscriptEntry, 'id' | 'timestamp'>) => TranscriptEntry;
  recordDiagnostic: (entryId: string, data: Partial<EntryDiagnostics>) => void;
  progress: (phase: string, speaker?: string, message?: string) => void;
  warn: (operation: string, error: unknown, recovery: string) => void;
  checkAborted: () => void;
}

export class SynthesisPipeline {
  private ctx: SynthesisContext;
  private _neutralMapping: SpeakerMapping | null = null;

  constructor(ctx: SynthesisContext) {
    this.ctx = ctx;
  }

  async runSynthesis(maxPhase?: number): Promise<void> {
    this.ctx.progress('concluding', undefined, 'Generating synthesis');

    const fullTranscript = formatRecentTranscript(this.ctx.session.transcript, 50, this.ctx.session.context_summaries);

    const policyLines = this.ctx.taxonomy.policyRegistry.length > 0
      ? this.ctx.taxonomy.policyRegistry.slice(0, 10).map(p => `${p.id}: ${p.action}`)
      : undefined;

    const result = await runSynthesisPhases(
      {
        topic: this.ctx.session.topic.final,
        transcript: fullTranscript,
        audience: this.ctx.config.audience,
        cruxTracker: this.ctx.session.crux_tracker,
        policyLines,
        hasSourceDoc: this.ctx.config.sourceType === 'document' || this.ctx.config.sourceType === 'url',
        debateId: this.ctx.session.id,
      },
      (prompt, label) => this.ctx.generate(prompt, label),
      (_phase, label) => this.ctx.progress('concluding', undefined, label),
      (context, problem, nextStep) => this.ctx.warn(context, problem, nextStep),
      () => this.ctx.checkAborted(),
      maxPhase,
      this.ctx.config.usageDeps,
    );

    // t/769: lists in relevance order before anything is built from them (the card shows the top 3).
    // t/775: runSynthesisPhases already returns normalised, relevance-ordered lists.
    const concludingData = result.data;
    const elapsed = result.elapsed_ms;

    // Format readable content
    const lines: string[] = [];

    const topicRes = concludingData.topic_resolution as { restated_question?: string; where_it_landed?: string; what_would_resolve_it?: string } | undefined;
    if (topicRes?.restated_question) {
      lines.push(`**${topicRes.restated_question}**`);
      lines.push('');
      if (topicRes.where_it_landed) {
        lines.push(topicRes.where_it_landed);
        lines.push('');
      }
      if (topicRes.what_would_resolve_it) {
        lines.push(`*Decisive crux: ${topicRes.what_would_resolve_it}*`);
        lines.push('');
      }
    }

    const agreements = concludingData.areas_of_agreement as { point: string; povers: string[] }[] | undefined;
    const disagreements = concludingData.areas_of_disagreement as { point: string; positions: { pover: string; stance: string }[] }[] | undefined;
    const cruxes = concludingData.cruxes as { question: string; type?: string }[] | undefined;

    if (agreements?.length) {
      lines.push('**Areas of Agreement:**');
      lines.push('');
      for (const a of agreements) {
        const povers = (a.povers ?? []).map(p => POVER_INFO[p as Exclude<SpeakerId, 'user'>]?.label ?? p).join(', ');
        lines.push(`- ${a.point} (${povers})`);
      }
      lines.push('');
    }
    if (disagreements?.length) {
      lines.push('**Areas of Disagreement:**');
      lines.push('');
      for (const d of disagreements) {
        const bdiTag = (d as Record<string, unknown>).bdi_layer ? ` [${(d as Record<string, unknown>).bdi_layer}]` : '';
        const typeTag = (d as Record<string, unknown>).type ? ` {${(d as Record<string, unknown>).type}}` : '';
        lines.push(`- ${d.point}${typeTag}${bdiTag}`);
        for (const pos of d.positions ?? []) {
          const label = POVER_INFO[pos.pover as Exclude<SpeakerId, 'user'>]?.label ?? pos.pover;
          lines.push(`    - ${label}: ${pos.stance}`);
        }
        const resolvability = (d as Record<string, unknown>).resolvability;
        if (typeof resolvability === 'string' && resolvability) {
          lines.push(`    - *Resolution path: ${resolvability.replace(/_/g, ' ')}*`);
        }
      }
      lines.push('');
    }
    if (cruxes?.length) {
      lines.push('**Cruxes:**');
      lines.push('');
      for (const c of cruxes) {
        const crux = c as { question: string; if_yes?: string; if_no?: string; type?: string };
        lines.push(`- ${crux.question}${crux.type ? ` [${crux.type}]` : ''}`);
        if (crux.if_yes) lines.push(`    - If yes, weakens: ${crux.if_yes}`);
        if (crux.if_no) lines.push(`    - If no, weakens: ${crux.if_no}`);
      }
      lines.push('');
    }

    const unresolvedQuestions = concludingData.unresolved_questions as string[] | undefined;
    if (unresolvedQuestions?.length) {
      lines.push('**Unresolved Questions:**');
      lines.push('');
      for (const q of unresolvedQuestions) lines.push(`- ${q}`);
      lines.push('');
    }

    const preferences = concludingData.preferences as { conflict: string; prevails: string; criterion: string; rationale: string; what_would_change_this?: string }[] | undefined;
    if (preferences?.length) {
      lines.push('**Resolution Analysis:**');
      lines.push('');
      for (const p of preferences) {
        if (p.prevails === 'undecidable') {
          lines.push(`- **${p.conflict}** — Undecidable`);
        } else {
          lines.push(`- **${p.conflict}** — Stronger: ${p.prevails} (${p.criterion?.replace(/_/g, ' ')})`);
        }
        lines.push(`    - *${p.rationale}*`);
        if (p.what_would_change_this) {
          lines.push(`    - Would change if: ${p.what_would_change_this}`);
        }
      }
      lines.push('');
    }

    let content: string;
    if (lines.length > 0) {
      content = lines.join('\n');
    } else if (typeof concludingData.summary === 'string') {
      content = concludingData.summary;
    } else {
      content = JSON.stringify(concludingData, null, 2);
    }

    const entry = this.ctx.addEntry({
      type: 'concluding',
      speaker: 'system',
      content,
      taxonomy_refs: [],
      metadata: { synthesis: concludingData },
    });

    this.ctx.recordDiagnostic(entry.id, {
      raw_response: JSON.stringify(result.rawResponses),
      model: this.ctx.config.model,
      response_time_ms: elapsed,
    });
  }

  async runMissingArgumentsPass(): Promise<void> {
    try {
      const synthEntry = this.ctx.session.transcript.find(e => e.type === 'concluding');
      const concludingText = synthEntry?.content ?? '';
      if (!concludingText) return;

      const summaryLines: string[] = [];
      for (const povKey of POV_KEYS) {
        const povData = this.ctx.taxonomy[povKey];
        if (!povData?.nodes) continue;
        for (const node of povData.nodes) {
          const cat = node.category ?? 'unknown';
          summaryLines.push(`[${node.id}] ${node.label} (${cat}) — ${povKey}`);
        }
      }
      const taxonomySummary = summaryLines.slice(0, 80).join('\n');

      const prompt = missingArgumentsPrompt(
        this.ctx.session.topic.final,
        taxonomySummary,
        concludingText.slice(0, 4000),
        this.ctx.config.audience,
      );

      const text = await this.ctx.generate(prompt, 'Missing arguments pass', 180_000);
      const parsed = parseJsonRobust(text) as { missing_arguments?: MissingArgument[] };
      if (parsed.missing_arguments && Array.isArray(parsed.missing_arguments)) {
        this.ctx.session.missing_arguments = parsed.missing_arguments.slice(0, 5);
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Missing arguments pass failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      this.ctx.warn('Missing arguments pass', err, 'Non-critical — debate results unaffected');
    }
  }

  async runTaxonomyRefinementPass(): Promise<void> {
    try {
      const synthEntry = this.ctx.session.transcript.find(e => e.type === 'concluding');
      const concludingText = synthEntry?.content ?? '';
      if (!concludingText) return;

      const refIds = new Set<string>();
      for (const entry of this.ctx.session.transcript) {
        for (const ref of entry.taxonomy_refs ?? []) {
          refIds.add(ref.node_id);
        }
      }
      if (refIds.size === 0) return;

      const referencedNodes: { id: string; label: string; pov: string; category: string; description: string }[] = [];
      for (const povKey of POV_KEYS) {
        const povData = this.ctx.taxonomy[povKey];
        if (!povData?.nodes) continue;
        for (const node of povData.nodes) {
          if (refIds.has(node.id)) {
            referencedNodes.push({
              id: node.id,
              label: node.label,
              pov: povKey,
              category: node.category ?? 'unknown',
              description: node.description,
            });
          }
        }
      }
      if (referencedNodes.length === 0) return;

      // Rank by engagement before the 25-node cap (t/3512): the cap used to keep whatever the POV
      // files listed first, so a node cited 5x and attacked could be cut while an incidental one
      // survived. Nodes the debate actually tested now come first.
      const refEngagement = new Map<string, number>();
      for (const povPrefix of Object.keys(POV_PREFIXES)) {
        for (const e of computeNodeEngagement({
          transcript: this.ctx.session.transcript as unknown as EngagementTranscriptEntry[],
          anNodes: this.ctx.session.argument_network?.nodes ?? [],
          anEdges: this.ctx.session.argument_network?.edges ?? [],
        }, povPrefix)) {
          refEngagement.set(e.nodeId, e.score);
        }
      }
      referencedNodes.sort((a, b) => (refEngagement.get(b.id) ?? 0) - (refEngagement.get(a.id) ?? 0) || a.id.localeCompare(b.id));

      const an = this.ctx.session.argument_network;
      let anSummary = '(no argument network)';
      if (an && an.nodes.length > 0) {
        const lines = an.nodes.slice(0, 30).map(n => {
          const attacks = an.edges.filter(e => e.target === n.id && e.type === 'attacks');
          const supports = an.edges.filter(e => e.target === n.id && e.type === 'supports');
          let line = `${n.id} (${n.speaker}): "${n.text}"`;
          if (attacks.length) line += ` [attacked ${attacks.length}x]`;
          if (supports.length) line += ` [supported ${supports.length}x]`;
          return line;
        });
        anSummary = lines.join('\n');
      }

      const prompt = taxonomyRefinementPrompt(
        this.ctx.session.topic.final,
        concludingText.slice(0, 4000),
        referencedNodes.slice(0, 25),
        anSummary,
        this.ctx.config.audience,
      );

      const text = await this.ctx.generate(prompt, 'Taxonomy refinement pass', 180_000);
      const parsed = parseJsonRobust(text) as { taxonomy_suggestions?: unknown[] };
      if (parsed.taxonomy_suggestions && Array.isArray(parsed.taxonomy_suggestions)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const postDebate = parsed.taxonomy_suggestions.slice(0, 10).map((s: any) => ({
          ...s,
          source: 'post-debate' as const,
        }));
        const existing = this.ctx.session.taxonomy_suggestions ?? [];
        const turnValidator = existing.filter(s => s.source === 'turn-validator');
        this.ctx.session.taxonomy_suggestions = [...postDebate, ...turnValidator];
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Taxonomy refinement pass failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      this.ctx.warn('Taxonomy refinement pass', err, 'Non-critical — debate results unaffected');
    }
  }

  runDialecticTracePass(): void {
    try {
      const traces = generateDialecticTraces(this.ctx.session);
      if (traces.length > 0) {
        this.ctx.session.dialectic_traces = traces;
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Dialectic trace pass failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      this.ctx.warn('Dialectic trace pass', err, 'Non-critical — debate results unaffected');
    }
  }

  async runExtractionCoverage(): Promise<void> {
    try {
      const coverageGenFn = (prompt: string) => this.ctx.generateWithEvaluator(prompt, 'Extraction coverage');
      await computeExtractionCoverage(this.ctx.session, coverageGenFn);

      const recorder = getGlobalRecorder();
      if (!recorder || !this.ctx.session.diagnostics?.entries) return;

      for (const [entryId, entryDiag] of Object.entries(this.ctx.session.diagnostics.entries)) {
        const ec = (entryDiag as Record<string, unknown>).extraction_coverage as { coverage_rate: number } | undefined;
        if (ec && ec.coverage_rate < 0.70) {
          recorder.record({
            type: 'an.extraction_coverage_low',
            component: 'calibration',
            level: 'warn',
            debate_id: this.ctx.session.id,
            turn_id: entryId,
            message: `Extraction coverage ${Math.round(ec.coverage_rate * 100)}% < 70% threshold`,
            data: { coverage_rate: ec.coverage_rate },
          });
        }
      }
      const coverageSamples = Object.values(this.ctx.session.diagnostics.entries)
        .map(d => (d as Record<string, unknown>).extraction_coverage as { coverage_rate: number } | undefined)
        .filter((c): c is { coverage_rate: number } => c != null)
        .map(c => c.coverage_rate);
      if (coverageSamples.length > 0) {
        const aggCoverage = coverageSamples.reduce((a, b) => a + b, 0) / coverageSamples.length;
        if (aggCoverage < 0.70) {
          recorder.record({
            type: 'an.extraction_coverage_error',
            component: 'calibration',
            level: 'error',
            debate_id: this.ctx.session.id,
            message: `Debate-level extraction coverage ${Math.round(aggCoverage * 100)}% < 70% threshold`,
            data: { aggregate_coverage_rate: aggCoverage, samples: coverageSamples.length },
          });
        }
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Coverage computation failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
  }

  async runNeutralCheckpoint(checkpoint: 'baseline' | 'midpoint' | 'final'): Promise<NeutralEvaluation | null> {
    try {
      this.ctx.progress('evaluation', undefined, `Neutral evaluation: ${checkpoint}`);

      if (!this._neutralMapping) {
        this._neutralMapping = buildSpeakerMapping(
          this.ctx.config.activePovers as Exclude<SpeakerId, 'user'>[],
        );
        this.ctx.session.neutral_speaker_mapping = this._neutralMapping;
      }

      // Pinned evaluator (t/1846): never the debate's own model — crux metrics are
      // evaluator-model-relative, so the evaluator is a recorded calibration invariant.
      // Experimental probes may override via config; whatever runs gets stamped.
      const evaluatorModel = resolveEvaluatorModel(
        (this.ctx.config as { evaluatorModelOverride?: string }).evaluatorModelOverride,
      );
      this.ctx.session.evaluator_model_id = evaluatorModel;

      const evaluation = await runNeutralEvaluation(checkpoint, {
        adapter: this.ctx.adapter,
        topic: this.ctx.session.topic.final || this.ctx.session.topic.original,
        transcript: this.ctx.session.transcript,
        contextSummaries: this.ctx.session.context_summaries,
        activePovers: this.ctx.config.activePovers,
        model: evaluatorModel,
        speakerMapping: this._neutralMapping,
      });

      if (!this.ctx.session.neutral_evaluations) {
        this.ctx.session.neutral_evaluations = [];
      }
      this.ctx.session.neutral_evaluations.push(evaluation);

      const cruxCount = evaluation.cruxes?.length ?? 0;
      const claimCount = evaluation.claims?.length ?? 0;
      const rawNotes = evaluation.overall_assessment?.notes ?? '';
      let notes = rawNotes;
      if (this._neutralMapping) {
        for (const [label, povId] of Object.entries(this._neutralMapping.reverse)) {
          const displayName = POVER_INFO[povId as Exclude<SpeakerId, 'user'>]?.label ?? povId;
          notes = notes.replaceAll(label, displayName);
        }
      }
      const evalEntry = this.ctx.addEntry({
        type: 'system',
        speaker: 'system',
        content: `[Neutral evaluation: ${checkpoint}] ${cruxCount} cruxes, ${claimCount} claims evaluated. ${notes}`,
        taxonomy_refs: [],
        metadata: { neutral_checkpoint: checkpoint },
      });
      this.ctx.recordDiagnostic(evalEntry.id, {
        prompt: evaluation.diagnostics_prompt,
        raw_response: evaluation.diagnostics_raw_response,
        model: this.ctx.config.model,
        response_time_ms: evaluation.diagnostics_response_time_ms,
      });

      return evaluation;
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'ai.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: `Neutral evaluation (${checkpoint}) failed`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.ctx.warn('Neutral evaluation', `Neutral evaluation (${checkpoint}) failed: ${errorMsg}`, 'Debate continues without neutral assessment');
      return null;
    }
  }

  async compressContext(): Promise<void> {
    const keepRecent = 8;
    const keepMedium = 8;
    const filteredEntries = this.ctx.session.transcript.filter(e => e.type !== 'system');
    if (filteredEntries.length < 12) return;

    const lastSummaryIdx = this.ctx.session.context_summaries.length > 0
      ? this.ctx.session.transcript.findIndex(e => e.id === this.ctx.session.context_summaries[this.ctx.session.context_summaries.length - 1].up_to_entry_id)
      : -1;

    const compressibleStart = lastSummaryIdx + 1;
    const compressibleEnd = this.ctx.session.transcript.length - keepRecent;
    if (compressibleEnd <= compressibleStart + 3) return;

    const toCompress = this.ctx.session.transcript.slice(compressibleStart, compressibleEnd);
    if (toCompress.length < 4) return;

    this.ctx.progress('compression', undefined, 'Compressing debate history');

    const an = this.ctx.session.argument_network;

    const mediumEntries = toCompress.slice(-keepMedium);
    const distantEntries = toCompress.slice(0, -keepMedium);

    if (mediumEntries.length > 0 && an) {
      const mediumSummary = buildMediumTierSummary(
        mediumEntries, an.nodes, an.edges, this.ctx.session.commitments ?? {},
      );
      this.ctx.session.context_summaries.push({
        up_to_entry_id: mediumEntries[mediumEntries.length - 1].id,
        summary: mediumSummary,
        tier: 'medium',
      });
    }

    if (distantEntries.length >= 4 && an) {
      const distantSummary = buildDistantTierSummary(
        an.nodes, an.edges, this.ctx.session.commitments ?? {}, this.ctx.session.crux_tracker,
        this.ctx.session.unanswered_claims_ledger, distantEntries,
      );

      this.ctx.session.context_summaries.push({
        up_to_entry_id: distantEntries[distantEntries.length - 1].id,
        summary: distantSummary,
        tier: 'distant',
      });

      const inChars = distantEntries.reduce((s, e) => s + (typeof e.content === 'string' ? e.content.length : 0), 0);
      const outChars = distantSummary.length;
      if (this.ctx.session.context_rot) {
        this.ctx.session.context_rot.stages.push({
          stage: 'transcript_compression',
          in_units: 'chars', in_count: inChars,
          out_units: 'chars', out_count: outChars,
          ratio: inChars > 0 ? Math.round((outChars / inChars) * 10000) / 10000 : 1,
          flags: {
            entries_compressed: distantEntries.length,
            compression_ratio: inChars > 0 ? Math.round((outChars / inChars) * 10000) / 10000 : 1,
            window_size: keepRecent,
            tier: 'distant',
            method: 'structural',
          },
        });
      }
    } else if (toCompress.length >= 4 && an) {
      const summary = buildDistantTierSummary(
        an.nodes, an.edges, this.ctx.session.commitments ?? {}, this.ctx.session.crux_tracker,
        this.ctx.session.unanswered_claims_ledger, toCompress,
      );

      this.ctx.session.context_summaries.push({
        up_to_entry_id: toCompress[toCompress.length - 1].id,
        summary,
        tier: 'distant',
      });

      const inChars = toCompress.reduce((s, e) => s + (typeof e.content === 'string' ? e.content.length : 0), 0);
      const outChars = summary.length;
      if (this.ctx.session.context_rot) {
        this.ctx.session.context_rot.stages.push({
          stage: 'transcript_compression',
          in_units: 'chars', in_count: inChars,
          out_units: 'chars', out_count: outChars,
          ratio: inChars > 0 ? Math.round((outChars / inChars) * 10000) / 10000 : 1,
          flags: {
            entries_compressed: toCompress.length,
            compression_ratio: inChars > 0 ? Math.round((outChars / inChars) * 10000) / 10000 : 1,
            window_size: keepRecent,
            method: 'structural',
          },
        });
      }
    }
  }
}
