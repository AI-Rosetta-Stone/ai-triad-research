#!/usr/bin/env npx tsx
// Baseline measurement for caching design (Stage 2).
// Runs 10 debates through the real CLI pipeline, capturing [usage] telemetry.
//
// Usage:
//   npx tsx scripts/run-caching-baseline.ts [--count N] [--model MODEL]
//
// Output goes to debates/baseline/ (gitignored via /debates/).

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DEBATE_TOPICS } from '../lib/debate/topics.js';

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const COUNT = Math.min(parseInt(getArg('count', '10'), 10), DEBATE_TOPICS.length);
const MODEL = getArg('model', 'gemini-3.5-flash-lite');
const OUTDIR = 'debates/flat-t0';

fs.mkdirSync(OUTDIR, { recursive: true });

const topics = DEBATE_TOPICS.slice(0, COUNT);
const startTime = Date.now();
let completed = 0;
let failed = 0;

console.log(`Caching baseline: ${COUNT} debates, model=${MODEL}, 3 rounds each`);
console.log(`Output: ${OUTDIR}/\n`);

for (let i = 0; i < topics.length; i++) {
  const t = topics[i];
  const slug = t.theme.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const config = {
    topic: t.proposition,
    name: t.theme,
    model: MODEL,
    outputDir: `./${OUTDIR}`,
    slug,
    rounds: 3,
    temperature: 0,
  };

  const configPath = path.join(OUTDIR, `${slug}-config.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log(`${'='.repeat(60)}`);
  console.log(`[${i + 1}/${COUNT}] ${t.theme}`);
  console.log(`${'='.repeat(60)}`);

  const result = spawnSync('npx', ['tsx', 'lib/debate/cli.ts', '--config', configPath], {
    timeout: 900_000,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    shell: true,
    cwd: process.cwd(),
    env: { ...process.env, DEBATE_ENVELOPE: '0' },
  });

  const stderrLog = path.join(OUTDIR, `${slug}-stderr.log`);
  fs.writeFileSync(stderrLog, result.stderr ?? '');

  if (result.status === 0) {
    completed++;
    try {
      const parsed = JSON.parse(result.stdout);
      console.log(`  OK: ${parsed.stats.apiCalls} API calls, ${(parsed.stats.totalTimeMs / 1000).toFixed(0)}s`);
    } catch {
      console.log(`  OK`);
    }
  } else {
    failed++;
    console.error(`  FAILED (exit ${result.status}) -- see ${stderrLog}`);
    continue;
  }

  const usageLines = (result.stderr ?? '').split('\n').filter(l => l.startsWith('[usage]'));
  if (usageLines.length > 0) {
    let totalPrompt = 0, totalCompletion = 0, totalLatency = 0;
    for (const line of usageLines) {
      try {
        const data = JSON.parse(line.slice(8));
        totalPrompt += data.promptTokens ?? 0;
        totalCompletion += data.completionTokens ?? 0;
        totalLatency += data.latencyMs ?? 0;
      } catch { /* skip malformed */ }
    }
    console.log(`  ${usageLines.length} calls | ${totalPrompt.toLocaleString()} prompt tok | ${totalCompletion.toLocaleString()} completion tok | ${(totalLatency / 1000).toFixed(0)}s API time`);
  }
  console.log('');
}

// Aggregate all [usage] lines with debate slug
const allUsage: string[] = [];
for (const file of fs.readdirSync(OUTDIR).sort()) {
  if (!file.endsWith('-stderr.log')) continue;
  const debateSlug = file.replace('-stderr.log', '');
  const content = fs.readFileSync(path.join(OUTDIR, file), 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.startsWith('[usage]')) continue;
    try {
      const data = JSON.parse(line.slice(8));
      data.debate = debateSlug;
      allUsage.push(JSON.stringify(data));
    } catch { /* skip */ }
  }
}

const summaryPath = path.join(OUTDIR, 'usage-summary.jsonl');
fs.writeFileSync(summaryPath, allUsage.join('\n') + '\n');

// Compute aggregate stats
let grandPrompt = 0, grandCompletion = 0, grandLatency = 0;
for (const line of allUsage) {
  const d = JSON.parse(line);
  grandPrompt += d.promptTokens ?? 0;
  grandCompletion += d.completionTokens ?? 0;
  grandLatency += d.latencyMs ?? 0;
}

const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
console.log(`${'='.repeat(60)}`);
console.log(`Baseline complete: ${completed}/${COUNT} debates in ${elapsed} min`);
if (failed > 0) console.log(`  ${failed} failed`);
console.log(`  ${allUsage.length} usage records -> ${summaryPath}`);
console.log(`  Total prompt tokens:     ${grandPrompt.toLocaleString()}`);
console.log(`  Total completion tokens:  ${grandCompletion.toLocaleString()}`);
console.log(`  Total API time:           ${(grandLatency / 1000).toFixed(0)}s`);
console.log(`  Avg prompt tok/call:      ${allUsage.length > 0 ? Math.round(grandPrompt / allUsage.length).toLocaleString() : 'n/a'}`);
console.log(`${'='.repeat(60)}`);
