// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DebateConfig } from './debateEngine.js';
import type { AIAdapter, ExtendedAIAdapter } from './aiAdapter.js';
import type { LoadedTaxonomy } from './taxonomyLoader.js';
import type {
  DebateSession,
  TranscriptEntry,
  EntryDiagnostics,
  TopicScope,
  TopicScopeRiskLevel,
} from './types.js';
import type { Category } from './taxonomyTypes.js';
import type { SourceEvidenceIndex } from './evidenceFromSummaries.js';
import {
  computeStructuralScore,
  critiqueTopicPrompt,
  formatStructuralContext,
  formatLineageContext,
  parseTopicCritique,
  computeLineageDistribution,
} from './topicCritique.js';
import type { LineageFrameEntry } from './topicCritique.js';
import {
  clarificationPrompt,
  documentClarificationPrompt,
  situationClarificationPrompt,
  concludingPrompt,
  decomposeResolutionPrompt,
  topicScopeExtractionPrompt,
} from './prompts.js';
import { parseJsonRobust } from './helpers.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';

// ── Context interface (engine infrastructure) ───────────────

export interface TopicPipelineContext {
  session: DebateSession;
  config: DebateConfig;
  adapter: AIAdapter | ExtendedAIAdapter;
  taxonomy: LoadedTaxonomy;
  sourceEvidenceIndex?: SourceEvidenceIndex;

  generate(prompt: string, label: string): Promise<string>;
  generateViaUsage(usageId: string, prompt: string, label: string): Promise<string>;
  generateWithModel(prompt: string, label: string, model: string): Promise<string>;
  resolveStageModel(key: string): string;
  addEntry(entry: Omit<TranscriptEntry, 'id' | 'timestamp'>): TranscriptEntry;
  recordDiagnostic(entryId: string, data: Partial<EntryDiagnostics>): void;
  progress(phase: string, speaker?: string, message?: string): void;
  warn(operation: string, error: unknown, recovery: string): void;
}

// ── Session fields written by this cluster ───────────────────
// session.topic.critique      — runTopicCritique
// session.topic.refined       — runTopicCritique (reframe), runClarification
// session.topic.final         — runTopicCritique (reframe), runClarification
// session.topic.scope         — extractTopicScope
// session.topic.clauses       — decomposeResolutionIntoClauses
// session.topic.embedding     — embedResolutionAnchors
// session.topic.clause_embeddings — embedResolutionAnchors
// session.phase               — runClarification

export class TopicPipeline {
  constructor(private readonly ctx: TopicPipelineContext) {}

  // ── Phase: Topic Critique ──────────────────────────────────

  async runTopicCritique(): Promise<void> {
    if (this.ctx.session.topic.critique) return;

    this.ctx.progress('setup', undefined, 'Evaluating topic quality');

    try {
      const adapter = this.ctx.adapter;
      let topicEmbedding: number[] | undefined;
      if ((adapter as ExtendedAIAdapter).computeQueryEmbedding) {
        try {
          const { vector } = await (adapter as ExtendedAIAdapter).computeQueryEmbedding!(this.ctx.session.topic.final);
          topicEmbedding = vector;
        } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Topic embedding for structural scoring failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); }
      }

      const povNodes: { id: string; pov: string; category: Category }[] = [];
      for (const pov of ['accelerationist', 'safetyist', 'skeptic'] as const) {
        for (const node of this.ctx.taxonomy[pov]?.nodes ?? []) {
          povNodes.push({ id: node.id, pov, category: node.category });
        }
      }

      let structuralScore;
      if (topicEmbedding && topicEmbedding.length > 0) {
        structuralScore = computeStructuralScore({
          topicEmbedding,
          povNodes,
          situationNodes: this.ctx.taxonomy.situations?.nodes ?? [],
          embeddings: this.ctx.taxonomy.embeddings,
          evidenceIndex: this.ctx.sourceEvidenceIndex ?? undefined,
        });
      } else {
        structuralScore = computeStructuralScore({
          topicEmbedding: [],
          povNodes,
          situationNodes: this.ctx.taxonomy.situations?.nodes ?? [],
          embeddings: {},
        });
      }

      let lineageFrame: LineageFrameEntry[] = [];
      const lc = this.ctx.taxonomy.lineageCategories;
      if (lc && structuralScore.activated_nodes.length > 0) {
        const lineageByNode: Record<string, string[]> = {};
        for (const pov of ['accelerationist', 'safetyist', 'skeptic'] as const) {
          for (const node of this.ctx.taxonomy[pov]?.nodes ?? []) {
            const ga = (node as { graph_attributes?: { intellectual_lineage?: (string | { name: string })[] } }).graph_attributes;
            const lineage = ga?.intellectual_lineage;
            if (lineage && lineage.length > 0) {
              lineageByNode[node.id] = lineage.map(v => typeof v === 'string' ? v : v.name);
            }
          }
        }

        const nameToCluster: Record<string, string> = {};
        for (const [name, val] of Object.entries(lc.mapping)) {
          nameToCluster[name] = val.l2;
        }
        const clusterLabels: Record<string, string> = {};
        for (const cat of lc.level2_categories) {
          clusterLabels[cat.id] = cat.label;
        }

        lineageFrame = computeLineageDistribution({
          activatedNodeIds: structuralScore.activated_nodes.map(n => n.id),
          lineageByNode,
          nameToCluster,
          clusterLabels,
        });
      }

      let structuralContext = formatStructuralContext(structuralScore);
      if (lineageFrame.length > 0) {
        structuralContext += '\n' + formatLineageContext(lineageFrame);
      }
      const prompt = critiqueTopicPrompt(this.ctx.session.topic.final, structuralContext, this.ctx.session.audience);
      const text = await this.ctx.generateViaUsage('debate.topic-critique', prompt, 'Topic critique');
      const critique = parseTopicCritique(text, structuralScore);

      if (lineageFrame.length > 0) {
        critique.lineage_frame = lineageFrame;
      }

      this.ctx.session.topic.critique = critique;
      this.ctx.progress('setup', undefined, `Topic quality: ${critique.rating} (${critique.composite_score}/20)`);

      const threshold = this.ctx.config.wisdomReframeThreshold ?? 10;
      const autoReframe = this.ctx.config.wisdomAutoReframe !== false;

      if (critique.composite_score < threshold && critique.rewritten_topic) {
        // For inquiry debates (t/284): store the suggestion separately, don't apply it
        if (this.ctx.config.anchorToResolution) {
          this.ctx.session.topic.critique_suggestion = critique.rewritten_topic;
          this.ctx.addEntry({
            type: 'system', speaker: 'system',
            content: `Topic wisdom score: ${critique.composite_score}/20 (below ${threshold}). Rewrite suggestion stored (not applied — inquiry debates keep user question).`,
            taxonomy_refs: [], metadata: {},
          });
        } else if (autoReframe) {
          // For normal debates: apply the reframe as before
          this.ctx.progress('setup', undefined, 'Reframing topic for productive disagreement');

          this.ctx.session.topic.refined = this.ctx.session.topic.final;
          this.ctx.session.topic.final = critique.rewritten_topic;
          critique.reframe_applied = true;

          if (topicEmbedding && (adapter as ExtendedAIAdapter).computeQueryEmbedding) {
            try {
              const { vector: reframedEmbedding } = await (adapter as ExtendedAIAdapter).computeQueryEmbedding!(critique.rewritten_topic);
              const reframedStructural = computeStructuralScore({
                topicEmbedding: reframedEmbedding,
                povNodes,
                situationNodes: this.ctx.taxonomy.situations?.nodes ?? [],
                embeddings: this.ctx.taxonomy.embeddings,
                evidenceIndex: this.ctx.sourceEvidenceIndex ?? undefined,
              });
              if (reframedStructural.total < structuralScore.total) {
                this.ctx.session.topic.final = this.ctx.session.topic.refined!;
                this.ctx.session.topic.refined = null;
                critique.reframe_applied = false;
                critique.reframe_changes = 'Reverted: structural score regressed after reframing';
                this.ctx.addEntry({
                  type: 'system', speaker: 'system',
                  content: `Topic wisdom score: ${critique.composite_score}/20 (below ${threshold}). Reframing reverted: structural score regressed (${reframedStructural.total} < ${structuralScore.total}).`,
                  taxonomy_refs: [], metadata: {},
                });
              } else {
                critique.reframe_changes = `Reframed topic applied (structural: ${structuralScore.total} → ${reframedStructural.total})`;
                this.ctx.addEntry({
                  type: 'system', speaker: 'system',
                  content: `Topic wisdom score: ${critique.composite_score}/20 (below ${threshold}). Reframed: ${critique.reframe_changes}`,
                  taxonomy_refs: [], metadata: {},
                });
              }
            } catch (err) {
              getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Topic re-score after reframe failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
              critique.reframe_changes = 'Reframed topic applied (post-reframe re-score unavailable)';
              this.ctx.addEntry({
                type: 'system', speaker: 'system',
                content: `Topic wisdom score: ${critique.composite_score}/20 (below ${threshold}). Reframed (re-score skipped).`,
                taxonomy_refs: [], metadata: {},
              });
            }
          } else {
            critique.reframe_changes = 'Reframed topic applied (no embedding available for re-score)';
            this.ctx.addEntry({
              type: 'system', speaker: 'system',
              content: `Topic wisdom score: ${critique.composite_score}/20 (below ${threshold}). Reframed (no re-score).`,
              taxonomy_refs: [], metadata: {},
            });
          }

          this.ctx.progress('setup', undefined, `Topic reframed: ${critique.reframe_changes}`);
        } else if (critique.composite_score < threshold && !autoReframe) {
          this.ctx.addEntry({
            type: 'system', speaker: 'system',
            content: `Topic wisdom score: ${critique.composite_score}/20 (below ${threshold}). Auto-reframe disabled — topic unchanged.`,
            taxonomy_refs: [], metadata: {},
          });
        }
      } else {
        const exploratoryNote = critique.exploratory ? ' [exploratory — low evidence coverage]' : '';
        this.ctx.addEntry({
          type: 'system', speaker: 'system',
          content: `Topic wisdom score: ${critique.composite_score}/20. No reframing needed.${exploratoryNote}`,
          taxonomy_refs: [], metadata: {},
        });
      }
        this.ctx.addEntry({
          type: 'system', speaker: 'system',
          content: `Topic wisdom score: ${critique.composite_score}/20. No reframing needed.${exploratoryNote}`,
          taxonomy_refs: [], metadata: {},
        });
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Topic critique failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      this.ctx.warn('Topic critique', err, 'Topic quality evaluation skipped — does not affect debate flow');
    }
  }

  // ── Phase: Topic Scope Extraction (t/336) ──────────────────

  async extractTopicScope(): Promise<void> {
    if (this.ctx.session.topic.scope) return;

    this.ctx.progress('setup', undefined, 'Extracting topic scope');

    try {
      const scopeAdditions = this.ctx.session.topic.critique?.scope_additions;
      const prompt = topicScopeExtractionPrompt(this.ctx.session.topic.final, scopeAdditions);
      const scopeModel = this.ctx.resolveStageModel('scope');
      const text = await this.ctx.generateWithModel(prompt, 'Topic scope extraction', scopeModel);
      const parsed = parseJsonRobust(text) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object') {
        this.ctx.warn('Topic scope extraction', 'LLM returned unparseable response', 'Scope extraction skipped — debate continues without scope enforcement');
        return;
      }

      const validRiskLevels: TopicScopeRiskLevel[] = ['low', 'medium', 'high', 'catastrophic', 'unspecified'];
      const riskLevel = validRiskLevels.includes(parsed.risk_level as TopicScopeRiskLevel)
        ? parsed.risk_level as TopicScopeRiskLevel
        : 'unspecified';

      const toStringArray = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

      // Demanded content arrays — the prompt explicitly asks for non-empty values.
      // A non-array (absent/null/wrong-type) is an extraction failure silently coerced
      // to [] by toStringArray; per-field WARNs make this visible in the flight recorder
      // so it can be distinguished from a genuinely sparse but correctly-shaped response.
      const demandedArray = (field: string, v: unknown): string[] => {
        if (!Array.isArray(v)) {
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'debate-engine', level: 'warn',
            debate_id: this.ctx.session?.id,
            message: `Topic scope field absent or wrong type — coerced to []`,
            data: { field, rawType: v === null ? 'null' : typeof v },
          });
          return [];
        }
        return v.filter((s): s is string => typeof s === 'string');
      };

      const scope: TopicScope = {
        core_proposition: typeof parsed.core_proposition === 'string' ? parsed.core_proposition : this.ctx.session.topic.final,
        relevant_disciplines: demandedArray('relevant_disciplines', parsed.relevant_disciplines),
        on_scope_evidence: demandedArray('on_scope_evidence', parsed.on_scope_evidence),
        key_tensions: demandedArray('key_tensions', parsed.key_tensions),
        off_scope_topics: demandedArray('off_scope_topics', parsed.off_scope_topics),
        drift_signatures: demandedArray('drift_signatures', parsed.drift_signatures),
        example_ceiling: typeof parsed.example_ceiling === 'string' ? parsed.example_ceiling : '',
        risk_level: riskLevel,
        domain: typeof parsed.domain === 'string' ? parsed.domain : '',
        product_type: typeof parsed.product_type === 'string' ? parsed.product_type : null,
        time_horizon: typeof parsed.time_horizon === 'string' ? parsed.time_horizon : null,
        excluded_scenarios: toStringArray(parsed.excluded_scenarios),
        explicit_qualifiers: toStringArray(parsed.explicit_qualifiers),
        constraint_confidence: parsed.constraint_confidence === 'explicit' ? 'explicit' : 'inferred',
      };

      if (scope.off_scope_topics.length < 3 || scope.drift_signatures.length < 2 || scope.relevant_disciplines.length === 0) {
        this.ctx.warn('Topic scope extraction', `Sparse output: ${scope.off_scope_topics.length} off_scope_topics, ${scope.drift_signatures.length} drift_signatures, ${scope.relevant_disciplines.length} disciplines`, 'Scope stored but enforcement may be weak');
      }

      this.ctx.session.topic.scope = scope;
      this.ctx.progress('setup', undefined, `Topic scope extracted (${scope.constraint_confidence}, ${scope.off_scope_topics.length} off-scope, ${scope.drift_signatures.length} drift sigs)`);
      getGlobalRecorder()?.record({
        type: 'topic_scope_extracted', component: 'debate-engine', level: 'info',
        message: `Topic scope extracted (${scope.constraint_confidence})`,
        data: {
          core_proposition: scope.core_proposition,
          risk_level: scope.risk_level,
          off_scope_count: scope.off_scope_topics.length,
          drift_sig_count: scope.drift_signatures.length,
          constraint_confidence: scope.constraint_confidence,
        },
      });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'topic_scope_extraction_failed', component: 'debate-engine', level: 'warn',
        debate_id: this.ctx.session?.id,
        message: `Topic scope extraction failed: ${err instanceof Error ? err.message : String(err)}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      this.ctx.warn('Topic scope extraction', err, 'Scope extraction skipped — debate continues without scope enforcement');
    }
  }

  // ── Lineage context for topic framing ────────────────────

  private buildLineageContext(): string | undefined {
    const lineageFrame = this.ctx.session.topic.critique?.lineage_frame;
    if (lineageFrame && lineageFrame.length > 0) {
      return formatLineageContext(lineageFrame);
    }

    const lc = this.ctx.taxonomy.lineageCategories;
    if (!lc) return undefined;

    const allNodeIds: string[] = [];
    const lineageByNode: Record<string, string[]> = {};
    for (const pov of ['accelerationist', 'safetyist', 'skeptic'] as const) {
      for (const node of this.ctx.taxonomy[pov]?.nodes ?? []) {
        allNodeIds.push(node.id);
        const ga = (node as { graph_attributes?: { intellectual_lineage?: (string | { name: string })[] } }).graph_attributes;
        const lineage = ga?.intellectual_lineage;
        if (lineage && lineage.length > 0) {
          lineageByNode[node.id] = lineage.map(v => typeof v === 'string' ? v : v.name);
        }
      }
    }

    const nameToCluster: Record<string, string> = {};
    for (const [name, val] of Object.entries(lc.mapping)) {
      nameToCluster[name] = val.l2;
    }
    const clusterLabels: Record<string, string> = {};
    for (const cat of lc.level2_categories) {
      clusterLabels[cat.id] = cat.label;
    }

    const frame = computeLineageDistribution({
      activatedNodeIds: allNodeIds,
      lineageByNode,
      nameToCluster,
      clusterLabels,
    });
    if (frame.length === 0) return undefined;
    return formatLineageContext(frame);
  }

  // ── Phase: Clarification ───────────────────────────────────

  async runClarification(): Promise<void> {
    this.ctx.progress('clarification', undefined, 'Generating clarifying questions');
    this.ctx.session.phase = 'clarification';

    const lineageCtx = this.buildLineageContext();

    let prompt: string;
    if (this.ctx.config.sourceType === 'document' || this.ctx.config.sourceType === 'url') {
      prompt = documentClarificationPrompt(this.ctx.config.topic, this.ctx.config.sourceContent ?? '', this.ctx.config.audience, lineageCtx);
    } else if (this.ctx.config.sourceType === 'situations') {
      prompt = situationClarificationPrompt(this.ctx.config.topic, this.ctx.config.sourceContent ?? '', this.ctx.config.audience, lineageCtx);
    } else {
      prompt = clarificationPrompt(this.ctx.config.topic, this.ctx.config.sourceContent, this.ctx.config.audience, lineageCtx);
    }

    const text = await this.ctx.generateViaUsage('debate.clarification-questions', prompt, 'Clarification questions');
    let structuredQuestions: { question: string; options: string[] }[] = [];
    try {
      const parsed = parseJsonRobust(text) as { questions?: unknown[] };
      const raw = parsed.questions ?? [];
      structuredQuestions = (raw as (string | { question: string; options?: string[] })[]).map(q =>
        typeof q === 'string' ? { question: q, options: [] } : { question: q.question, options: q.options ?? [] }
      );
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Parsing clarification questions failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      this.ctx.warn('Parsing clarification questions', err, 'Using raw AI response as a single question');
      structuredQuestions = [{ question: text, options: [] }];
    }

    const questionTexts = structuredQuestions.map(q =>
      typeof q.question === 'string' ? q.question : JSON.stringify(q.question)
    );

    const clarEntry = this.ctx.addEntry({
      type: 'clarification',
      speaker: 'system',
      content: questionTexts.join('\n'),
      taxonomy_refs: [],
      metadata: { questions: structuredQuestions },
    });
    this.ctx.recordDiagnostic(clarEntry.id, { prompt, raw_response: text });

    this.ctx.progress('clarification', undefined, 'Synthesizing refined topic');
    const qaPairs = questionTexts.map(q => `Q: ${q}\nA: [Automated: The debate should explore this from all three perspectives.]`).join('\n\n');
    const concludingPromptText = concludingPrompt(this.ctx.config.topic, qaPairs, this.ctx.config.audience, undefined, lineageCtx);
    const synthText = await this.ctx.generateViaUsage('debate.topic-synthesis', concludingPromptText, 'Topic synthesis');

    try {
      const parsed = parseJsonRobust(synthText) as { refined_topic?: string };
      if (parsed.refined_topic) {
        this.ctx.session.topic.refined = parsed.refined_topic;
        this.ctx.session.topic.final = parsed.refined_topic;
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Parsing refined topic failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      this.ctx.warn('Parsing refined topic from clarification', err, 'Keeping original topic unchanged');
    }

    this.ctx.addEntry({
      type: 'answer',
      speaker: 'user',
      content: `[Automated clarification] Refined topic: ${this.ctx.session.topic.final}`,
      taxonomy_refs: [],
    });

    await this.decomposeResolutionIntoClauses();
    await this.embedResolutionAnchors();
  }

  // ── ArCo Phase: Resolution Anchoring ────────────────────────
  // Moved out of clarification (t/284) so it can run independently when anchorToResolution: true.
  // This method runs both decomposition and embedding together.

  async runResolutionAnchoring(): Promise<void> {
    await this.decomposeResolutionIntoClauses();
    await this.embedResolutionAnchors();
  }

  async decomposeResolutionIntoClauses(): Promise<void> {
    const resolution = this.ctx.session.topic.final;
    if (!resolution || resolution.trim().length === 0) return;

    try {
      const prompt = decomposeResolutionPrompt(resolution);
      const text = await this.ctx.generate(prompt, 'Resolution clause decomposition');
      const parsed = parseJsonRobust(text) as { clauses?: unknown };
      if (Array.isArray(parsed.clauses)) {
        const clauses = parsed.clauses
          .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
          .map(c => c.trim());
        if (clauses.length > 0) {
          this.ctx.session.topic.clauses = clauses;
        }
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Resolution clause decomposition failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      this.ctx.warn('Resolution clause decomposition', err, 'Moderator will anchor to resolution text only');
    }
  }

  async embedResolutionAnchors(): Promise<void> {
    const adapter = this.ctx.adapter as ExtendedAIAdapter;
    if (!adapter.computeQueryEmbedding) return;
    const resolution = this.ctx.session.topic.final;
    if (!resolution || resolution.trim().length === 0) return;

    try {
      const { vector } = await adapter.computeQueryEmbedding(resolution.slice(0, 1000));
      if (vector && vector.length > 0) {
        this.ctx.session.topic.embedding = vector;
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Resolution embedding failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      this.ctx.warn('Resolution embedding', err, 'ArCo drift signal will be unavailable');
    }

    const clauses = this.ctx.session.topic.clauses;
    if (!clauses || clauses.length === 0) return;
    const clauseVectors: number[][] = [];
    for (const clause of clauses) {
      try {
        const { vector } = await adapter.computeQueryEmbedding(clause.slice(0, 500));
        if (vector && vector.length > 0) clauseVectors.push(vector);
      } catch (err) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: this.ctx.session?.id, message: 'Clause embedding failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      }
    }
    if (clauseVectors.length === clauses.length) {
      this.ctx.session.topic.clause_embeddings = clauseVectors;
    }
  }

  computeTopicDriftState(): { phaseMeanSimilarity?: number; driftWarning: boolean; coveredClauses: number[]; uncoveredClauses: number[]; consecutiveOffClause: number } | undefined {
    const signals = this.ctx.session.convergence_signals ?? [];
    if (signals.length === 0) return undefined;

    const RECENT_WINDOW = 6;
    const recent = signals.slice(-RECENT_WINDOW);
    const latest = signals[signals.length - 1];

    const totalClauses = this.ctx.session.topic.clauses?.length ?? 0;
    const coveredSet = new Set<number>();
    let consecutiveOffClause = 0;
    for (let i = signals.length - 1; i >= 0; i--) {
      const c = signals[i].clause_coverage;
      if (!c) break;
      if (c.no_clause_engaged) consecutiveOffClause++;
      else break;
    }
    for (const s of recent) {
      const c = s.clause_coverage;
      if (c && c.best_clause_id != null) coveredSet.add(c.best_clause_id + 1);
    }
    const covered = Array.from(coveredSet).sort((a, b) => a - b);
    const uncovered: number[] = [];
    for (let i = 1; i <= totalClauses; i++) {
      if (!coveredSet.has(i)) uncovered.push(i);
    }

    return {
      phaseMeanSimilarity: latest.arco?.phase_mean,
      driftWarning: latest.arco?.drift_warning ?? false,
      coveredClauses: covered,
      uncoveredClauses: uncovered,
      consecutiveOffClause,
    };
  }
}
