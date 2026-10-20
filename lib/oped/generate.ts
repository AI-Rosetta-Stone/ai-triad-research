// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { join } from 'path';

import { ActionableError } from '../debate/errors.js';
import { getSoulDocument, resolvePoverInfo, type SoulProvenance } from '../debate/soulDocLoader.js';
import { SoulDocumentSchema, buildSoulProvenance } from '../debate/soulDocSchema.js';
import { applyTagSelection, checkTagScope } from '../debate/relevanceSelection.js';
import { TAG_BOOST_INCREMENT } from '../debate/debateConfig.js';
import type { PovNode } from '../debate/taxonomyTypes.js';
import { loadPovTagRegistry, validatePovTagSelection, tagSoulFileName, type AppliedTag, type TagSelection } from '../schema/povTags.js';
import type { AIAdapter } from '../debate/aiAdapter.js';
import type { PovKey } from '../debate/types.js';
import { stripCodeFences } from '../debate/helpers.js';
import type { ScoredPovNode, ScoredSituationNode } from '../debate/taxonomyRelevance.js';
import { scoreNodeRelevance, selectRelevantNodes, selectRelevantSituationNodes } from '../debate/taxonomyRelevance.js';
import { loadTaxonomy } from '../debate/taxonomyLoader.js';
import { computeEmbedding } from '../embeddings/onnxEmbedding.js';
import type { OpEdMember, OpEdParams, OpEdSet, OpEdGroundingRef, EditingMeta, CoherenceMeta, OpEdSoulProvenance } from './types.js';
import { resolveOutletBand } from './outletBands.js';
import { loadAndAssemblePrompt, assembleReflectionPrompt, assembleSourceBriefPrompt, assembleReadabilityEditPrompt, assembleCoherenceJudgePrompt, assembleCoherenceRewritePrompt, type SourceBrief } from './promptLoader.js';
import { FABRICATED_LEDE_GUARD } from './opedGuards.js';
import { measureReadability, needsEdit, buildViolationsText, findIntroducedTells, splitLongParagraphs, DEFAULT_READABILITY_TARGETS } from './readabilityMeasure.js';
import { COHERENCE_JUDGE_SCHEMA, normalizeJudgeResult, validFlags, buildCoherenceViolationsText, type CoherenceJudgeResult } from './coherenceCheck.js';

// ── Public request / deps types ───────────────────────────────────────────────

export interface GenerateOpEdRequest {
  set_id: string;
  topic: string;
  params: OpEdParams;
  povs: PovKey[];
  /** Raw source markdown (pre-fetched from URL). Omit for topic-only requests. */
  sourceMaterial?: string;
  /** The URL `sourceMaterial` was fetched from — persisted as OpEdSet.source_url for
   *  provenance (t/2898). The app-half handler passes it; absent for topic runs. */
  sourceUrl?: string;
  signal?: AbortSignal;
}

export interface OpEdGeneratorDeps {
  adapter: AIAdapter;
  /** Absolute path to dir containing op-ed-*.prompt files (shared PS+TS artifacts). */
  promptsDir: string;
  /** Repo root — locates soul-docs/ and taxonomy/embeddings data. */
  repoRoot: string;
  /** Optional recorder for guard warnings — pass getGlobalRecorder() from the host. */
  recorder?: { record: (event: Record<string, unknown>) => void } | null;
}

// ── Progress event union ──────────────────────────────────────────────────────

export type OpEdProgressEvent =
  | { type: 'source_brief_done'; keyClaimsCount: number }
  | { type: 'source_brief_failed'; error: string }
  | { type: 'grounding_done'; nodeCount: number }
  | { type: 'grounding_failed'; error: string }
  | { type: 'voice_start'; pov: PovKey }
  | { type: 'voice_complete'; pov: PovKey; member: OpEdMember }
  | { type: 'voice_failed'; pov: PovKey; error: string }
  | { type: 'voice_cancelled'; pov: PovKey }
  | { type: 'complete'; set: OpEdSet };

// ── Soul doc (internal) ───────────────────────────────────────────────────────

interface SoulVoice {
  disposition: string;
  style: string;
  reasoning: string;
  evidence: string;
  signature: string;
  prose_style: string;
  voice_hygiene: string;
}

interface SoulDoc {
  label: string;
  personality: string;
  voice: SoulVoice;
  value_hierarchy: string[];
  epistemic_stance: string[];
  anti_patterns: string[];
}

// ── Soul doc helpers ──────────────────────────────────────────────────────────

/** A soul ready to voice one member: the document, the label the byline and prompt use, and which file
 *  it came from (`member.soul`, t/3960). */
interface VoiceSoul {
  soul: SoulDoc;
  /** The POV label from the BASE soul, always: a tag never changes who is writing (CL t/3960#5). */
  label: string;
  /** The wing name from the tag registry, for the tagged member only. */
  wing?: string;
  provenance: OpEdSoulProvenance;
}

/** "Skeptic" for an untagged member; "Skeptic (Critical wing)" for the tagged one. */
function voiceName(v: VoiceSoul): string {
  return v.wing ? `${v.label} (${v.wing} wing)` : v.label;
}

/** "By the Skeptic Camp (Critical wing), …": the camp stays the identity; the wing qualifies it (CL t/3960#5). */
function bylineFor(v: VoiceSoul): string {
  return `By the ${v.label} Camp${v.wing ? ` (${v.wing} wing)` : ''}, as modeled in AI Rosetta Stone`;
}

/** "…the Critical wing of the Skeptic perspective" for the tagged member (CL t/3960#5). */
function disclosureFor(v: VoiceSoul): string {
  const perspective = v.wing ? `the ${v.wing} wing of the ${v.label} perspective` : `the ${v.label} perspective`;
  return `Generated by AI Rosetta Stone to illustrate ${perspective}. Not authored by any person; not for submission or publication.`;
}

function loadSoulDoc(pov: PovKey): VoiceSoul {
  // Uses soulDocLoader (same reader as the debate engine) so parity holds by construction (t/4007).
  // Shape-validated via getSoulDocument (not resolvePoverInfo which returns PovInfo — see tag path comment).
  const soulDoc = getSoulDocument(pov);
  const { soulProvenance } = resolvePoverInfo(pov);
  if (!soulProvenance) {
    throw new ActionableError({
      goal: 'Load base soul for op-ed generation',
      problem: `Soul provenance unavailable for ${pov} — file not found in soul-docs loader`,
      location: 'lib/oped/generate.ts — loadSoulDoc',
      nextSteps: [`Verify ${pov}.soul.json exists at lib/debate/soul-docs/`],
    });
  }
  return { soul: soulDoc as SoulDoc, label: soulDoc.label, provenance: { file: soulProvenance.file, hash: soulProvenance.hash } };
}

/** Exported for parity testing only (t/4007): op-ed base-soul provenance via the debate loader. */
export function opedSoulProvenance(pov: PovKey): SoulProvenance | undefined {
  return resolvePoverInfo(pov).soulProvenance;
}

// ── Tag pre-flight (t/3960; TL t/3960#3/#8, SO e/254#6) ──────────────────────────────────────────

/** Everything the run needs for its one tagged member, resolved BEFORE any generation starts. */
export interface OpEdTagPlan {
  selection: TagSelection;
  voice: VoiceSoul;
  /** All POV nodes of the tagged camp, for the tag filter in grounding. */
  campNodes: PovNode[];
}

function tagRefusal(problem: string, nextSteps: string[]): ActionableError {
  return new ActionableError({
    goal: 'Generate a tagged op-ed set',
    problem,
    location: 'lib/oped/generate.ts — preflightOpEdTag',
    nextSteps,
  });
}

/**
 * Resolve a request's tag before any generation, and REFUSE rather than degrade:
 *  - the tag must be registered for its POV, and that POV must be in `povs`;
 *  - the tag soul must load (through soulDocLoader only, so its path rule is t/3989's): no fallback to the
 *    base soul;
 *  - a Scope run on too few tagged nodes refuses (`checkTagScope`), instead of writing an essay on a handful
 *    of nodes behind a warning. Debates refuse the same way in their setup screens; only a debate's MID-RUN
 *    narrowing warns (one rule, two phases: TL t/3960#8).
 * Returns undefined for an untagged request. Callers that start generation from a request (the server route,
 * the IPC handler) may call this first to refuse synchronously; `generateOpEdSet` calls it again regardless.
 */
export function preflightOpEdTag(request: GenerateOpEdRequest, deps: OpEdGeneratorDeps): OpEdTagPlan | undefined {
  const selection = request.params.tagSelection;
  if (!selection) return undefined;
  const { pov, tag, mode } = selection;

  const problems = validatePovTagSelection(pov, tag);
  if (!request.povs.includes(pov)) problems.push(`tagSelection.pov "${pov}" is not one of the requested povs (${request.povs.join(', ')})`);
  if (problems.length > 0) {
    throw tagRefusal(problems.join('; '), ['Choose a registered tag for a requested POV, or omit tagSelection.']);
  }

  const wing = loadPovTagRegistry().povs[pov]!.find((e) => e.id === tag)!;
  const base = loadSoulDoc(pov);
  // The voice comes from the full, schema-validated tag document (t/4002): `resolvePoverInfo` returns a
  // PovInfo-typed identity view, so casting it to SoulDoc would let a shape change silently drop
  // `voice.*` / `anti_patterns` from the voice block. `resolvePoverInfo` is used for provenance only.
  const tagSoul = parseTagSoul(pov, tag, getSoulDocument(pov, tag));
  const { soulProvenance } = resolvePoverInfo(pov, { tag, mode });
  if (!soulProvenance) {
    throw tagRefusal(`Soul provenance unavailable for tag soul ${pov}:${tag} — file not found in soul-docs loader`, [
      `Verify ${tag} soul file exists at lib/debate/soul-docs/${tagSoulFileName(pov, tag)}`,
    ]);
  }
  // The byline and prompt keep the POV label: a tag selects a wing, it doesn't change who is writing
  // (CL t/3960#5; matches t/3988 for debates). The tag soul's own `label` is never used as the identity.
  const voice: VoiceSoul = {
    soul: tagSoul,
    label: base.label,
    wing: wing.label,
    provenance: { file: soulProvenance.file.split(/[\\/]/).pop()!, hash: soulProvenance.hash },
  };

  const taxonomy = loadTaxonomy(deps.repoRoot);
  const campNodes = (taxonomy[pov]?.nodes ?? []) as PovNode[];
  refuseThinTag(campNodes, embeddedNodeIds(taxonomy.embeddings), selection);
  return { selection, voice, campNodes };
}

/**
 * Validate a tag soul document against SoulDocumentSchema and return it as the op-ed SoulDoc (a structural
 * subset). A shape change refuses the request loudly instead of degrading the voice block (t/4002).
 */
function parseTagSoul(pov: PovKey, tag: string, doc: unknown): SoulDoc {
  const parsed = SoulDocumentSchema.safeParse(doc);
  if (parsed.success) return parsed.data;
  const where = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  throw tagRefusal(
    `The tag soul for ${pov}/${tag} is not a valid soul document (${where}), so its voice can't be built.`,
    [`Check lib/debate/soul-docs/${tagSoulFileName(pov, tag)} against SoulDocumentSchema (lib/debate/soulDocSchema.ts).`],
  );
}

/** Ids of nodes that have an embedding vector: the only nodes grounding can ever retrieve. */
function embeddedNodeIds(embeddings: Record<string, { vector?: unknown }> | undefined): Set<string> {
  return new Set(Object.entries(embeddings ?? {}).filter(([, e]) => Array.isArray(e?.vector)).map(([id]) => id));
}

/**
 * Refuse a tag the corpus can't support (CL p/736#27, #31, #44). The counts are of GROUNDABLE tagged nodes,
 * tagged AND embedded, because an unembedded node can never be retrieved (CL #44). Both pre-flight:
 *  - NO groundable node carries the tag, in EITHER mode. Scope would ground the wing on zero camp nodes
 *    (situations only) under its label; Prioritize would boost nothing while the byline still names the wing.
 *    Refused regardless of where the Scope floor ends up, and permanently (a tag can fall back to zero).
 *  - a Scope with too few groundable tagged nodes (`checkTagScope`; TL t/3960#3 cond 1).
 * Both refusals state the tagged count AND the groundable count, so a missing embedding is visible.
 */
function refuseThinTag(campNodes: PovNode[], embedded: ReadonlySet<string>, selection: TagSelection): void {
  const { pov, tag, mode } = selection;
  const taggedTotal = campNodes.filter((n) => (n.pov_tags ?? []).includes(tag)).length;
  const scope = checkTagScope(campNodes.filter((n) => embedded.has(n.id)), { tag, mode });
  const counts = `${taggedTotal} ${pov} node(s) tagged, ${scope.inScope.length} of them with an embedding`;
  if (scope.inScope.length === 0) {
    throw tagRefusal(
      `No groundable ${pov} node carries the tag "${tag}", so the ${tag} wing has nothing to ground on (${counts}).`,
      ['Tag nodes for this wing (t/3962) and make sure they have embeddings, or omit tagSelection.'],
    );
  }
  if (mode === 'scope' && !scope.sufficient) {
    throw tagRefusal(
      `Scope "${pov}/${tag}" has too few groundable tagged nodes to ground an essay (${counts}; checkTagScope judged it insufficient).`,
      ['Use Prioritize mode, which keeps every node and ranks tagged ones first.', 'Or tag (and embed) more nodes for this wing first.'],
    );
  }
}

/** The soul for one member: the tag soul for the tagged member, its base soul for every other. */
function voiceFor(pov: PovKey, plan: OpEdTagPlan | undefined, deps: OpEdGeneratorDeps): VoiceSoul {
  return plan && pov === plan.selection.pov ? plan.voice : loadSoulDoc(pov);
}

/** Attach what the tag did to its member; other members are returned untouched. */
function withAppliedTag(member: OpEdMember, applied: AppliedTag | undefined): OpEdMember {
  return applied ? { ...member, tag: applied } : member;
}

/** BDI grounding for one camp. The tag filter applies ONLY to the tagged camp; every other camp selects
 *  exactly as untagged (t/3960). Returns the applied-tag record for the tagged camp. */
function selectCampGrounding(
  pov: PovKey, campNodes: PovNode[], scores: Map<string, number>, plan: OpEdTagPlan | undefined, deps: OpEdGeneratorDeps,
): { grounding: ScoredPovNode[]; applied?: AppliedTag } {
  const tagged = plan && pov === plan.selection.pov ? applyOpEdTag(plan, scores) : undefined;
  if (tagged) {
    warnScopeNarrowing(tagged.applied, deps);
    warnUnembeddedTagged(tagged.applied, tagged.unembedded, deps);
  }
  const grounding = selectRelevantNodes(
    tagged?.nodes ?? campNodes,
    tagged?.scores ?? scores,
    undefined, // use default threshold
    2,         // minPerCategory
    12,        // maxTotal — mirrors PS MaxGroundingNodes default
  );
  return { grounding, applied: tagged?.applied };
}

/** Fallback-path logging: a Scope run narrows the camp. Sufficient (the pre-flight passed), but visible. */
function warnScopeNarrowing(applied: AppliedTag, deps: OpEdGeneratorDeps): void {
  if (applied.mode !== 'scope' || applied.excludedUntagged === 0) return;
  deps.recorder?.record({
    type: 'system.error', component: 'oped-generate', level: 'warn',
    message: `Op-ed scope tag "${applied.pov}/${applied.tag}" excluded ${applied.excludedUntagged} ${applied.pov} nodes not tagged ${applied.tag} from grounding (${applied.included} tagged in scope)`,
  });
}

/** A tagged node with no embedding can never be scored, so it can never be grounded. Data-quality gap:
 *  surface it with the count, never absorb it (TL p/736#43). `included` already counts only what can ground. */
function warnUnembeddedTagged(applied: AppliedTag, unembedded: number, deps: OpEdGeneratorDeps): void {
  if (unembedded === 0) return;
  deps.recorder?.record({
    type: 'system.error', component: 'oped-generate', level: 'warn',
    message: `Op-ed tag "${applied.pov}/${applied.tag}": ${unembedded} tagged ${applied.pov} node(s) have no embedding and cannot ground (${applied.included} can)`,
  });
}

/** The tag filter for the tagged camp's grounding: the nodes to select from, the scores to rank by, and
 *  the applied-tag record with its counts (meanings per mode: APPLIED_TAG_COUNT_MEANING). `included` counts
 *  only tagged nodes that have a score (an embedding), since only those can be grounded or boosted; the rest
 *  are returned as `unembedded` for the WARN. The pre-flight floor (`refuseThinTag`) counts the same groundable set. */
function applyOpEdTag(plan: OpEdTagPlan, scores: Map<string, number>): { nodes: PovNode[]; scores: Map<string, number>; applied: AppliedTag; unembedded: number } {
  const { pov, tag, mode } = plan.selection;
  const { filteredNodes, excludedCount, boostIds } = applyTagSelection(plan.campNodes, { tag, mode });
  const taggedIds = mode === 'scope' ? filteredNodes.map((n) => n.id) : boostIds;
  const scorable = taggedIds.filter((id) => scores.has(id));
  const included = scorable.length;
  const boosted = new Map(scores);
  // Boost only nodes that have a score: an unembedded node must not acquire one from the boost alone.
  for (const id of boostIds) if (scores.has(id)) boosted.set(id, scores.get(id)! + TAG_BOOST_INCREMENT);
  return {
    nodes: filteredNodes,
    scores: mode === 'prioritize' ? boosted : scores,
    applied: { pov, tag, mode, included, excludedUntagged: excludedCount },
    unembedded: taggedIds.length - included,
  };
}

function buildVoiceBlock(soul: SoulDoc): string {
  const lines: string[] = [
    `PERSONALITY: ${soul.personality}`,
    `DISPOSITION: ${soul.voice.disposition}`,
    `RHETORICAL STYLE: ${soul.voice.style}`,
    `REASONING MODE: ${soul.voice.reasoning}`,
    `PREFERRED EVIDENCE: ${soul.voice.evidence}`,
    `SIGNATURE MOVE: ${soul.voice.signature}`,
    '',
    soul.voice.prose_style,
    '',
    soul.voice.voice_hygiene,
    '',
    'VALUE HIERARCHY (in priority order):',
    ...soul.value_hierarchy.map((v, i) => `  ${i + 1}. ${v}`),
    '',
    'EPISTEMIC STANCE:',
    ...soul.epistemic_stance.map(e => `  - ${e}`),
    '',
    'ANTI-PATTERNS (never do these):',
    ...soul.anti_patterns.map(a => `  - ${a}`),
  ];
  return lines.join('\n');
}

// ── Grounding text formatting ─────────────────────────────────────────────────

const VOICE_ONLY_GROUNDING = '(none — argue from your camp voice and general knowledge)';
const VOICE_ONLY_SITUATIONS = '(none supplied)';

export function parseNodeScope(description: string): { core: string; encompasses: string; excludes: string } {
  const eIdx = description.indexOf('\nEncompasses:');
  const xIdx = description.indexOf('\nExcludes:');
  const firstMarker = Math.min(
    eIdx === -1 ? Infinity : eIdx,
    xIdx === -1 ? Infinity : xIdx,
  );
  const core = firstMarker === Infinity ? description : description.slice(0, firstMarker);
  const extract = (marker: string, after: number): string => {
    if (after === -1) return '';
    const valueStart = after + marker.length;
    const nextNewline = description.indexOf('\n', valueStart);
    return (nextNewline === -1 ? description.slice(valueStart) : description.slice(valueStart, nextNewline)).trim();
  };
  return {
    core,
    encompasses: extract('\nEncompasses:', eIdx),
    excludes: extract('\nExcludes:', xIdx),
  };
}

function formatGroundingNodes(nodes: ScoredPovNode[]): string {
  if (nodes.length === 0) return VOICE_ONLY_GROUNDING;
  return nodes
    .map(({ node, score: _score }) => {
      const { core, encompasses, excludes } = parseNodeScope(node.description);
      const cappedCore = core.length > 240 ? core.slice(0, 240) + '…' : core;
      const lines = [`- [${node.id}] [${node.category}] ${node.label}: ${cappedCore}`];
      if (encompasses) lines.push(`    • Applies to: ${encompasses}`);
      if (excludes) lines.push(`    • Does NOT extend to: ${excludes}`);
      return lines.join('\n');
    })
    .join('\n');
}

function formatSituationNodes(nodes: ScoredSituationNode[]): string {
  if (nodes.length === 0) return VOICE_ONLY_SITUATIONS;
  return nodes
    .map(({ node, score: _score }) => {
      const desc = node.description.length > 300 ? node.description.slice(0, 300) + '…' : node.description;
      return `- [${node.id}] ${node.label}: ${desc}`;
    })
    .join('\n');
}

function buildGroundingList(nodes: ScoredPovNode[], sitNodes: ScoredSituationNode[]): string {
  const bdiLines = nodes.map(
    ({ node }) => `- [${node.id}] (bdi/${node.category}) ${node.label}`,
  );
  const sitLines = sitNodes.map(
    ({ node }) => `- [${node.id}] (situation/Situation) ${node.label}`,
  );
  return [...bdiLines, ...sitLines].join('\n');
}

// ── Essay response schema ─────────────────────────────────────────────────────

const SOURCE_BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    thesis: { type: 'string' },
    author: { type: 'string' },
    actor_type: { type: 'string' },
    stance: { type: 'string' },
    primary_recommendations: { type: 'array', items: { type: 'string' } },
    key_claims: { type: 'array', items: { type: 'string' } },
    readable: { type: 'boolean' },
  },
  required: ['thesis', 'author', 'actor_type', 'stance', 'primary_recommendations', 'key_claims', 'readable'],
} as const;

const ESSAY_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    subtitle: { type: 'string' },
    body_markdown: { type: 'string' },
    word_count: { type: 'integer' },
    stance: { type: 'string', description: 'How the camp engages the source: agree/extend/rebut (or empty if no source)' },
    rhetorical_meta: { type: 'string', description: '2–3 sentences of meta-commentary on the rhetorical strategy this piece used' },
  },
  required: ['headline', 'body_markdown', 'word_count', 'rhetorical_meta'],
} as const;

const REFLECTION_SCHEMA = {
  type: 'object',
  properties: {
    grounding_usage: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reflection: { type: 'string' },
          // t/2938: per-element claim linkage is now emitted as claim NUMBERS
          // (integers into the numbered SOURCE_CLAIMS list) rather than re-copied
          // verbatim text — lower emission friction lifts the model off the empty
          // default, and code-side resolution (below) is authoritative, avoiding
          // paraphrase/mismatch drift. Legacy verbatim `document_claims` still
          // accepted for backward-compat with older prompts/callers.
          document_claim_refs: { type: 'array', items: { type: 'integer' } },
          document_claims: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'reflection'],
      },
    },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          paragraph: { type: 'integer' },
        },
        required: ['text', 'paragraph'],
      },
    },
  },
  required: ['grounding_usage'],
} as const;

const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    body_markdown: { type: 'string' },
    changed: { type: 'boolean' },
    edit_notes: { type: 'string' },
  },
  required: ['body_markdown', 'changed', 'edit_notes'],
} as const;

// ── Per-voice generation ──────────────────────────────────────────────────────

interface EssayResponse {
  headline: string;
  subtitle?: string;
  body_markdown: string;
  word_count?: number;
  stance?: string;
  rhetorical_meta?: string;
}

interface ReflectionResponse {
  grounding_usage: { id: string; reflection: string; document_claim_refs?: number[]; document_claims?: string[] }[];
  claims?: { text: string; paragraph: number }[];
}

interface EditResponse {
  body_markdown: string;
  changed: boolean;
  edit_notes?: string;
}

async function runVoiceGeneration(
  pov: PovKey,
  groundingNodes: ScoredPovNode[],
  sitNodes: ScoredSituationNode[],
  request: GenerateOpEdRequest,
  deps: OpEdGeneratorDeps,
  sourceBrief: SourceBrief | undefined,
  /** The soul voicing this member: the tag soul for the tagged member, the base soul otherwise (voiceFor). */
  voiced: VoiceSoul,
): Promise<OpEdMember> {
  const soul = voiced.soul;
  const band = resolveOutletBand(request.params.outlet);
  const readTargets = band.readability ?? DEFAULT_READABILITY_TARGETS;
  const targetWords = request.params.wordCount > 0 ? request.params.wordCount : band.words;
  const maxTokens = Math.ceil(targetWords * 3) + 5000;

  const { system, user } = loadAndAssemblePrompt(deps.promptsDir, {
    topic: request.topic,
    params: request.params,
    pov,
    povLabel: voiceName(voiced),
    voiceBlock: buildVoiceBlock(soul),
    groundingNodes: formatGroundingNodes(groundingNodes),
    situations: formatSituationNodes(sitNodes),
    sourceMaterial: request.sourceMaterial ?? '(no external source supplied — argue from the topic and general knowledge)',
    sourceBrief,
    outletGuidance: band.guidance,
    targetWords,
    style: band.style,
  });

  // Prepend system to prompt — generateText has no separate system channel;
  // adapters that support adapter.generate() can be wired later for native system messages.
  const fullPrompt = `${system}\n\n---\n\n${user}`;
  const rawText = await deps.adapter.generateText(fullPrompt, request.params.model, {
    maxTokens,
    temperature: 0.8,
    responseSchema: ESSAY_SCHEMA as Record<string, unknown>,
    signal: request.signal,
  });

  // t/3013: an empty AI response comes back as '' WITHOUT throwing — e.g. Gemini returns a
  // candidate with empty/absent text parts on a safety block or certain truncations, and
  // generateViaGemini joins those to ''. Left unguarded, JSON.parse('') below fails into the
  // raw-text fallback, so the voice returns status:'complete' with an empty body — the blank
  // op-ed tab with no error state. Throw here so runVoice's catch marks the voice failed and
  // emits voice_failed (which the OpEdArticle failed-state notice then renders).
  if (!rawText.trim()) {
    throw new Error(`Voice generation returned empty response (pov=${pov})`);
  }

  let parsed: EssayResponse;
  try {
    parsed = JSON.parse(stripCodeFences(rawText)) as EssayResponse;
  } catch (err) {
    // t/3013 sibling: a NON-empty but non-JSON essay response (the empty case is guarded above).
    // Most often a truncated response (token-budget exhaustion) leaving unterminated JSON, or the
    // model emitting prose / ```json fences that survive stripCodeFences. The old silent fallback
    // stored that raw text as body_markdown, which <Markdown> renders as a monospace code block
    // with an always-empty headline — a garbage-looking tab, not a clean failure. Throw instead so
    // runVoice's catch marks the voice status:'failed' + emits voice_failed → the existing
    // OpEdArticle failed-state notice renders cleanly.
    throw new Error(`Voice generation returned invalid JSON (pov=${pov}): ${String(err)}`);
  }

  const body = parsed.body_markdown ?? '';

  // ── Logical-coherence pass (t/3826) ──────────────────────────────────────
  // Judge checks for internal contradiction (thesis⇄solution, mechanism⇄scope,
  // co-asserted tension). Runs BEFORE readability so the final body is coherent
  // before prose cleanup. Non-fatal: any throw → original body + recorder.warn.
  //
  // SURVIVING VECTOR: coherence is verified pre-readability only — a readability
  // rewrite can reintroduce a removed contradiction. Accepted gap per t/3826.
  let finalBody = body;
  let coherenceMeta: CoherenceMeta | undefined;

  if (body.trim()) {
    try {
      const valueHierarchyText = soul.value_hierarchy.map((v, i) => `${i + 1}. ${v}`).join('\n');
      const thesisText = request.params.thesis?.trim() ?? '';
      const judgePrompt = assembleCoherenceJudgePrompt(deps.promptsDir, body, thesisText, valueHierarchyText);
      const judgeRaw = await deps.adapter.generateText(judgePrompt, request.params.model, {
        maxTokens: 1200,
        temperature: 0.1,
        responseSchema: COHERENCE_JUDGE_SCHEMA as Record<string, unknown>,
        signal: request.signal,
      });
      const judgeResult = JSON.parse(stripCodeFences(judgeRaw)) as CoherenceJudgeResult;
      const checks = normalizeJudgeResult(judgeResult);
      const flags = validFlags(checks);
      const anyFlagged = flags.length > 0;

      if (!anyFlagged) {
        coherenceMeta = {
          any_flagged: false,
          checks_fired: [],
          flags: [],
          judge_model: request.params.model,
          body_length_before: body.length,
          rewritten: false,
        };
      } else {
        const violationsText = buildCoherenceViolationsText(checks);
        const rewritePrompt = assembleCoherenceRewritePrompt(deps.promptsDir, body, violationsText);
        const rewriteRaw = await deps.adapter.generateText(rewritePrompt, request.params.model, {
          maxTokens,
          temperature: 0.3,
          signal: request.signal,
        });
        const candidate = stripCodeFences(rewriteRaw).trim();

        if (!candidate) {
          coherenceMeta = {
            any_flagged: true,
            checks_fired: flags.map(f => f.check_id),
            flags: flags.map(f => ({ check_id: f.check_id, span_a: f.span_a, span_b: f.span_b, why: f.why })),
            judge_model: request.params.model,
            body_length_before: body.length,
            rewritten: false,
            reverted_reason: 'rewrite-returned-empty',
          };
          deps.recorder?.record({
            type: 'system.error', component: 'opedGenerate', level: 'warn',
            message: `Op-ed coherence rewrite returned empty for pov=${pov} set=${request.set_id} — using original body`,
          });
        } else {
          // Re-judge to verify the originally-flagged checks resolved.
          const reJudgePrompt = assembleCoherenceJudgePrompt(deps.promptsDir, candidate, thesisText, valueHierarchyText);
          const reJudgeRaw = await deps.adapter.generateText(reJudgePrompt, request.params.model, {
            maxTokens: 1200,
            temperature: 0.1,
            responseSchema: COHERENCE_JUDGE_SCHEMA as Record<string, unknown>,
            signal: request.signal,
          });
          const reJudgeResult = JSON.parse(stripCodeFences(reJudgeRaw)) as CoherenceJudgeResult;
          const reChecks = normalizeJudgeResult(reJudgeResult);
          const origFlagIds = new Set(flags.map(f => f.check_id));
          const stillFlagged = validFlags(reChecks).filter(c => origFlagIds.has(c.check_id));

          if (stillFlagged.length > 0) {
            coherenceMeta = {
              any_flagged: true,
              checks_fired: flags.map(f => f.check_id),
              flags: flags.map(f => ({ check_id: f.check_id, span_a: f.span_a, span_b: f.span_b, why: f.why })),
              judge_model: request.params.model,
              body_length_before: body.length,
              body_length_after: candidate.length,
              rewritten: false,
              checks_still_flagged_after: stillFlagged.map(c => c.check_id),
              reverted_reason: `rewrite-did-not-resolve: ${stillFlagged.map(c => c.check_id).join(', ')}`,
            };
            deps.recorder?.record({
              type: 'system.error', component: 'opedGenerate', level: 'warn',
              message: `Op-ed coherence rewrite did not resolve [${stillFlagged.map(c => c.check_id).join(', ')}] for pov=${pov} set=${request.set_id} — reverting to original body`,
            });
          } else {
            finalBody = candidate;
            coherenceMeta = {
              any_flagged: true,
              checks_fired: flags.map(f => f.check_id),
              flags: flags.map(f => ({ check_id: f.check_id, span_a: f.span_a, span_b: f.span_b, why: f.why })),
              judge_model: request.params.model,
              body_length_before: body.length,
              body_length_after: candidate.length,
              rewritten: true,
              checks_still_flagged_after: [],
            };
          }
        }
      }
    } catch (err) {
      deps.recorder?.record({
        type: 'system.error', component: 'opedGenerate', level: 'warn',
        message: `Op-ed coherence pass failed for pov=${pov} set=${request.set_id}: ${String(err)} — using original body`,
      });
    }
  }

  // ── Readability edit pass (t/3707) ────────────────────────────────────────
  // Measure -> conditional targeted edit -> re-verify. Runs ONLY when the draft
  // misses target (FK>11 || any paragraph>90w || any sentence>30w). Non-fatal:
  // any error degrades to the original body + WARN, never blocking generation.
  // Wired BEFORE the reflection pass so reflection maps grounding on the final body.
  let editingMeta: EditingMeta | undefined;

  if (body.trim()) {
    const beforeChecks = measureReadability(finalBody);
    if (needsEdit(beforeChecks, readTargets)) {
      const origWordCount = (finalBody.match(/\b\S+\b/g) ?? []).length;

      const attemptEdit = async (temperature: number): Promise<string | null> => {
        const violations = buildViolationsText(beforeChecks, readTargets);
        const editPrompt = assembleReadabilityEditPrompt(deps.promptsDir, finalBody, violations);
        const editRaw = await deps.adapter.generateText(editPrompt, request.params.model, {
          maxTokens,
          temperature,
          responseSchema: EDIT_SCHEMA as Record<string, unknown>,
          signal: request.signal,
        });
        const editParsed = JSON.parse(stripCodeFences(editRaw)) as EditResponse;
        const candidate = editParsed.body_markdown ?? '';
        // Word-count collapse guard: discard if >40% shorter than original
        const candidateWords = (candidate.match(/\b\S+\b/g) ?? []).length;
        if (!candidate.trim() || candidateWords < origWordCount * 0.6) return null;
        return candidate;
      };

      try {
        const firstCandidate = await attemptEdit(0.3);
        if (firstCandidate === null) {
          // Collapsed — fallback to original
          deps.recorder?.record({
            type: 'system.error', component: 'opedGenerate', level: 'warn',
            message: `Op-ed edit pass discarded (word-count collapse) for pov=${pov} set=${request.set_id} — using original body`,
          });
          editingMeta = { edited: false, fk_before: beforeChecks.fkGrade, fk_after: beforeChecks.fkGrade, checks_failed_after: [], reverted_reason: 'word-count-collapse' };
        } else {
          // Voice preservation: revert if the edit introduced banned tells absent from original
          const introducedTells = findIntroducedTells(finalBody, firstCandidate);
          if (introducedTells.length > 0) {
            deps.recorder?.record({
              type: 'system.error', component: 'opedGenerate', level: 'warn',
              message: `Op-ed edit pass introduced banned tells [${introducedTells.join(', ')}] — reverting to original (pov=${pov} set=${request.set_id})`,
            });
            editingMeta = { edited: false, fk_before: beforeChecks.fkGrade, fk_after: beforeChecks.fkGrade, checks_failed_after: [], reverted_reason: `introduced-banned-tells: ${introducedTells.join(', ')}` };
          } else {
            // Retry if first attempt made FK strictly worse — keep the better of the two
            let chosenBody = firstCandidate;
            const firstChecks = measureReadability(firstCandidate);
            if (firstChecks.fkGrade > beforeChecks.fkGrade) {
              try {
                const retryCandidate = await attemptEdit(0.2);
                if (retryCandidate !== null) {
                  const retryTells = findIntroducedTells(finalBody, retryCandidate);
                  const retryChecks = measureReadability(retryCandidate);
                  if (retryTells.length === 0 && retryChecks.fkGrade <= firstChecks.fkGrade) {
                    chosenBody = retryCandidate;
                  }
                }
              } catch {
                // retry failed — keep first attempt
              }
            }

            finalBody = chosenBody;
            let afterChecks = measureReadability(chosenBody);
            const failedChecks: string[] = [];
            if (afterChecks.fkGrade > readTargets.fkMax) failedChecks.push(`fk_grade=${afterChecks.fkGrade.toFixed(1)}`);
            if (afterChecks.maxParaWords > readTargets.maxParaWords) failedChecks.push(`max_para_words=${afterChecks.maxParaWords}`);
            if (afterChecks.maxSentWords > readTargets.maxSentWords) failedChecks.push(`max_sent_words=${afterChecks.maxSentWords}`);

            // Deterministic post-split backstop (t/3710): if the LLM edit pass still leaves an
            // over-long paragraph, split it at sentence boundaries and re-measure.
            if (afterChecks.maxParaWords > readTargets.maxParaWords) {
              finalBody = splitLongParagraphs(finalBody, readTargets.maxParaWords);
              afterChecks = measureReadability(finalBody);
              failedChecks.length = 0;
              if (afterChecks.fkGrade > readTargets.fkMax) failedChecks.push(`fk_grade=${afterChecks.fkGrade.toFixed(1)}`);
              if (afterChecks.maxParaWords > readTargets.maxParaWords) failedChecks.push(`max_para_words=${afterChecks.maxParaWords}`);
              if (afterChecks.maxSentWords > readTargets.maxSentWords) failedChecks.push(`max_sent_words=${afterChecks.maxSentWords}`);
            }

            if (failedChecks.length > 0) {
              deps.recorder?.record({
                type: 'system.error', component: 'opedGenerate', level: 'warn',
                message: `Op-ed edit pass still misses target for pov=${pov} set=${request.set_id}: ${failedChecks.join(', ')} (FK before=${beforeChecks.fkGrade.toFixed(1)} after=${afterChecks.fkGrade.toFixed(1)})`,
              });
            }

            editingMeta = {
              edited: true,
              fk_before: parseFloat(beforeChecks.fkGrade.toFixed(2)),
              fk_after: parseFloat(afterChecks.fkGrade.toFixed(2)),
              checks_failed_after: failedChecks,
            };
          }
        }
      } catch (err) {
        // Non-fatal fallback — degrade to original body (mirrors runReflection)
        deps.recorder?.record({
          type: 'system.error', component: 'opedGenerate', level: 'warn',
          message: `Op-ed edit pass failed for pov=${pov} set=${request.set_id}: ${String(err)} — using original body`,
        });
        editingMeta = { edited: false, fk_before: beforeChecks.fkGrade, fk_after: beforeChecks.fkGrade, checks_failed_after: [], reverted_reason: `error: ${String(err).slice(0, 120)}` };
      }
    }
  }

  const actualWordCount = finalBody.trim() ? finalBody.trim().split(/\s+/).length : 0;

  // Build initial grounding refs (reflection populated below if grounding was used)
  const allGroundingRefs: OpEdGroundingRef[] = [
    ...groundingNodes.map(({ node, score }) => ({
      node_id: node.id,
      label: node.label,
      category: String(node.category),
      pov,
      relevance: score.toFixed(4),
      how_reflected: '(not reported)',
    })),
    ...sitNodes.map(({ node, score }) => ({
      node_id: node.id,
      label: node.label,
      category: 'Situation',
      pov,
      relevance: score.toFixed(4),
      how_reflected: '(not reported)',
    })),
  ];

  // Reflection pass — best-effort, maps grounding elements to where they appear.
  // Uses finalBody (post-edit) so grounding maps to the text the user will see.
  let reflClaims: { text: string; paragraph: number }[] | undefined;
  if (allGroundingRefs.length > 0 && finalBody) {
    const groundingList = buildGroundingList(groundingNodes, sitNodes);
    const keyClaims = sourceBrief?.key_claims ?? [];
    const keyClaimsCount = keyClaims.length;
    // t/2938: resolve model-emitted claim NUMBERS (1-indexed into the numbered
    // SOURCE_CLAIMS list) to authoritative verbatim claim text. Out-of-range/0/dup
    // refs are dropped — the model never re-copies claim text, so persisted
    // document_claims can't drift from the source brief. Legacy verbatim arrays
    // (older prompts) pass through unchanged via resolveDocumentClaims's fallback.
    const resolveDocumentClaims = (
      refs: number[] | undefined,
      legacy: string[] | undefined,
    ): string[] => {
      if (refs?.length) {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const n of refs) {
          if (!Number.isInteger(n) || n < 1 || n > keyClaims.length) continue;
          const text = keyClaims[n - 1];
          if (!seen.has(text)) { seen.add(text); out.push(text); }
        }
        return out;
      }
      return legacy?.length ? legacy : [];
    };
    const sourceClaims = keyClaimsCount > 0
      ? keyClaims.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
      : '(none)';
    const reflPrompt = assembleReflectionPrompt(deps.promptsDir, finalBody, groundingList, sourceClaims);
    const reflMaxTokens = Math.max(4000, allGroundingRefs.length * 150 + 3000);

    // One reflection attempt. Applies how_reflected + document_claims onto allGroundingRefs
    // and sets reflClaims; returns true iff it produced any top-level claims. Fail-safe: a
    // throw is recorded (t/2897 diagnosability) and treated as "no claims" — never rethrown,
    // so a reflection failure can never block generation.
    const runReflection = async (temperature: number): Promise<boolean> => {
      try {
        const reflRaw = await deps.adapter.generateText(reflPrompt, request.params.model, {
          maxTokens: reflMaxTokens,
          temperature,
          responseSchema: REFLECTION_SCHEMA as Record<string, unknown>,
          signal: request.signal,
        });
        const reflParsed = JSON.parse(stripCodeFences(reflRaw)) as ReflectionResponse;
        const usageMap = new Map(reflParsed.grounding_usage.map(u => [u.id, u]));
        for (const ref of allGroundingRefs) {
          const usage = usageMap.get(ref.node_id);
          if (usage) {
            ref.how_reflected = usage.reflection;
            const resolved = resolveDocumentClaims(usage.document_claim_refs, usage.document_claims);
            if (resolved.length) ref.document_claims = resolved;
          }
        }
        if (reflParsed.claims?.length) reflClaims = reflParsed.claims;
        return !!reflParsed.claims?.length;
      } catch (err) {
        // Non-fatal — how_reflected stays '(not reported)', claims absent. Recorded so
        // it's visible (the bare swallow made four failures undiagnosable, t/2897).
        // 'system.error'+level:'warn' — the file's valid-EventType warn convention.
        deps.recorder?.record({
          type: 'system.error', component: 'opedGenerate', level: 'warn',
          message: `Op-ed reflection pass failed for pov=${pov} set=${request.set_id}: ${String(err)} — grounding how_reflected + claims will be absent`,
        });
        return false;
      }
    };

    const gotClaims = await runReflection(0.2);

    // Retry-on-empty insurance (t/2919): the reflection came back with no claims even
    // though a source brief WITH key_claims existed — a "should-have-but-didn't". The
    // ~50% systematic defect was FALSIFIED (22/22 on measurement, t/2919#1); this guards
    // only the one residual a clean measurement can't exclude — a rare transient LLM
    // empty/malformed response — the last un-excludable cause of the t/2897 "no Claims
    // section" after topic-mode (t/2899), stale-build, and the validation regression
    // (t/2908) were fixed. NOT reached for a legitimately-empty topic-mode reflection
    // (keyClaimsCount === 0). Single retry at temp 0, fail-safe, logged so any real prod
    // transient-empty rate becomes visible. Mirrors the narrate empty-entries gate (t/2872).
    if (!gotClaims && keyClaimsCount > 0) {
      deps.recorder?.record({
        type: 'system.info', component: 'opedGenerate', level: 'info',
        message: `Op-ed reflection returned no claims despite ${keyClaimsCount} source key_claims (pov=${pov} set=${request.set_id}) — retrying once (t/2919)`,
        data: { reason: 'reflection-retry', pov, set_id: request.set_id, key_claims: keyClaimsCount },
      });
      const retried = await runReflection(0);
      deps.recorder?.record({
        type: 'system.info', component: 'opedGenerate', level: 'info',
        message: `Op-ed reflection retry ${retried ? 'succeeded' : 'still empty'} (pov=${pov} set=${request.set_id}) (t/2919)`,
        data: { reason: 'reflection-retry-outcome', pov, set_id: request.set_id, succeeded: retried },
      });
    }
  }

  // Claims-extraction observability (t/2898): record a per-member count — including
  // the 0 case — so "zero claims extracted" is a visible recorded fact, not an
  // inference from an absent field. document_claims_refs = grounding refs the
  // reflection pass tied back to a source claim.
  const documentClaimsRefs = allGroundingRefs.filter(r => r.document_claims?.length).length;
  deps.recorder?.record({
    type: 'system.info', component: 'opedGenerate', level: 'info',
    message: `Op-ed claims extracted for pov=${pov} set=${request.set_id}: claims=${reflClaims?.length ?? 0} document_claims_refs=${documentClaimsRefs}`,
    data: { pov, set_id: request.set_id, claims_extracted: reflClaims?.length ?? 0, document_claims_refs: documentClaimsRefs },
  });

  // Guard scan: when newsHook was empty, check the lede (first 500 chars) for
  // fabricated dated-event markers. Flag without mutating the body (t/2730).
  const emptyHook = !request.params.newsHook?.trim();
  const fabricatedLede = emptyHook && FABRICATED_LEDE_GUARD.test(finalBody.slice(0, 500));
  if (fabricatedLede) {
    deps.recorder?.record({
      // 'system.error'+level:'warn' — 'system.warning' is not in the EventType union
      // (fixed in-scope, t/2898; TL-confirmed p/342#133).
      type: 'system.error', component: 'opedGenerate', level: 'warn',
      message: `FABRICATED_LEDE_GUARD matched for pov=${pov} set=${request.set_id} — empty-hook lede may contain invented dated event`,
    });
  }

  return {
    pov,
    status: 'complete',
    headline: parsed.headline ?? '',
    subtitle: parsed.subtitle ?? '',
    body: finalBody,
    byline: bylineFor(voiced),
    disclosure: disclosureFor(voiced),
    rhetorical_meta: parsed.rhetorical_meta ?? '',
    wordCount: actualWordCount,
    grounding: allGroundingRefs,
    ...(reflClaims && { claims: reflClaims }),
    ...(fabricatedLede && { fabricated_lede: true as const }),
    ...(editingMeta && { editing_meta: editingMeta }),
    ...(coherenceMeta && { coherence_meta: coherenceMeta }),
    soul: voiced.provenance,
  };
}

// ── Main exported generator ───────────────────────────────────────────────────

/**
 * Generate a multi-voice op-ed set, yielding progress events.
 * Voices run SEQUENTIALLY (one at a time) to bound peak memory (t/2719) — grounding
 * failure degrades to voice-only rather than throwing. Signal is threaded into every AI call.
 * Always yields `{ type: 'complete', set }` last — set.opeds carries all
 * members including failed/cancelled (partial-set contract, e/91#2 cond. 1).
 */
export async function* generateOpEdSet(
  request: GenerateOpEdRequest,
  deps: OpEdGeneratorDeps,
): AsyncGenerator<OpEdProgressEvent> {
  // ── Tag pre-flight (t/3960): refuse BEFORE any generation, so a bad or thin tag never yields a partial
  // set. Throws ActionableError; an untagged request gets undefined and runs exactly as before.
  const tagPlan = preflightOpEdTag(request, deps);
  // What the tag did, per camp (only the tagged camp gets an entry). Absent if grounding failed before the
  // filter ran: that member then carries the tag soul (member.soul) but no applied filter, by omission.
  const appliedByPov = new Map<PovKey, AppliedTag | undefined>();

  // ── Step 0: source-brief comprehension (when URL source present) ─────────
  // Extracts structured SourceBrief (thesis/author/stance/key_claims) from raw
  // markdown so {{SOURCE_AUTHOR/THESIS/STANCE/RECOMMENDATIONS/KEY_CLAIMS}} are
  // populated in the generation prompt. Non-fatal — falls through with undefined
  // so voices still generate from raw {{SOURCE_MATERIAL}} text on failure.
  let sourceBrief: SourceBrief | undefined;
  if (request.sourceMaterial) {
    try {
      const briefPrompt = assembleSourceBriefPrompt(deps.promptsDir, request.sourceMaterial);
      const briefRaw = await deps.adapter.generateText(briefPrompt, request.params.model, {
        maxTokens: 2000,
        temperature: 0.1,
        responseSchema: SOURCE_BRIEF_SCHEMA as Record<string, unknown>,
        signal: request.signal,
      });
      const parsed = JSON.parse(stripCodeFences(briefRaw)) as SourceBrief;
      if (parsed.readable !== false) {
        sourceBrief = parsed;
      } else {
        // t/2807: Step-0 judged the supplied source unreadable — voices then generate
        // from topic only, silently ignoring the source the caller provided. Record it
        // so "source supplied but not represented" is diagnosable (via the host recorder).
        deps.recorder?.record({
          type: 'system.error', component: 'oped-generate', level: 'warn',
          message: 'Op-ed source brief marked unreadable — generating from topic only despite a supplied source',
        });
      }
      // keyClaimsCount surfaces the comprehension result in-stream (t/2898) — 0 when
      // the brief was unreadable/absent so the handler sees "source present, 0 claims".
      yield { type: 'source_brief_done', keyClaimsCount: sourceBrief?.key_claims?.length ?? 0 };
    } catch (err) {
      yield { type: 'source_brief_failed', error: String(err) };
    }
  }

  // ── Step 1: grounding ─────────────────────────────────────────────────────
  // BDI grounding is selected PER POV — the taxonomy is camp-partitioned
  // (`taxonomy[pov].nodes`, ids `{pov}-{category}-{NNN}`), so a camp's grounding IS
  // its own belief/desire/intention nodes. Selecting once from `povs[0]` grounded
  // every voice in the first camp's nodes, making all voices display identical
  // grounding tables (a Safetyist essay grounded in `acc-*` nodes). Situations are
  // camp-agnostic, so `sitNodes` is legitimately selected once and shared.
  const groundingByPov = new Map<PovKey, ScoredPovNode[]>();
  let sitNodes: ScoredSituationNode[] = [];

  try {
    const taxonomy = loadTaxonomy(deps.repoRoot);
    const queryParts = [request.topic, request.params.newsHook, request.params.thesis].filter(Boolean);
    const query = queryParts.join('. ');
    const vec = await computeEmbedding(query);
    const scores = scoreNodeRelevance(vec, taxonomy.embeddings);

    for (const pov of request.povs) {
      const { grounding, applied } = selectCampGrounding(pov, taxonomy[pov]?.nodes ?? [], scores, tagPlan, deps);
      groundingByPov.set(pov, grounding);
      appliedByPov.set(pov, applied);
    }
    sitNodes = selectRelevantSituationNodes(
      taxonomy.situations?.nodes ?? [],
      scores,
      undefined,
      1,
      3,
    );
    // Count distinct grounding elements across the whole set (per-POV BDI node ids
    // are disjoint by camp; situations counted once) — a truthful set-level total.
    const distinctBdi = new Set<string>();
    for (const nodes of groundingByPov.values()) {
      for (const { node } of nodes) distinctBdi.add(node.id);
    }
    yield { type: 'grounding_done', nodeCount: distinctBdi.size + sitNodes.length };
  } catch (err) {
    yield { type: 'grounding_failed', error: String(err) };
    // continue voice-only
  }

  // ── Step 2: sequential voice generation (memory-bounded, t/2719) ──────────
  const queue: OpEdProgressEvent[] = [];
  let wakeResolve: (() => void) | null = null;
  let remaining = request.povs.length;
  const members: { pov: PovKey; member: OpEdMember }[] = [];

  function enqueue(ev: OpEdProgressEvent): void {
    queue.push(ev);
    const r = wakeResolve;
    wakeResolve = null;
    r?.();
  }

  async function runVoice(pov: PovKey): Promise<void> {
    if (request.signal?.aborted) {
      members.push({ pov, member: { pov, status: 'cancelled', headline: '', subtitle: '', body: '', byline: '', disclosure: '', rhetorical_meta: '', wordCount: 0, grounding: [] } });
      enqueue({ type: 'voice_cancelled', pov });
    } else {
      enqueue({ type: 'voice_start', pov });
      try {
        const member = withAppliedTag(
          await runVoiceGeneration(pov, groundingByPov.get(pov) ?? [], sitNodes, request, deps, sourceBrief, voiceFor(pov, tagPlan, deps)),
          appliedByPov.get(pov),
        );
        members.push({ pov, member });
        enqueue({ type: 'voice_complete', pov, member });
      } catch (err) {
        const cancelled = request.signal?.aborted;
        members.push({ pov, member: { pov, status: cancelled ? 'cancelled' : 'failed', headline: '', subtitle: '', body: '', byline: '', disclosure: '', rhetorical_meta: '', wordCount: 0, grounding: [] } });
        if (cancelled) {
          enqueue({ type: 'voice_cancelled', pov });
        } else {
          enqueue({ type: 'voice_failed', pov, error: String(err) });
        }
      }
    }
    remaining--;
    const r = wakeResolve;
    wakeResolve = null;
    r?.();
  }

  // t/2719: run voices SEQUENTIALLY (concurrency 1), not Promise.all. Parallel fan-out
  // kept every voice's AI response + JSON.parse resident at once which, on top of the
  // in-process ONNX model + embeddings + taxonomy, OOM-crashed the Node process mid-stream
  // (a single create took the whole server down). Sequential caps peak at one voice; the
  // queue/drain loop below still streams per-voice progress in order.
  void (async () => { for (const pov of request.povs) await runVoice(pov); })();

  while (remaining > 0 || queue.length > 0) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (remaining > 0 && queue.length === 0) {
      await new Promise<void>(r => { wakeResolve = r; });
    }
  }

  // ── Step 3: assemble set (preserve request.povs order) ───────────────────
  const memberMap = new Map(members.map(({ pov, member }) => [pov, member]));
  const orderedMembers = request.povs.map(pov => memberMap.get(pov)!).filter(Boolean);

  // Source provenance (t/2897/t/2898): source_mode is ALWAYS set on new sets so a
  // topic run (a URL pasted into the topic box → no source fetched → no claims) is
  // distinguishable from the file alone. url mode also carries the fetched URL and the
  // comprehension-pass claim count (0 = brief failed/unreadable/empty).
  const isUrlMode = !!request.sourceMaterial;
  const set: OpEdSet = {
    schema_version: 1,
    set_id: request.set_id,
    topic: request.topic,
    params: request.params,
    created_at: new Date().toISOString(),
    opeds: orderedMembers,
    source_mode: isUrlMode ? 'url' : 'topic',
    ...(isUrlMode && request.sourceUrl ? { source_url: request.sourceUrl } : {}),
    ...(isUrlMode ? { source_key_claims_count: sourceBrief?.key_claims?.length ?? 0 } : {}),
  };

  yield { type: 'complete', set };
}
