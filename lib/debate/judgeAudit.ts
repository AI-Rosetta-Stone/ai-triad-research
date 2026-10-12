// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Cross-model judge audit — replays the Stage-B judge prompt against
 * completed debate turns using multiple LLM models to compare verdicts.
 *
 * Usage:
 *   npx tsx lib/debate/judgeAudit.ts --debate <path> [--debate <path2>] --models haiku,gemini [--output report.json]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCLIAdapter } from './aiAdapter.js';
import { DEFAULT_MODEL } from '../ai-client/index.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import type { DebateSession, TranscriptEntry, TaxonomyRef, DebatePhase } from './types.js';
import { getDebatePhase } from './types.js';
import { parseJsonRobust } from './helpers.js';

// ── Types ───────────────────────────────────────────────

interface JudgeVerdict {
  advances: boolean;
  advancement_reason: string;
  clarifies_taxonomy: { action: string; node_id?: string; rationale?: string }[];
  weaknesses: string[];
  recommend: 'pass' | 'retry' | 'accept_with_flag';
}

interface TurnAuditResult {
  entry_id: string;
  speaker: string;
  round: number;
  phase: DebatePhase;
  content_preview: string;
  verdicts: Record<string, {
    verdict: JudgeVerdict;
    response_time_ms: number;
    raw_response: string;
    error?: string;
  }>;
}

interface DebateAuditReport {
  debate_id: string;
  debate_title: string;
  debate_model: string;
  turns_audited: number;
  models_tested: string[];
  turns: TurnAuditResult[];
  agreement: AgreementMatrix;
  summary: AuditSummary;
}

interface AgreementMatrix {
  recommend_agreement: Record<string, Record<string, number>>;
  advances_agreement: Record<string, Record<string, number>>;
}

interface AuditSummary {
  per_model: Record<string, {
    pass_count: number;
    retry_count: number;
    flag_count: number;
    advances_true_count: number;
    avg_weaknesses: number;
    avg_taxonomy_hints: number;
    avg_response_ms: number;
    error_count: number;
  }>;
  blind_spots: {
    entry_id: string;
    speaker: string;
    round: number;
    model_that_flagged: string;
    models_that_passed: string[];
    weaknesses: string[];
  }[];
}

// ── Judge prompt (mirrors turnValidator.ts buildJudgePrompt) ─────

function buildJudgePrompt(
  statement: string,
  taxonomyRefs: TaxonomyRef[],
  meta: Record<string, unknown>,
  phase: DebatePhase,
  speaker: string,
  round: number,
  recentTurns: TranscriptEntry[],
): string {
  const window = recentTurns.slice(-2).map(t => {
    const content = typeof t.content === 'string' ? t.content : JSON.stringify(t.content);
    return `[${t.speaker}] ${content.slice(0, 800)}`;
  }).join('\n\n');

  const turnJson = JSON.stringify({
    statement: statement.slice(0, 2000),
    taxonomy_refs: taxonomyRefs,
    move_types: meta.move_types ?? [],
    disagreement_type: meta.disagreement_type ?? null,
    my_claims: meta.my_claims ?? [],
  }, null, 2);

  return `You are a debate-progress referee. You do NOT take sides. You judge ONE turn against the last two turns of the same debate.

Phase: ${phase}
Agent: ${speaker}
Round: ${round}

Previous turns (last 2, any agent):
${window || '(no prior turns)'}

Current turn (JSON):
${turnJson}

Decide:
1. ADVANCES — does this turn do something the previous turns did not? (distinguish, concede-and-pivot, falsifiable prediction, narrowed crux, new steelman)
2. CLARIFIES_TAXONOMY — does it imply a taxonomy edit? Choose zero or more of:
   narrow <node_id> | broaden <node_id> | split <node_id> | merge <node_ids> | qualify <node_id> | retire <node_id> | new_node <label>
   Only mark a hint when the turn contains evidence for it — never speculative.
3. WEAKNESSES — list at most 3, each ≤15 words. Each names a concrete fix the debater could apply on retry.

Return ONLY JSON in this shape (no prose, no code fences):
{
  "advances": true|false,
  "advancement_reason": "...",
  "clarifies_taxonomy": [ { "action": "narrow|broaden|split|merge|qualify|retire|new_node", "node_id": "...", "rationale": "..." } ],
  "weaknesses": ["..."],
  "recommend": "pass" | "retry" | "accept_with_flag"
}`;
}

function parseJudgeVerdict(raw: string): JudgeVerdict {
  const fallback: JudgeVerdict = {
    advances: false,
    advancement_reason: 'judge_parse_failure',
    clarifies_taxonomy: [],
    weaknesses: [],
    recommend: 'accept_with_flag',
  };
  try {
    const parsed = parseJsonRobust(raw) as Record<string, unknown>;
    const rec = typeof parsed.recommend === 'string' ? parsed.recommend : 'pass';
    const recommend: JudgeVerdict['recommend'] =
      rec === 'retry' || rec === 'accept_with_flag' ? rec : 'pass';
    return {
      advances: parsed.advances !== false,
      advancement_reason: typeof parsed.advancement_reason === 'string' ? parsed.advancement_reason : '',
      clarifies_taxonomy: Array.isArray(parsed.clarifies_taxonomy)
        ? (parsed.clarifies_taxonomy as Record<string, unknown>[])
            .filter(h => typeof h.action === 'string')
            .map(h => ({ action: h.action as string, node_id: h.node_id as string | undefined, rationale: h.rationale as string | undefined }))
        : [],
      weaknesses: Array.isArray(parsed.weaknesses)
        ? (parsed.weaknesses as unknown[]).filter(w => typeof w === 'string') as string[]
        : [],
      recommend,
    };
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'judge-audit', level: 'warn', message: 'Failed to parse judge response JSON', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return fallback;
  }
}

// ── Model alias resolution ──────────────────────────────

const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  gemini: DEFAULT_MODEL,
  'gemini-flash': 'gemini-2.5-flash',
  'gemini-lite': DEFAULT_MODEL,
  groq: 'groq-openai-gpt-oss-120b',
  llama: 'groq-openai-gpt-oss-120b',
};

function resolveModelAlias(input: string): string {
  return MODEL_ALIASES[input.toLowerCase()] ?? input;
}

// ── Agreement computation ───────────────────────────────

function computeAgreement(turns: TurnAuditResult[], models: string[]): AgreementMatrix {
  const recAgree: Record<string, Record<string, number>> = {};
  const advAgree: Record<string, Record<string, number>> = {};

  for (const m1 of models) {
    recAgree[m1] = {};
    advAgree[m1] = {};
    for (const m2 of models) {
      let recMatch = 0, advMatch = 0, count = 0;
      for (const t of turns) {
        const v1 = t.verdicts[m1]?.verdict;
        const v2 = t.verdicts[m2]?.verdict;
        if (!v1 || !v2) continue;
        count++;
        if (v1.recommend === v2.recommend) recMatch++;
        if (v1.advances === v2.advances) advMatch++;
      }
      recAgree[m1][m2] = count > 0 ? Math.round((recMatch / count) * 100) : 0;
      advAgree[m1][m2] = count > 0 ? Math.round((advMatch / count) * 100) : 0;
    }
  }

  return { recommend_agreement: recAgree, advances_agreement: advAgree };
}

function computeSummary(turns: TurnAuditResult[], models: string[]): AuditSummary {
  const perModel: AuditSummary['per_model'] = {};

  for (const m of models) {
    let pass = 0, retry = 0, flag = 0, advTrue = 0, totalWeak = 0, totalHints = 0, totalMs = 0, errors = 0, count = 0;
    for (const t of turns) {
      const v = t.verdicts[m];
      if (!v) continue;
      if (v.error) { errors++; continue; }
      count++;
      if (v.verdict.recommend === 'pass') pass++;
      else if (v.verdict.recommend === 'retry') retry++;
      else flag++;
      if (v.verdict.advances) advTrue++;
      totalWeak += v.verdict.weaknesses.length;
      totalHints += v.verdict.clarifies_taxonomy.length;
      totalMs += v.response_time_ms;
    }
    perModel[m] = {
      pass_count: pass, retry_count: retry, flag_count: flag,
      advances_true_count: advTrue,
      avg_weaknesses: count > 0 ? Math.round((totalWeak / count) * 10) / 10 : 0,
      avg_taxonomy_hints: count > 0 ? Math.round((totalHints / count) * 10) / 10 : 0,
      avg_response_ms: count > 0 ? Math.round(totalMs / count) : 0,
      error_count: errors,
    };
  }

  const blindSpots: AuditSummary['blind_spots'] = [];
  for (const t of turns) {
    for (const m of models) {
      const v = t.verdicts[m]?.verdict;
      if (!v || v.recommend === 'pass') continue;
      const passers = models.filter(m2 => m2 !== m && t.verdicts[m2]?.verdict?.recommend === 'pass');
      if (passers.length > 0) {
        blindSpots.push({
          entry_id: t.entry_id, speaker: t.speaker, round: t.round,
          model_that_flagged: m, models_that_passed: passers,
          weaknesses: v.weaknesses,
        });
      }
    }
  }

  return { per_model: perModel, blind_spots: blindSpots };
}

// ── Main audit logic ────────────────────────────────────

async function auditDebate(
  debatePath: string,
  models: string[],
  adapter: ReturnType<typeof createCLIAdapter>,
  maxTurns: number,
): Promise<DebateAuditReport> {
  const raw = fs.readFileSync(debatePath, 'utf-8');
  const debate: DebateSession = JSON.parse(raw);

  const statementsAndOpenings = debate.transcript.filter(
    t => t.type === 'statement' || t.type === 'opening',
  );

  const turnsToAudit = statementsAndOpenings.slice(0, maxTurns);
  const totalRounds = Math.max(
    ...debate.transcript.map(t => (t.metadata as Record<string, unknown>)?.round as number || 0),
    1,
  );

  process.stderr.write(`\n  Debate: ${debate.title?.slice(0, 60)}...\n`);
  process.stderr.write(`  Turns to audit: ${turnsToAudit.length} | Models: ${models.join(', ')}\n`);

  const turnResults: TurnAuditResult[] = [];

  for (let ti = 0; ti < turnsToAudit.length; ti++) {
    const entry = turnsToAudit[ti];
    const entryIdx = debate.transcript.indexOf(entry);
    const meta = (entry.metadata ?? {}) as Record<string, unknown>;
    const round = (meta.round as number) ?? Math.floor(ti / 3) + 1;
    const phase = getDebatePhase(round, totalRounds);

    const recentTurns = debate.transcript
      .slice(Math.max(0, entryIdx - 2), entryIdx)
      .filter(t => t.type === 'statement' || t.type === 'opening');

    const prompt = buildJudgePrompt(
      entry.content, entry.taxonomy_refs ?? [], meta,
      phase, entry.speaker, round, recentTurns,
    );

    process.stderr.write(`  [${ti + 1}/${turnsToAudit.length}] ${entry.speaker} r${round}...`);

    const verdicts: TurnAuditResult['verdicts'] = {};

    for (const model of models) {
      const t0 = Date.now();
      try {
        const rawResp = await adapter.generateText(prompt, model, { temperature: 0.1, maxTokens: 2048 });
        const elapsed = Date.now() - t0;
        const verdict = parseJudgeVerdict(rawResp);
        verdicts[model] = { verdict, response_time_ms: elapsed, raw_response: rawResp };
        const icon = verdict.recommend === 'pass' ? '✓' : verdict.recommend === 'retry' ? '↻' : '⚑';
        process.stderr.write(` ${model.split('-').slice(-2).join('-')}=${icon}`);
      } catch (err) {
        const elapsed = Date.now() - t0;
        getGlobalRecorder()?.record({ type: 'ai.error', component: 'judge-audit', level: 'warn', message: `Judge audit LLM call failed for model ${model}`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        verdicts[model] = {
          verdict: { advances: false, advancement_reason: 'judge_call_error', clarifies_taxonomy: [], weaknesses: [], recommend: 'accept_with_flag' },
          response_time_ms: elapsed, raw_response: '', error: (err as Error).message,
        };
        process.stderr.write(` ${model.split('-').slice(-2).join('-')}=ERR`);
      }
    }
    process.stderr.write('\n');

    turnResults.push({
      entry_id: entry.id, speaker: entry.speaker, round, phase,
      content_preview: entry.content.slice(0, 120),
      verdicts,
    });
  }

  return {
    debate_id: debate.id,
    debate_title: debate.title,
    debate_model: debate.debate_model ?? 'unknown',
    turns_audited: turnResults.length,
    models_tested: models,
    turns: turnResults,
    agreement: computeAgreement(turnResults, models),
    summary: computeSummary(turnResults, models),
  };
}

// ── CLI ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  const debates: string[] = [];
  let modelInput = 'haiku,gemini';
  let outputPath = '';
  let maxTurns = 50;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--debate': case '-d':
        debates.push(args[++i]); break;
      case '--models': case '-m':
        modelInput = args[++i]; break;
      case '--output': case '-o':
        outputPath = args[++i]; break;
      case '--max-turns':
        maxTurns = parseInt(args[++i], 10); break;
      case '--help': case '-h':
        process.stderr.write(`
Usage: npx tsx lib/debate/judgeAudit.ts [options]

Options:
  --debate, -d <path>    Debate JSON file (repeatable)
  --models, -m <list>    Comma-separated judge models (default: haiku,gemini)
                         Aliases: haiku, sonnet, gemini, gemini-flash, groq, llama
  --output, -o <path>    Output JSON report path (default: stdout)
  --max-turns <n>        Max turns per debate to audit (default: 50)
  --help, -h             Show this help

Example:
  npx tsx lib/debate/judgeAudit.ts -d ../ai-triad-data/debates/debate-4bc8ae8a.json -m haiku,gemini,groq
`);
        process.exit(0);
    }
  }

  if (debates.length === 0) {
    process.stderr.write('Error: at least one --debate <path> is required. Use --help for usage.\n');
    process.exit(1);
  }

  const models = modelInput.split(',').map(s => resolveModelAlias(s.trim())).filter(Boolean);
  if (models.length < 2) {
    process.stderr.write('Error: at least 2 models required for comparison. Use --help for usage.\n');
    process.exit(1);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '../..');
  const adapter = createCLIAdapter(repoRoot);

  process.stderr.write(`Judge Audit — ${debates.length} debate(s), ${models.length} models\n`);
  process.stderr.write(`Models: ${models.join(', ')}\n`);

  const reports: DebateAuditReport[] = [];
  for (const dp of debates) {
    const resolved = path.resolve(dp);
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`Warning: ${resolved} not found, skipping.\n`);
      continue;
    }
    const report = await auditDebate(resolved, models, adapter, maxTurns);
    reports.push(report);
  }

  // Print summary table to stderr
  process.stderr.write('\n══════════════════════════════════════════\n');
  process.stderr.write('RESULTS SUMMARY\n');
  process.stderr.write('══════════════════════════════════════════\n');

  for (const r of reports) {
    process.stderr.write(`\n─── ${r.debate_title.slice(0, 60)} ───\n`);
    process.stderr.write(`Turns: ${r.turns_audited} | Original model: ${r.debate_model}\n\n`);

    process.stderr.write('  Model                          Pass  Retry  Flag  Advances  AvgWeak  AvgMs   Err\n');
    process.stderr.write('  ─────────────────────────────  ────  ─────  ────  ────────  ───────  ──────  ───\n');
    for (const [m, s] of Object.entries(r.summary.per_model)) {
      const label = m.padEnd(31);
      process.stderr.write(`  ${label}  ${String(s.pass_count).padStart(4)}  ${String(s.retry_count).padStart(5)}  ${String(s.flag_count).padStart(4)}  ${String(s.advances_true_count).padStart(8)}  ${String(s.avg_weaknesses).padStart(7)}  ${String(s.avg_response_ms).padStart(6)}  ${String(s.error_count).padStart(3)}\n`);
    }

    if (r.summary.blind_spots.length > 0) {
      process.stderr.write(`\n  Blind spots (${r.summary.blind_spots.length}):\n`);
      for (const bs of r.summary.blind_spots.slice(0, 10)) {
        process.stderr.write(`    ${bs.speaker} r${bs.round}: ${bs.model_that_flagged} flagged, ${bs.models_that_passed.join('+')} passed\n`);
        for (const w of bs.weaknesses.slice(0, 2)) {
          process.stderr.write(`      → ${w}\n`);
        }
      }
    }

    process.stderr.write('\n  Recommend agreement (%):\n');
    const ms = r.models_tested;
    process.stderr.write('  ' + ''.padEnd(32) + ms.map(m => m.split('-').slice(-2).join('-').padStart(12)).join('') + '\n');
    for (const m1 of ms) {
      const label = m1.split('-').slice(-2).join('-').padEnd(32);
      const cells = ms.map(m2 => String(r.agreement.recommend_agreement[m1]?.[m2] ?? 0).padStart(12));
      process.stderr.write('  ' + label + cells.join('') + '\n');
    }
  }

  // Write JSON report
  const output = reports.length === 1 ? reports[0] : { reports };
  const json = JSON.stringify(output, null, 2);
  if (outputPath) {
    fs.writeFileSync(outputPath, json, 'utf-8');
    process.stderr.write(`\nReport written to: ${outputPath}\n`);
  } else {
    process.stdout.write(json);
  }
}

main().catch(err => {
  getGlobalRecorder()?.record({ type: 'system.error', component: 'judge-audit', level: 'error', message: 'Fatal unhandled error', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
