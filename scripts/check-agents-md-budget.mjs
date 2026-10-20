#!/usr/bin/env node
/**
 * scripts/check-agents-md-budget.mjs — instruction-file size ratchet (t/4323, t/4094 item 1)
 *
 * Problem: t/4094 set a 120-line cap on root AGENTS.md but nothing enforced it, and
 * instruction files grew back between successive cuts. A prose cap doesn't hold on
 * its own.
 *
 * How it works: reads docs/agent-instruction-budgets.json (seeded at each file's
 * measured size at authoring time), counts lines and words for each listed file,
 * and warns (via a GitHub Actions ::warning:: annotation, with the delta) for any
 * file over its budget. Growing a file past its budget requires bumping that
 * file's budget in the same PR — a ratchet, not a cap nothing can move.
 *
 * Scope: only files the budget JSON lists are checked. Root AGENTS.md and
 * operations/devops/azure/AGENTS.md are the only AGENTS.md files tracked by the
 * main repo (confirmed via `git ls-files | grep AGENTS.md$`) — every other
 * AGENTS.md (per-role instructions) is tracked by the separate Orca overlay repo
 * and is therefore not present in a GitHub Actions checkout at all. That gap is
 * NOT covered by this script; see t/4323 ticket for the route table.
 *
 * Exit 0 = every listed file within budget (or missing from the checkout, which is
 * a no-op, not a crash — lets this run cleanly on sparse/partial checkouts).
 * Exit 1 = at least one listed file exceeds its budget.
 *
 * Gate verification (AC proof): seed a budget of max_lines=1 for a scratch file,
 * point the JSON at it, add a second line → this script prints a warning naming the
 * file with delta=+1 and exits 1. Revert the file to one line → exits 0, silent.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_FILE = resolve(ROOT, 'docs/agent-instruction-budgets.json');

export function countLinesAndWords(text) {
  // Match `wc -l` semantics (newline count, not segment count) so budgets
  // seeded from `wc -lw` stay accurate: a trailing newline (the normal case
  // for a text file) must not count as an extra line.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = body.length === 0 ? 0 : body.split('\n').length;
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  return { lines, words };
}

export function checkBudgets(budgetEntries, readFile = (p) => readFileSync(p, 'utf8'), fileExists = (p) => existsSync(p)) {
  const violations = [];
  for (const entry of budgetEntries) {
    const abs = resolve(ROOT, entry.path);
    if (!fileExists(abs)) continue; // not in this checkout (e.g. overlay-tracked) — no-op, not a crash
    const { lines, words } = countLinesAndWords(readFile(abs));
    const overLines = lines - entry.max_lines;
    const overWords = words - entry.max_words;
    if (overLines > 0 || overWords > 0) {
      violations.push({
        path: entry.path,
        lines,
        words,
        maxLines: entry.max_lines,
        maxWords: entry.max_words,
        deltaLines: Math.max(overLines, 0),
        deltaWords: Math.max(overWords, 0),
      });
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files } = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
  const violations = checkBudgets(files);

  if (violations.length === 0) {
    console.log('Instruction-file size ratchet: all tracked files within budget. ✓');
    process.exit(0);
  }

  for (const v of violations) {
    const bits = [];
    if (v.deltaLines > 0) bits.push(`${v.lines} lines (+${v.deltaLines} over budget ${v.maxLines})`);
    if (v.deltaWords > 0) bits.push(`${v.words} words (+${v.deltaWords} over budget ${v.maxWords})`);
    console.log(`::warning file=${v.path}::${v.path} is ${bits.join(', ')}. Bump the budget in docs/agent-instruction-budgets.json if this growth is intended.`);
  }
  console.error(`\nInstruction-file size ratchet FAILED — ${violations.length} file(s) over budget (see warnings above).`);
  process.exit(1);
}
