#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Headless debate runner for baseline measurement.
 * Runs fixed debate topics through the same prompt pipeline as the taxonomy-editor,
 * saves transcripts and synthesis output for scoring.
 *
 * Usage:
 *   node scripts/run-debate-baseline.mjs [--runs N] [--topics D1,D2,D5] [--output path]
 *
 * Requires: GEMINI_API_KEY environment variable
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(REPO_ROOT, '..', 'ai-triad-data');
const TAXONOMY_DIR = path.join(DATA_ROOT, 'taxonomy', 'Origin');

// ── Config ────────────────────────────────────────────────

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

const MODEL = process.env.AI_MODEL || 'gemini-3.5-flash-lite';
console.log(`[AI] Backend: gemini | Model: ${MODEL}${process.env.AI_MODEL ? ' ($AI_MODEL)' : ' (default)'} | Key source: $GEMINI_API_KEY`);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Parse args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}
const NUM_RUNS = parseInt(getArg('runs', '2'), 10);
const TOPIC_IDS = getArg('topics', 'D1,D2,D5').split(',');
const OUTPUT_PATH = getArg('output', path.join(REPO_ROOT, 'docs', 'debate-baseline-post-phase-1.json'));

// ── Fixed topics from the plan ────────────────────────────

const FIXED_TOPICS = {
  D1: { type: 'topic', topic: 'Will scaling compute alone be sufficient to produce AGI-level systems by 2030?' },
  D2: { type: 'topic', topic: 'Should the US government impose a licensing regime for foundation model developers?' },
  D4: { type: 'topic', topic: "What's the Biggest AI Risk? — Each perspective frames AI risk differently. Debate which framing best captures the actual landscape of threats." },
  D5: { type: 'topic', topic: 'Require all AI systems deployed in hiring to pass annual third-party bias audits' },
};

// ── POVer definitions ─────────────────────────────────────

const POVERS = {
  prometheus: { label: 'Prometheus', pov: 'accelerationist', personality: 'Confident, forward-looking, frames risk as cost-of-inaction' },
  sentinel: { label: 'Sentinel', pov: 'safetyist', personality: 'Methodical, evidence-driven, frames progress as conditional-on-safeguards' },
  cassandra: { label: 'Cassandra', pov: 'skeptic', personality: 'Wry, pragmatic, challenges assumptions from both sides' },
};

// ── Load taxonomy ─────────────────────────────────────────

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

const taxonomyData = {
  accelerationist: loadJson(path.join(TAXONOMY_DIR, 'accelerationist.json')),
  safetyist: loadJson(path.join(TAXONOMY_DIR, 'safetyist.json')),
  skeptic: loadJson(path.join(TAXONOMY_DIR, 'skeptic.json')),
  crossCutting: loadJson(path.join(TAXONOMY_DIR, 'cross-cutting.json')),
};

// ── BDI taxonomy context formatter (mirrors taxonomyContext.ts) ──

const CATEGORY_TO_BDI = {
  'Data/Facts': {
    header: '=== YOUR BELIEFS (what you take as empirically true) ===',
    framing: 'These are the factual claims and empirical observations that ground your worldview.',
  },
  'Goals/Values': {
    header: '=== YOUR VALUES (what you prioritize and why) ===',
    framing: 'These are the goals and principles you argue from. They are normative commitments, not empirical claims.',
  },
  'Methods/Arguments': {
    header: '=== YOUR REASONING APPROACH (how you argue) ===',
    framing: 'These are the methods, frameworks, and argumentative strategies you use to connect beliefs to values.',
  },
};

function formatTaxonomyContext(pov, maxNodes = 20) {
  const povFile = taxonomyData[pov];
  const povNodes = (povFile?.nodes ?? []).slice(0, maxNodes);
  const ccNodes = taxonomyData.crossCutting?.nodes ?? [];

  const groups = { 'Data/Facts': [], 'Goals/Values': [], 'Methods/Arguments': [] };
  for (const n of povNodes) {
    const cat = n.category || 'Methods/Arguments';
    (groups[cat] ?? groups['Methods/Arguments']).push(n);
  }

  const lines = [];
  for (const cat of ['Data/Facts', 'Goals/Values', 'Methods/Arguments']) {
    const nodes = groups[cat];
    if (nodes.length === 0) continue;
    const bdi = CATEGORY_TO_BDI[cat];
    lines.push(bdi.header, bdi.framing);
    for (const n of nodes) {
      lines.push(`[${n.id}] ${n.label}: ${n.description}`);
      if (n.graph_attributes?.epistemic_type) lines.push(`  Epistemic type: ${n.graph_attributes.epistemic_type}`);
      if (n.graph_attributes?.assumes?.length > 0) lines.push(`  Assumes: ${n.graph_attributes.assumes.join('; ')}`);
    }
    lines.push('');
  }

  // Vulnerabilities
  const vulnLines = [];
  for (const n of povNodes) {
    if (n.graph_attributes?.steelman_vulnerability) vulnLines.push(`- [${n.id}] ${n.label}: ${n.graph_attributes.steelman_vulnerability}`);
    if (n.graph_attributes?.possible_fallacies?.length > 0) {
      for (const f of n.graph_attributes.possible_fallacies.filter(f => f.confidence !== 'borderline')) {
        vulnLines.push(`- [${n.id}] ${n.label}: Watch for ${f.fallacy.replace(/_/g, ' ')} (${f.confidence})`);
      }
    }
  }
  if (vulnLines.length > 0) {
    lines.push('=== YOUR KNOWN VULNERABILITIES ===');
    lines.push('Be aware of these weaknesses in your positions. Acknowledging them when relevant strengthens your credibility — but do not over-concede or apologize for your core stance.');
    lines.push(...vulnLines, '');
  }

  // Cross-cutting
  if (ccNodes.length > 0) {
    lines.push('=== CROSS-CUTTING CONCERNS ===');
    lines.push("These concepts are contested across all perspectives. Your interpretation differs from others'.");
    for (const n of ccNodes) {
      lines.push(`[${n.id}] ${n.label}: ${n.description}`);
      const interp = n.interpretations?.[pov];
      if (interp) lines.push(`  Your interpretation: ${interp}`);
      const otherPovs = ['accelerationist', 'safetyist', 'skeptic'].filter(p => p !== pov);
      const otherViews = otherPovs
        .map(p => { const v = n.interpretations?.[p]; return v ? `${p.charAt(0).toUpperCase() + p.slice(1, 3)}: ${v.length > 80 ? v.slice(0, 77) + '...' : v}` : null; })
        .filter(Boolean);
      if (otherViews.length > 0) lines.push(`  Other views: ${otherViews.join(' | ')}`);
    }
  }

  return lines.join('\n');
}

// ── Gemini API ────────────────────────────────────────────

let apiCallCount = 0;

async function generateText(prompt) {
  apiCallCount++;
  const url = `${GEMINI_BASE}/${MODEL}:generateContent?key=${API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 16384 },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${body.slice(0, 300)}`);
  }
  const json = await resp.json();
  if (!json.candidates?.length) throw new Error('No candidates from Gemini');
  return json.candidates[0].content.parts.map(p => p.text).join('');
}

function stripCodeFences(text) {
  return text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
}

function tryParseJson(text) {
  try { return JSON.parse(stripCodeFences(text)); }
  catch { return null; }
}

// ── Prompt templates (mirrors debate.ts) ──────────────────

const READING_LEVEL = 'Write for a policy reporter or congressional staffer — someone smart and busy who needs to understand and quote you. Lead with your main claim in the first sentence. Use active voice with named actors. One idea per sentence. Prefer concrete examples and specific numbers over abstract categories. Every paragraph should contain at least one sentence a reporter could quote directly without rewriting. Avoid nominalizations (say "regulators decided" not "the regulatory decision"), hedge stacking ("may potentially" → pick one), and sentences that require re-reading. Technical terms are fine when they are load-bearing; define them briefly on first use.';

const TAXONOMY_USAGE = `Your taxonomy context is organized into BDI sections — Beliefs, Values, and Reasoning Approach — that structure your worldview:

- BELIEFS (Data/Facts): Your empirical grounding. Draw on these when making factual claims or citing evidence.
- VALUES (Goals/Values): Your normative commitments. Draw on these when arguing about what matters or what should happen.
- REASONING APPROACH (Methods/Arguments): Your argumentative strategies. Draw on these when constructing arguments or choosing how to frame an issue.

Reference nodes from across all three sections — not just the one most obvious for your point. The strongest arguments connect beliefs to values through reasoning.

Express ideas in your own words. Never say "According to taxonomy node X" — instead, make the argument naturally and tag which nodes you drew from in the taxonomy_refs field. For each taxonomy_ref, the "relevance" field MUST be 1 to 4 sentences explaining specifically how that node informed your argument — not a brief label. Vary your sentence openings; never start with "This node".

Your KNOWN VULNERABILITIES section lists weaknesses in your positions and fallacy tendencies to watch for. Acknowledge a vulnerability when it is directly relevant — this builds credibility. But do not over-concede or preemptively apologize; your job is to make the strongest case for your perspective.

Your CROSS-CUTTING CONCERNS show where your interpretation of a contested concept differs from other perspectives. Use these to identify genuine disagreements rather than talking past each other.`;

function openingPrompt(label, pov, personality, topic, taxonomyCtx, priorBlock, isFirst) {
  return `You are ${label}, an AI debater representing the ${pov} perspective on AI policy.
Your personality: ${personality}.
${READING_LEVEL}
Provide a moderately detailed response — 1-2 paragraphs. Include a brief steelman of the position you are critiquing (1 sentence) before presenting your argument.

${TAXONOMY_USAGE}

${taxonomyCtx}
${priorBlock}

The debate topic is:

"${topic}"

Deliver your opening statement. This is your chance to frame the issue from your perspective and establish your core argument. Be specific, substantive, and persuasive.
${isFirst ? 'You are delivering the first opening statement.' : 'You have read the prior opening statements. Before critiquing any prior position, briefly acknowledge the strongest version of that position. You may reference or contrast with them, but focus on your own position.'}

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "statement": "your opening statement text",
  "taxonomy_refs": [
    {"node_id": "e.g. acc-goals-002", "relevance": "1-4 sentences explaining how this node informed your argument."}
  ]
}`;
}

function crossRespondPrompt(label, pov, personality, topic, taxonomyCtx, transcript, focusPoint, addressing) {
  return `You are ${label}, an AI debater representing the ${pov} perspective on AI policy.
Your personality: ${personality}.
${READING_LEVEL}
Provide a moderately detailed response — 1-2 paragraphs.

${TAXONOMY_USAGE}

Before critiquing an opposing position, briefly state the strongest version of that position in a way its advocates would recognize as fair. Only then explain where you think it breaks down.

When you disagree with another debater, classify your disagreement:
- EMPIRICAL: You believe different facts are true
- VALUES: You share the facts but prioritize differently
- DEFINITIONAL: You define a key term differently

Your response should employ one or more of these dialectical moves:
- CONCEDE: Acknowledge a valid point from the opponent
- DISTINGUISH: Accept the opponent's evidence but show it doesn't apply here
- REFRAME: Shift the framing to reveal what the current frame hides
- COUNTEREXAMPLE: Provide a specific case that challenges the opponent's claim
- REDUCE: Show the opponent's logic leads to an absurd or unacceptable conclusion
- ESCALATE: Raise the stakes by connecting to a broader principle

${taxonomyCtx}

=== DEBATE TOPIC ===
"${topic}"

=== RECENT DEBATE HISTORY ===
${transcript}

=== YOUR ASSIGNMENT ===
Address ${addressing} on this point: ${focusPoint}

Respond substantively. Engage directly with what was said. If you disagree, explain why with specifics and classify your disagreement type.

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "statement": "your response text",
  "taxonomy_refs": [
    {"node_id": "e.g. acc-goals-002", "relevance": "1-4 sentences."}
  ],
  "move_types": ["CONCEDE", "DISTINGUISH"],
  "disagreement_type": "EMPIRICAL or VALUES or DEFINITIONAL (omit if not disagreeing)"
}`;
}

function moderatorPrompt(transcript, activePovers) {
  return `You are a debate moderator analyzing the current state of a structured debate.
${READING_LEVEL}

=== RECENT DEBATE EXCHANGE ===
${transcript}

=== ACTIVE DEBATERS ===
${activePovers.join(', ')}

Identify the most productive next exchange. Which debater should respond, to whom, and about what specific point?

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "responder": "debater name who should speak next",
  "addressing": "debater name they should address, or 'general'",
  "focus_point": "the specific point or question they should address"
}`;
}

function synthesisPrompt(topic, transcript) {
  return `You are a debate analyst. Analyze this structured debate and produce a synthesis.
${READING_LEVEL}

=== DEBATE TOPIC ===
"${topic}"

=== FULL TRANSCRIPT ===
${transcript}

Identify:
1. Areas where the debaters agree (and which debaters)
2. Areas where they genuinely disagree (with each debater's specific stance)
3. For each disagreement, classify:
   a. "type": EMPIRICAL, VALUES, or DEFINITIONAL
   b. "bdi_layer": which layer of the debaters' worldview this disagreement lives in:
      - "belief" — they disagree about what is empirically true
      - "value" — they share the facts but prioritize differently
      - "conceptual" — they define a key term or concept differently
   c. "resolvability": how this disagreement could potentially be resolved:
      - "resolvable_by_evidence" — new data could settle this
      - "negotiable_via_tradeoffs" — requires trade-off reasoning
      - "requires_term_clarification" — debaters need to agree on definitions first
4. Cruxes — the specific factual or value questions that, if resolved, would change a debater's position
5. Questions that remain unresolved
6. Which taxonomy nodes were referenced and how they were used
7. Build an argument map: extract key claims, show support and attack relationships
   - Each claim: ID (C1, C2...), near-verbatim text from transcript, who said it
   - attack_type: "rebut" (contradicts conclusion), "undercut" (accepts evidence, denies inference), "undermine" (attacks source)
   - scheme: COUNTEREXAMPLE, DISTINGUISH, REDUCE, REFRAME, CONCEDE, or ESCALATE

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "areas_of_agreement": [{"point": "...", "povers": ["prometheus", "sentinel"]}],
  "areas_of_disagreement": [{"point": "...", "type": "EMPIRICAL or VALUES or DEFINITIONAL", "bdi_layer": "belief or value or conceptual", "resolvability": "resolvable_by_evidence or negotiable_via_tradeoffs or requires_term_clarification", "positions": [{"pover": "prometheus", "stance": "..."}, {"pover": "sentinel", "stance": "..."}]}],
  "cruxes": [
    {"question": "...", "if_yes": "...", "if_no": "...", "type": "EMPIRICAL or VALUES"}
  ],
  "unresolved_questions": ["..."],
  "taxonomy_coverage": [{"node_id": "e.g. acc-goals-002", "how_used": "brief description"}],
  "argument_map": [
    {"claim_id": "C1", "claim": "near-verbatim from transcript", "claimant": "prometheus", "type": "empirical or normative or definitional", "supported_by": ["C3"], "attacked_by": [
      {"claim_id": "C2", "claim": "...", "claimant": "sentinel", "attack_type": "rebut or undercut or undermine", "scheme": "COUNTEREXAMPLE or DISTINGUISH or REDUCE or REFRAME or CONCEDE or ESCALATE"}
    ]}
  ],
  "preferences": [
    {"conflict": "description", "claim_ids": ["C1", "C2"], "prevails": "C2 or undecidable", "criterion": "empirical_evidence or logical_validity or source_authority or specificity or scope", "rationale": "why", "what_would_change_this": "what evidence would flip it"}
  ]
}`;
}

// ── Debate runner ─────────────────────────────────────────

const POVER_ORDER = ['prometheus', 'sentinel', 'cassandra'];

async function runDebate(topicId, topicConfig, runNum) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${topicId} — Run ${runNum} — "${topicConfig.topic.slice(0, 60)}..."`);
  console.log(`${'═'.repeat(60)}`);

  const transcript = [];
  function addEntry(speaker, type, content, meta = {}) {
    transcript.push({ speaker, type, content, ...meta, timestamp: new Date().toISOString() });
  }

  function formatTranscript() {
    return transcript.map(e => `[${e.speaker}] ${e.content}`).join('\n\n');
  }

  // Phase 1: Opening statements
  console.log('  Opening statements...');
  const priorStatements = [];
  for (const poverId of POVER_ORDER) {
    const info = POVERS[poverId];
    const taxonomyCtx = formatTaxonomyContext(info.pov);
    let priorBlock = '';
    if (priorStatements.length > 0) {
      priorBlock = '\n\n=== PRIOR OPENING STATEMENTS ===\n';
      for (const ps of priorStatements) priorBlock += `\n${ps.speaker}:\n${ps.statement}\n`;
    }

    const prompt = openingPrompt(info.label, info.pov, info.personality, topicConfig.topic, taxonomyCtx, priorBlock, priorStatements.length === 0);
    const raw = await generateText(prompt);
    const parsed = tryParseJson(raw);
    const statement = parsed?.statement || raw;
    const refs = parsed?.taxonomy_refs || [];

    addEntry(info.label, 'opening', statement, { taxonomy_refs: refs });
    priorStatements.push({ speaker: info.label, statement });
    console.log(`    ${info.label} ✓ (${refs.length} refs)`);
  }

  // Phase 2: Two cross-respond rounds
  for (let round = 1; round <= 2; round++) {
    console.log(`  Cross-respond round ${round}...`);

    // Ask moderator who should speak
    const modPrompt = moderatorPrompt(formatTranscript(), POVER_ORDER.map(p => POVERS[p].label));
    const modRaw = await generateText(modPrompt);
    const modParsed = tryParseJson(modRaw);

    if (!modParsed?.responder) {
      console.log('    Moderator parse failed, using round-robin');
      // Fallback: each responds to the previous
      const responder = POVER_ORDER[round % 3];
      const addressing = POVERS[POVER_ORDER[(round + 1) % 3]].label;
      const focusPoint = 'Respond to the strongest point made so far that you disagree with.';

      const info = POVERS[responder];
      const taxonomyCtx = formatTaxonomyContext(info.pov);
      const prompt = crossRespondPrompt(info.label, info.pov, info.personality, topicConfig.topic, taxonomyCtx, formatTranscript(), focusPoint, addressing);
      const raw = await generateText(prompt);
      const parsed = tryParseJson(raw);
      addEntry(info.label, 'cross-respond', parsed?.statement || raw, { taxonomy_refs: parsed?.taxonomy_refs || [], move_types: parsed?.move_types || [], disagreement_type: parsed?.disagreement_type });
      console.log(`    ${info.label} → ${addressing} ✓`);
    } else {
      // Find which pover matches the responder name
      const responderEntry = Object.entries(POVERS).find(([, v]) => v.label.toLowerCase() === modParsed.responder.toLowerCase());
      const responderId = responderEntry?.[0] || POVER_ORDER[round % 3];
      const info = POVERS[responderId];
      const addressing = modParsed.addressing || 'general';
      const focusPoint = modParsed.focus_point || 'Continue the debate.';

      const taxonomyCtx = formatTaxonomyContext(info.pov);
      const prompt = crossRespondPrompt(info.label, info.pov, info.personality, topicConfig.topic, taxonomyCtx, formatTranscript(), focusPoint, addressing);
      const raw = await generateText(prompt);
      const parsed = tryParseJson(raw);
      addEntry(info.label, 'cross-respond', parsed?.statement || raw, { taxonomy_refs: parsed?.taxonomy_refs || [], move_types: parsed?.move_types || [], disagreement_type: parsed?.disagreement_type });
      console.log(`    ${info.label} → ${addressing}: ${focusPoint.slice(0, 50)}... ✓`);
    }
  }

  // Phase 3: Synthesis
  console.log('  Synthesizing...');
  const synthPrompt = synthesisPrompt(topicConfig.topic, formatTranscript());
  const synthRaw = await generateText(synthPrompt);
  const synthesis = tryParseJson(synthRaw);

  if (!synthesis) {
    console.log('    ⚠ Synthesis parse failed, saving raw text');
  } else {
    const numDisagreements = synthesis.areas_of_disagreement?.length || 0;
    const numCruxes = synthesis.cruxes?.length || 0;
    const numRefs = synthesis.taxonomy_coverage?.length || 0;
    const bdiLayers = (synthesis.areas_of_disagreement || []).map(d => d.bdi_layer).filter(Boolean);
    console.log(`    ✓ ${numDisagreements} disagreements, ${numCruxes} cruxes, ${numRefs} taxonomy refs`);
    console.log(`    BDI layers: ${bdiLayers.join(', ') || '(none)'}`);
    const numClaims = synthesis.argument_map?.length || 0;
    const numAttacks = (synthesis.argument_map || []).flatMap(c => c.attacked_by || []).length;
    console.log(`    Argument map: ${numClaims} claims, ${numAttacks} attacks`);
  }

  return {
    topic_id: topicId,
    run: runNum,
    topic: topicConfig.topic,
    model: MODEL,
    timestamp: new Date().toISOString(),
    prompt_version: 'dolce-phase-1',
    transcript,
    synthesis: synthesis || { raw: synthRaw },
    api_calls: apiCallCount,
  };
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  console.log(`Debate Baseline Runner`);
  console.log(`Model: ${MODEL}`);
  console.log(`Topics: ${TOPIC_IDS.join(', ')}`);
  console.log(`Runs per topic: ${NUM_RUNS}`);
  console.log(`Output: ${OUTPUT_PATH}`);

  const results = [];

  for (const topicId of TOPIC_IDS) {
    const topicConfig = FIXED_TOPICS[topicId];
    if (!topicConfig) { console.error(`Unknown topic: ${topicId}`); continue; }

    for (let run = 1; run <= NUM_RUNS; run++) {
      apiCallCount = 0;
      try {
        const result = await runDebate(topicId, topicConfig, run);
        results.push(result);
      } catch (err) {
        console.error(`  ✗ ${topicId} run ${run} failed: ${err.message}`);
        results.push({ topic_id: topicId, run, error: err.message, timestamp: new Date().toISOString() });
      }
    }
  }

  // Compute summary stats
  const summary = {
    generated_at: new Date().toISOString(),
    model: MODEL,
    prompt_version: 'dolce-phase-1',
    topics_run: TOPIC_IDS.length,
    runs_per_topic: NUM_RUNS,
    total_debates: results.length,
    successful: results.filter(r => !r.error).length,
    failed: results.filter(r => r.error).length,
    scoring_rubric: {
      note: 'Score each synthesis on these 5 dimensions (0-3 scale). See dolce-aif-bdi-implementation-plan.md for full rubric.',
      dimensions: ['disagreement_count', 'disagreement_typing_accuracy', 'crux_quality', 'taxonomy_coverage', 'steelman_quality'],
    },
    aggregate_stats: computeAggregateStats(results.filter(r => !r.error)),
  };

  const output = { summary, debates: results };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✓ Results saved to ${OUTPUT_PATH}`);
  console.log(`  ${summary.successful}/${summary.total_debates} debates completed`);
}

function computeAggregateStats(debates) {
  if (debates.length === 0) return {};

  const allDisagreements = debates.flatMap(d => d.synthesis?.areas_of_disagreement || []);
  const bdiCounts = { belief: 0, value: 0, conceptual: 0, missing: 0 };
  const resolvCounts = {};
  for (const d of allDisagreements) {
    if (d.bdi_layer) bdiCounts[d.bdi_layer] = (bdiCounts[d.bdi_layer] || 0) + 1;
    else bdiCounts.missing++;
    if (d.resolvability) resolvCounts[d.resolvability] = (resolvCounts[d.resolvability] || 0) + 1;
  }

  const allRefs = debates.flatMap(d => {
    const transcript = d.transcript || [];
    return transcript.flatMap(e => (e.taxonomy_refs || []).map(r => r.node_id));
  });
  const uniqueRefs = [...new Set(allRefs)];
  const refsBySection = { beliefs: 0, values: 0, reasoning: 0, crossCutting: 0 };
  for (const ref of uniqueRefs) {
    if (ref.includes('-data-')) refsBySection.beliefs++;
    else if (ref.includes('-goals-')) refsBySection.values++;
    else if (ref.includes('-methods-')) refsBySection.reasoning++;
    else if (ref.startsWith('cc-')) refsBySection.crossCutting++;
  }

  return {
    total_disagreements: allDisagreements.length,
    mean_disagreements_per_debate: (allDisagreements.length / debates.length).toFixed(1),
    bdi_layer_distribution: bdiCounts,
    resolvability_distribution: resolvCounts,
    total_unique_taxonomy_refs: uniqueRefs.length,
    refs_by_bdi_section: refsBySection,
    total_cruxes: debates.reduce((sum, d) => sum + (d.synthesis?.cruxes?.length || 0), 0),
    mean_cruxes_per_debate: (debates.reduce((sum, d) => sum + (d.synthesis?.cruxes?.length || 0), 0) / debates.length).toFixed(1),
    // AIF argument_map stats (Phase 3)
    ...(() => {
      const allClaims = debates.flatMap(d => d.synthesis?.argument_map || []);
      const allAttacks = allClaims.flatMap(c => c.attacked_by || []);
      const attackTypes = {};
      const schemes = {};
      for (const a of allAttacks) {
        if (a.attack_type) attackTypes[a.attack_type] = (attackTypes[a.attack_type] || 0) + 1;
        if (a.scheme) schemes[a.scheme] = (schemes[a.scheme] || 0) + 1;
      }
      return {
        total_argument_map_claims: allClaims.length,
        mean_claims_per_debate: debates.length > 0 ? (allClaims.length / debates.length).toFixed(1) : '0',
        total_attacks: allAttacks.length,
        mean_attacks_per_debate: debates.length > 0 ? (allAttacks.length / debates.length).toFixed(1) : '0',
        attack_type_distribution: attackTypes,
        scheme_distribution: schemes,
        debates_with_argument_map: debates.filter(d => d.synthesis?.argument_map?.length > 0).length,
      };
    })(),
  };
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
