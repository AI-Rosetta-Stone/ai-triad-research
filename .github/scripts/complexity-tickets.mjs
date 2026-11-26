#!/usr/bin/env node
// .github/scripts/complexity-tickets.mjs
// Turns complexity-budget signal into GitHub issues, so over-budget files get
// scheduled refactor work instead of only a red lint line (both arms are advisory;
// neither blocks a merge).
//
//   report            Upsert ONE tracking issue (label complexity:report) listing the
//                     worst offenders across every complexity baseline, and close any
//                     complexity:refactor issue whose file is no longer an offender.
//                     Run weekly by .github/workflows/complexity-report.yml.
//
//   file-violations   For each file a CI run flagged (ESLint local/complexity-budget or
//                     PS Test-ComplexityBudget), open a complexity:refactor issue, or
//                     comment on the open one. Inputs are the JSON reports uploaded by
//                     test-electron / complexity-budget (ci.yml job complexity-tickets).
//
// Flags: --dir <reports dir> (file-violations), --top <N> (report), --dry-run (print
// writes instead of calling gh). Author-run tests:
//   node --test .github/scripts/complexity-tickets.test.mjs

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REFACTOR_LABEL = 'complexity:refactor'
export const REPORT_LABEL = 'complexity:report'
export const REPORT_TITLE = 'Complexity budget: worst offenders'
const TITLE_PREFIX = 'Complexity: refactor '

// Every baseline the two ratchets enforce. `root` is the directory baseline keys are
// relative to; prefixing it gives the repo-relative path used in issue titles.
export const BASELINES = [
  { baseline: 'lib/eslint-rules/complexity-baseline.json', root: 'taxonomy-editor', lang: 'TypeScript' },
  { baseline: 'poviewer/complexity-baseline.json', root: 'poviewer', lang: 'TypeScript' },
  { baseline: 'summary-viewer/complexity-baseline.json', root: 'summary-viewer', lang: 'TypeScript' },
  { baseline: 'workflow-app/complexity-baseline.json', root: 'workflow-app', lang: 'TypeScript' },
  { baseline: 'scripts/complexity-baseline.json', root: 'scripts', lang: 'PowerShell' },
  { baseline: 'operations/complexity-baseline.json', root: 'operations', lang: 'PowerShell' },
]

const ESLINT_RULE = 'local/complexity-budget'
// Budget breaches only; config errors (baselineLoadError, thresholdMismatch,
// scanScopeMismatch) are not a file's complexity and must not file refactor tickets.
const ESLINT_BREACH_IDS = new Set(['overThreshold', 'maxExceeded', 'countOverExceeded'])

const toPosix = p => p.split(sep).join('/')

export function issueTitle(path) { return `${TITLE_PREFIX}${path}` }

export function pathFromTitle(title) {
  return title.startsWith(TITLE_PREFIX) ? title.slice(TITLE_PREFIX.length) : null
}

/** Parse one baseline file's JSON into offender rows. */
export function offendersFromBaseline(json, { root, lang }) {
  return Object.entries(json)
    .filter(([key]) => key !== '__meta__')
    .map(([key, v]) => ({ path: `${root}/${key.replace(/\\/g, '/')}`, lang, max: v.max, countOver: v.countOver }))
}

export function loadOffenders(repoRoot, baselines = BASELINES) {
  const rows = []
  for (const b of baselines) {
    const file = join(repoRoot, b.baseline)
    if (!existsSync(file)) {
      console.warn(`WARN complexity-tickets: baseline ${b.baseline} not found; its files are left out of the report`)
      continue
    }
    rows.push(...offendersFromBaseline(JSON.parse(readFileSync(file, 'utf-8')), b))
  }
  return rows
}

export function rankOffenders(rows) {
  return [...rows].sort((a, b) => b.max - a.max || b.countOver - a.countOver || a.path.localeCompare(b.path))
}

/** ESLint `--format json` output → violations, one per breaching message. */
export function violationsFromEslint(results, repoRoot) {
  const out = []
  for (const r of results) {
    for (const m of r.messages ?? []) {
      if (m.ruleId !== ESLINT_RULE || !ESLINT_BREACH_IDS.has(m.messageId)) continue
      out.push({ path: toPosix(relative(repoRoot, r.filePath)), detail: m.message })
    }
  }
  return out
}

/** Test-ComplexityBudget result ({ root, violations }) → violations. */
export function violationsFromPs({ root, violations }) {
  return (violations ?? []).map(v => {
    const o = v.Observed ?? {}
    const detail = v.Reason === 'new-offender'
      ? `File complexity max ${o.max} exceeds threshold (file not in baseline).`
      : `File complexity max ${o.max} / countOver ${o.countOver} exceeds baseline max ${v.Baseline?.max} / countOver ${v.Baseline?.countOver}.`
    return { path: `${root}/${String(v.File).replace(/\\/g, '/')}`, detail }
  })
}

/** Merge per-message violations into one entry per file. */
export function groupByPath(violations) {
  const byPath = new Map()
  for (const v of violations) {
    const details = byPath.get(v.path) ?? []
    if (!details.includes(v.detail)) details.push(v.detail)
    byPath.set(v.path, details)
  }
  return [...byPath].map(([path, details]) => ({ path, details }))
}

export function readReports(dir, repoRoot) {
  const violations = []
  if (!existsSync(dir)) {
    console.warn(`WARN complexity-tickets: report dir ${dir} does not exist; no violations to file`)
    return violations
  }
  for (const name of readdirSync(dir, { recursive: true })) {
    const file = join(dir, String(name))
    if (!file.endsWith('.json')) continue
    let json
    try {
      json = JSON.parse(readFileSync(file, 'utf-8'))
    } catch (err) {
      console.warn(`WARN complexity-tickets: skipping unreadable report ${file}: ${err.message}`)
      continue
    }
    if (Array.isArray(json)) violations.push(...violationsFromEslint(json, repoRoot))
    else if (json && Array.isArray(json.violations)) violations.push(...violationsFromPs(json))
    else console.warn(`WARN complexity-tickets: skipping ${file}: neither an ESLint result array nor a PS budget result`)
  }
  return violations
}

export function context(env = process.env) {
  return {
    pr: env.PR_NUMBER || '',
    runUrl: env.RUN_URL || '',
    sha: env.COMMIT_SHA || '',
  }
}

function trigger(ctx) {
  const where = ctx.pr ? `PR #${ctx.pr}` : `commit ${ctx.sha.slice(0, 8) || '(unknown)'}`
  return ctx.runUrl ? `${where} ([run](${ctx.runUrl}))` : where
}

export function newIssueBody({ path, details }, baselineRow, ctx) {
  const current = baselineRow
    ? `Recorded on main: max **${baselineRow.max}**, **${baselineRow.countOver}** function(s) over the threshold of 15.`
    : 'Not in the baseline on main: this is a new over-threshold file.'
  return [
    `\`${path}\` hit the complexity budget in ${trigger(ctx)}:`,
    '',
    ...details.map(d => `- ${d}`),
    '',
    current,
    '',
    'The budget only stops the file getting worse, so whoever touches it next pays the cost.',
    'Refactor it below its recorded numbers (extract functions, split the file), then regenerate',
    'the baseline so the ratchet locks in the gain:',
    '',
    '- TypeScript: `node lib/eslint-rules/generate-complexity-baseline.mjs --root <app>/src`',
    '- PowerShell: `Update-ComplexityBaseline`',
    '',
    `Later hits are added as comments. The weekly \`${REPORT_LABEL}\` job closes this issue`,
    'once the file is no longer in any baseline.',
  ].join('\n')
}

/**
 * One record per PR: every CI run of a PR that still trips the budget would otherwise
 * add a comment. Pushes to main carry no PR number and are always recorded.
 */
export function alreadyRecorded(texts, ctx) {
  if (!ctx.pr) return false
  const marker = new RegExp(`\\bPR #${ctx.pr}\\b`)
  return texts.some(t => marker.test(t))
}

export function repeatComment({ details }, ctx) {
  return [`Hit the budget again in ${trigger(ctx)}:`, '', ...details.map(d => `- ${d}`)].join('\n')
}

export function reportBody(rows, { top, refactorIssues, date }) {
  const issueFor = new Map(refactorIssues.map(i => [pathFromTitle(i.title), i.number]))
  const byArea = new Map()
  for (const r of rows) {
    const area = r.path.split('/')[0]
    byArea.set(area, (byArea.get(area) ?? 0) + 1)
  }
  // One table per language: PowerShell maxima run an order of magnitude above
  // TypeScript's, so a single ranking would never surface a TypeScript file.
  const tables = [...new Set(rows.map(r => r.lang))].sort().flatMap(lang => {
    const ranked = rankOffenders(rows.filter(r => r.lang === lang))
    return [
      `### ${lang}: top ${Math.min(top, ranked.length)} of ${ranked.length} by worst function`,
      '',
      '| # | File | Max | Fns over 15 | Refactor issue |',
      '|---|---|---|---|---|',
      ...ranked.slice(0, top).map((r, i) =>
        `| ${i + 1} | \`${r.path}\` | ${r.max} | ${r.countOver} | ${issueFor.has(r.path) ? `#${issueFor.get(r.path)}` : '—'} |`),
      '',
    ]
  })
  const lines = [
    `Weekly snapshot of every file over the complexity threshold (15), from the baselines on main. Updated ${date}.`,
    '',
    `**${rows.length}** files over threshold: ${[...byArea].map(([a, n]) => `${a} ${n}`).join(', ')}.`,
    '',
    ...tables,
    `Pick from the top. Open \`${REFACTOR_LABEL}\` issues (filed when a PR trips the budget) are linked;`,
    'the job edits this issue in place each week rather than opening a new one.',
  ]
  return lines.join('\n')
}

// ── gh plumbing ──────────────────────────────────────────────────────────────

// t/675: every call is REST through `gh api`. The `gh issue` / `gh pr` subcommands are
// GraphQL-backed and spent the shared GITHUB_TOKEN GraphQL pool on every CI run (t/563#16);
// `gh api repos/...` spends REST core only. `{owner}/{repo}` is filled in by gh from GH_REPO
// or the checkout. The dry-run lines still read `gh issue ...`: they describe the write and
// are kept as they were.
const REPO = 'repos/{owner}/{repo}'
const ghCli = args => execFileSync('gh', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })

/** `run(args)` runs gh and returns its stdout; injectable so tests can record the calls. */
export function makeGh(dryRun, run = ghCli) {
  // A write: the JSON payload goes through a file (--input), so no body text reaches argv.
  const send = (method, path, payload, jq) => {
    const dir = mkdtempSync(join(tmpdir(), 'cx-'))
    const file = join(dir, 'payload.json')
    try {
      writeFileSync(file, JSON.stringify(payload), 'utf-8')
      return run(['api', '-X', method, `${REPO}/${path}`, '--input', file, ...(jq ? ['--jq', jq] : [])])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // A paged read: --jq prints one JSON value per line across every page.
  const readLines = (path, fields, jq) => String(run(['api', '-X', 'GET', '--paginate', `${REPO}/${path}`, ...fields.flatMap(f => ['-f', f]), '--jq', jq]))
    .split('\n').filter(Boolean).map(l => JSON.parse(l))
  const withBody = (shown, body, write) => {
    if (dryRun) { console.log(`[dry-run] gh ${shown.join(' ')}\n${body}\n`); return '' }
    return write()
  }
  return {
    /** Open issues with the label, newest first (the issues endpoint also returns PRs; they are dropped). */
    list(label) {
      try {
        return readLines('issues', ['state=open', `labels=${label}`, 'per_page=100'], '.[] | select(.pull_request == null) | {number, title} | @json')
      } catch (err) {
        if (!dryRun) throw err
        console.warn(`WARN complexity-tickets: gh issue list failed in dry-run, treating as no open issues: ${err.message}`)
        return []
      }
    },
    ensureLabel(label, color, description) {
      if (dryRun) return
      try { send('POST', 'labels', { name: label, color, description }) }
      catch (err) {
        // gh api prints the 422 body ("code":"already_exists") on stdout.
        const msg = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message}`
        if (!/already.exists/i.test(msg)) console.warn(`WARN complexity-tickets: could not create label ${label}; issue writes may fail: ${msg.trim()}`)
      }
    },
    create: (title, label, body) => withBody(['issue', 'create', '--title', title, '--label', label], body,
      () => send('POST', 'issues', { title, labels: [label], body }, '.html_url')).trim(),
    comment: (n, body) => withBody(['issue', 'comment', String(n)], body, () => send('POST', `issues/${n}/comments`, { body })),
    edit: (n, body) => withBody(['issue', 'edit', String(n)], body, () => send('PATCH', `issues/${n}`, { body })),
    /** Comment, then close as completed (what `gh issue close --reason completed --comment` did). */
    close(n, text) {
      if (dryRun) { console.log(`[dry-run] gh issue close ${n}: ${text}`); return }
      send('POST', `issues/${n}/comments`, { body: text })
      send('PATCH', `issues/${n}`, { state: 'closed', state_reason: 'completed' })
    },
    /** Issue body + all comment bodies, for "already recorded?" checks. */
    texts(n) {
      try {
        const body = JSON.parse(run(['api', '-X', 'GET', `${REPO}/issues/${n}`, '--jq', '.body | @json']))
        const comments = readLines(`issues/${n}/comments`, ['per_page=100'], '.[] | .body | @json')
        return [body ?? '', ...comments.map(c => c ?? '')]
      } catch (err) {
        console.warn(`WARN complexity-tickets: could not read #${n}; commenting without the duplicate check: ${err.message}`)
        return []
      }
    },
  }
}

export function fileViolations({ dir, repoRoot, dryRun, run }) {
  const files = groupByPath(readReports(dir, repoRoot))
  if (files.length === 0) { console.log('No complexity-budget violations reported; nothing to file.'); return }
  const gh = makeGh(dryRun, run)
  gh.ensureLabel(REFACTOR_LABEL, 'D93F0B', 'File is over its complexity budget; refactor it below baseline')
  const open = new Map(gh.list(REFACTOR_LABEL).map(i => [i.title, i.number]))
  const baseline = new Map(loadOffenders(repoRoot).map(r => [r.path, r]))
  const ctx = context()
  for (const f of files) {
    const title = issueTitle(f.path)
    const existing = open.get(title)
    if (existing) {
      if (alreadyRecorded(gh.texts(existing), ctx)) {
        console.log(`${f.path}: #${existing} already records PR #${ctx.pr}; not commenting again`)
        continue
      }
      gh.comment(existing, repeatComment(f, ctx))
      console.log(`${f.path}: commented on #${existing}`)
    } else {
      const url = gh.create(title, REFACTOR_LABEL, newIssueBody(f, baseline.get(f.path), ctx))
      console.log(`${f.path}: opened ${url || '(dry-run)'}`)
    }
  }
}

export function report({ repoRoot, top, dryRun, run }) {
  const rows = loadOffenders(repoRoot)
  const gh = makeGh(dryRun, run)
  gh.ensureLabel(REPORT_LABEL, '5319E7', 'Weekly complexity-budget offender report')
  gh.ensureLabel(REFACTOR_LABEL, 'D93F0B', 'File is over its complexity budget; refactor it below baseline')

  const offenderPaths = new Set(rows.map(r => r.path))
  const refactorIssues = gh.list(REFACTOR_LABEL)
  for (const i of refactorIssues) {
    const path = pathFromTitle(i.title)
    if (path && !offenderPaths.has(path)) {
      gh.close(i.number, `\`${path}\` is no longer in any complexity baseline on main (at or under the threshold, or removed). Closing.`)
      console.log(`${path}: closed #${i.number}`)
    }
  }
  const stillOpen = refactorIssues.filter(i => offenderPaths.has(pathFromTitle(i.title)))

  const body = reportBody(rows, { top, refactorIssues: stillOpen, date: new Date().toISOString().slice(0, 10) })
  const [existing] = gh.list(REPORT_LABEL)
  if (existing) { gh.edit(existing.number, body); console.log(`Report: updated #${existing.number}`) }
  else { console.log(`Report: opened ${gh.create(REPORT_TITLE, REPORT_LABEL, body) || '(dry-run)'}`) }
}

function parseArgs(argv) {
  const [mode, ...rest] = argv
  const opts = { mode, dryRun: false, top: 25, dir: 'complexity-reports' }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dry-run') opts.dryRun = true
    else if (rest[i] === '--top') opts.top = Number(rest[++i])
    else if (rest[i] === '--dir') opts.dir = rest[++i]
    else throw new Error(`unknown argument: ${rest[i]}`)
  }
  return opts
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = parseArgs(process.argv.slice(2))
  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd()
  if (opts.mode === 'report') report({ repoRoot, top: opts.top, dryRun: opts.dryRun })
  else if (opts.mode === 'file-violations') fileViolations({ dir: opts.dir, repoRoot, dryRun: opts.dryRun })
  else {
    console.error('usage: complexity-tickets.mjs <report|file-violations> [--dir D] [--top N] [--dry-run]')
    process.exit(2)
  }
}
