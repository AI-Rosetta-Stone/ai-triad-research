import { spawn, execFileSync, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { type Baseline, executeCommit, planCommit, snapshotDirty } from './commitScope';

export interface StepDefinition {
  id: string;
  name: string;
  description: string;
  phase: string;
  canSkip: boolean;
  requiresConfig: boolean;
  /**
   * Data-repo paths (directories or files, relative to the data root) this step writes.
   * `[]` = read-only. The single source of the commit's allowed surfaces (t/3894 fix D):
   * a path changed during the run outside the union of the ran steps' `writes` refuses
   * the commit. Under-declaring refuses a legitimate commit (loud); over-declaring only
   * widens what D can't see, so list what the cmdlet actually writes and no more.
   */
  writes: string[];
}

// Data-repo write paths per cmdlet, as the workflow invokes them (mapped 2026-10-04 for
// t/3894 from scripts/AITriad). Writes to the sources repo and the code repo are not listed:
// they are outside the data repo this commit covers. Not listed on purpose: data-root
// ai-call-log.jsonl (only when AI_CALL_LOG_ENABLED is set) — per-machine telemetry, so a run
// with it enabled is refused by D, naming the file, rather than committing it.
const POV_FILES = ['accelerationist', 'safetyist', 'skeptic', 'situations'].map(p => `taxonomy/Origin/${p}.json`);
const SUMMARIZE_WRITES = [
  'summaries',
  'qbaf-conflicts', // one analysis per summarized doc (Invoke-QbafConflictAnalysis)
  'calibration/core/extraction-metrics.jsonl',
  'taxonomy/Origin/policy_actions.json', // Update-PolicyRegistry -Fix
  ...POV_FILES, // when unassigned policy actions get new policy_ids
];
const QUEUE_FILE = '.summarise-queue.json';

export const PIPELINE_STEPS: StepDefinition[] = [
  {
    id: 'import',
    name: 'Import Documents',
    description: 'Ingest new PDFs, web articles, or process the inbox folder',
    phase: 'Ingest',
    canSkip: false,
    requiresConfig: true,
    writes: [QUEUE_FILE, ...SUMMARIZE_WRITES],
  },
  {
    id: 'summarize',
    name: 'Generate Summaries',
    description: 'Extract key points, factual claims, and unmapped concepts per POV',
    phase: 'Summarize',
    canSkip: false,
    requiresConfig: false,
    writes: SUMMARIZE_WRITES,
  },
  {
    id: 'conflicts',
    name: 'Detect Conflicts',
    description: 'Find cross-POV disagreements on factual claims',
    phase: 'Summarize',
    canSkip: true,
    requiresConfig: false,
    writes: ['qbaf-conflicts'],
  },
  {
    id: 'health',
    name: 'Taxonomy Health Check',
    description: 'Analyze orphan nodes, coverage balance, and unmapped concepts',
    phase: 'Analyze',
    canSkip: true,
    requiresConfig: false,
    writes: [],
  },
  {
    id: 'proposals',
    name: 'Generate Proposals',
    description: 'AI-generated taxonomy improvements: NEW, SPLIT, MERGE, RELABEL',
    phase: 'Improve',
    canSkip: true,
    requiresConfig: false,
    writes: [] /* writes the code repo's taxonomy/proposals/, not the data repo */,
  },
  {
    id: 'review',
    name: 'Review Proposals',
    description: 'Approve or reject each taxonomy change proposal',
    phase: 'Improve',
    canSkip: true,
    requiresConfig: false,
    writes: POV_FILES,
  },
  {
    id: 'integrity',
    name: 'Validate Integrity',
    description: 'Check all node references, edges, policy IDs, and embeddings',
    phase: 'Validate',
    canSkip: false,
    requiresConfig: false,
    writes: [] /* read-only without -Repair */,
  },
  {
    id: 'backfill',
    name: 'Backfill Resolved Concepts',
    description: 'Create key_point entries for resolved unmapped concepts that lack evidence trails',
    phase: 'Validate',
    canSkip: true,
    requiresConfig: false,
    writes: ['summaries'],
  },
  {
    id: 'attributes',
    name: 'Extract Attributes',
    description: 'Enrich nodes with epistemic type, rhetorical strategy, and more',
    phase: 'Enrich',
    canSkip: true,
    requiresConfig: false,
    writes: POV_FILES,
  },
  {
    id: 'lineage',
    name: 'Update Lineage',
    description: 'Populate, normalize, and enrich intellectual lineage with descriptions and validated URLs',
    phase: 'Enrich',
    canSkip: true,
    requiresConfig: false,
    writes: ['calibration/core/lineage-enrichments.json', ...POV_FILES],
  },
  {
    id: 'steelman',
    name: 'Populate Steelman',
    description: 'Generate steelman arguments and vulnerability analysis for each taxonomy node',
    phase: 'Enrich',
    canSkip: true,
    requiresConfig: false,
    writes: POV_FILES.filter(f => !f.endsWith('situations.json')),
  },
  {
    id: 'embeddings',
    name: 'Update Embeddings',
    description: 'Regenerate 384-dim sentence embeddings for all taxonomy nodes',
    phase: 'Enrich',
    canSkip: true,
    requiresConfig: false,
    writes: ['taxonomy/Origin/embeddings.json'],
  },
  {
    id: 'edges',
    name: 'Discover Edges',
    description: 'Propose typed, directed relationships between taxonomy nodes',
    phase: 'Enrich',
    canSkip: true,
    requiresConfig: false,
    writes: ['taxonomy/Origin/edges.json', 'taxonomy/Origin/edge_discovery_log.json'],
  },
  {
    id: 'git-commit',
    name: 'Commit Changes',
    description: 'Stage and commit all data changes to the local git repository',
    phase: 'Publish',
    canSkip: false,
    requiresConfig: true,
    writes: [],
  },
  {
    id: 'git-push',
    name: 'Push to GitHub',
    description: 'Push committed changes to the remote repository',
    phase: 'Publish',
    canSkip: true,
    requiresConfig: false,
    writes: [],
  },
];

export function getProjectRoot(): string {
  // __dirname is workflow-app/dist/main → go up three levels to repo root
  return path.resolve(__dirname, '..', '..', '..');
}

export function getDataRoot(): string {
  const projectRoot = getProjectRoot();
  const configPath = path.join(projectRoot, '.aitriad.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const resolved = path.resolve(projectRoot, config.data_root);
    if (fs.existsSync(resolved)) return resolved;
  } catch { /* fall through */ }

  if (process.env.AI_TRIAD_DATA_ROOT) {
    return process.env.AI_TRIAD_DATA_ROOT;
  }

  return path.resolve(projectRoot, '..', 'ai-triad-data');
}

function getPowerShellCommand(): string {
  return 'pwsh';
}

/** workflow-app's own version, for the `Tool:` commit trailer. Best-effort; never throws. */
function getToolVersion(): string {
  try {
    const pkgPath = path.join(getProjectRoot(), 'workflow-app', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface CommitProvenance {
  /** Steps that ran since the baseline (main-process record, not renderer-supplied). */
  steps: string[];
  /** Union of those steps' declared `writes`. */
  surfaces: string[];
  runId?: string;
  commitSummary?: string;
  /** ISO time the run's baseline was taken (t/3894#6 condition). */
  baselineAt: string;
}

/**
 * Self-describing subject + provenance trailers (data-repo CONTRIBUTING.md §3). Pure.
 * Refuses (throws) when no data-producing step ran — t/3894 fix A: that is exactly how
 * f9cb8ef4 (09-29) committed 78 files (~1.2M lines) of other writers' work as
 * "pipeline(adhoc)". Do not relax this to a warning.
 */
export function buildCommitMessage(p: CommitProvenance): string {
  if (p.steps.length === 0) {
    throw new Error(
      'Refusing to commit: no data-producing pipeline step ran in this run, so anything changed now '
      + 'was written by someone else (other agents, the editor, stray files in the shared data checkout). '
      + 'Run the steps that produce the data, then commit; or commit by hand with an explicit pathspec '
      + '(data-repo CONTRIBUTING.md section 5). (t/3894)',
    );
  }
  const triggeredBy = process.env.ORCA_AGENT_ID
    ? `agent:${process.env.ORCA_AGENT_ID}`
    : `user:${os.userInfo().username}`;
  // workflowName: '+'-joined step set, truncated ~40 chars (TL t/1333#2); full list in `Steps:`.
  let workflowName = p.steps.join('+');
  if (workflowName.length > 40) workflowName = `${p.steps[0]}+${p.steps.length - 1}-more`;
  return [
    `pipeline(${workflowName}): ${p.commitSummary || 'automated data pipeline update'}`,
    '',
    `Run-Id: ${p.runId || 'no-run-id'}`,
    `Triggered-By: ${triggeredBy}`,
    `Surfaces: ${p.surfaces.join(', ')}`,
    `Steps: ${p.steps.join(', ')}`,
    `Baseline-At: ${p.baselineAt}`,
    `Tool: workflow-app v${getToolVersion()}`,
  ].join('\n');
}

function buildPsCommand(stepId: string, config: Record<string, unknown>): string {
  const projectRoot = getProjectRoot().replace(/\\/g, '/');
  const moduleImport = `Import-Module '${projectRoot}/scripts/AITriad/AITriad.psm1' -Force -ErrorAction Stop`;

  switch (stepId) {
    case 'import': {
      const mode = config.importMode as string;
      if (mode === 'inbox') {
        return `${moduleImport}; Import-AITriadDocument -Inbox -Verbose`;
      }
      if (mode === 'url') {
        const url = config.url as string;
        const pov = config.pov as string;
        let cmd = `${moduleImport}; Import-AITriadDocument -Url '${url}'`;
        if (pov) cmd += ` -Pov '${pov}'`;
        cmd += ' -Verbose';
        return cmd;
      }
      const files = config.files as string[];
      if (!files || files.length === 0) throw new Error('No files selected');
      const pov = config.pov as string;
      const commands = files.map(f => {
        let cmd = `Import-AITriadDocument -File '${f.replace(/'/g, "''")}'`;
        if (pov) cmd += ` -Pov '${pov}'`;
        cmd += ' -Verbose';
        return cmd;
      });
      return `${moduleImport}; ${commands.join('; ')}`;
    }
    case 'summarize': {
      let cmd = `${moduleImport}; Invoke-BatchSummary -Verbose`;
      if (config.importedToday) cmd += ' -ImportedToday';
      return cmd;
    }
    case 'conflicts':
      return `${moduleImport}; Invoke-QbafConflictAnalysis -Verbose`;
    case 'health':
      return `${moduleImport}; Get-TaxonomyHealth`;
    case 'proposals':
      return `${moduleImport}; Invoke-TaxonomyProposal -Verbose`;
    case 'review': {
      const proposalPath = config.proposalPath as string;
      if (!proposalPath) throw new Error('No proposal file selected');
      return `${moduleImport}; Approve-TaxonomyProposal -Path '${proposalPath.replace(/'/g, "''")}' -ApproveAll -Verbose`;
    }
    case 'integrity':
      return `${moduleImport}; Test-TaxonomyIntegrity -Verbose`;
    case 'backfill':
      return `${moduleImport}; Repair-ResolvedBackfill -Verbose`;
    case 'embeddings':
      return `${moduleImport}; Update-TaxEmbeddings -AutoCommit:$false -Verbose`;
    case 'edges':
      return `${moduleImport}; Invoke-EdgeDiscovery -Verbose`;
    case 'attributes':
      return `${moduleImport}; Invoke-AttributeExtraction -Verbose`;
    case 'lineage':
      return `${moduleImport}; Repair-PovLineage -Verbose`;
    case 'steelman':
      return `${moduleImport}; Repair-PovAttributes -Priority critical -Verbose`;
    case 'git-push':
      // t/683: the push runs in-process (runGitPush), never as a shell string.
      throw new Error('git-push runs in-process (t/683), not as a PowerShell step');
    default:
      throw new Error(`Unknown step: ${stepId}`);
  }
}

let activeProcess: ChildProcess | null = null;

// Tracks whether embeddings.json was written this pipeline run without a
// following git-commit. Used to auto-restore on abort/quit (t/2753 Fix 2).
let embeddingsWritten = false;
let gitCommitAttempted = false;
let gitCommitDone = false;

// t/3894 C+D run record: the data checkout's dirty state before the first data-producing
// step since the last successful commit, and the steps that ran since. Main-process state,
// so a lone git-commit (the f9cb8ef4 shape) or an app restart mid-run has no baseline and
// is refused. Cleared only by a successful commit.
let runBaseline: Baseline | null = null;
const stepsSinceBaseline: string[] = [];

function stepWrites(stepId: string): string[] {
  return PIPELINE_STEPS.find(s => s.id === stepId)?.writes ?? [];
}

/** Take the baseline before the run's first data-producing step; record every such step. */
export function recordDataStep(stepId: string, dataRoot: string): void {
  if (stepWrites(stepId).length === 0) return;
  if (!runBaseline) runBaseline = { takenAt: new Date().toISOString(), entries: snapshotDirty(dataRoot) };
  if (!stepsSinceBaseline.includes(stepId)) stepsSinceBaseline.push(stepId);
}

/**
 * The git-commit step, run in-process rather than as a PowerShell string: commit exactly
 * the paths this run changed (C), only under the ran steps' declared surfaces (D). Any
 * refusal fails the step with the reason in the error log. Never stages with -A/a directory.
 */
export function runGitCommit(
  dataRoot: string,
  config: Record<string, unknown>,
  onData: (text: string) => void,
  onError: (text: string) => void,
): { exitCode: number } {
  try {
    const surfaces = Array.from(new Set(stepsSinceBaseline.flatMap(stepWrites)));
    const message = buildCommitMessage({
      steps: [...stepsSinceBaseline],
      surfaces,
      runId: config.runId as string | undefined,
      commitSummary: (config.commitSummary as string) || (config.commitMessage as string),
      baselineAt: runBaseline?.takenAt ?? '',
    });
    const plan = planCommit(runBaseline, snapshotDirty(dataRoot), surfaces);
    if (!plan.ok) {
      onError(`${plan.reason}\n`);
      return { exitCode: 1 };
    }
    for (const w of plan.warnings) onData(`WARNING: ${w}\n`);
    onData(`Committing ${plan.paths.length} file(s) changed during this run:\n${plan.paths.map(p => `  ${p}`).join('\n')}\n\n`);
    onData(executeCommit(dataRoot, plan.paths, message));
    pipelineCommits.add(gitOut(dataRoot, ['rev-parse', 'HEAD']).trim());
    runBaseline = null;
    stepsSinceBaseline.length = 0;
    return { exitCode: 0 };
  } catch (err) {
    onError(`${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 1 };
  }
}

// t/683: SHAs of commits this pipeline process made (runGitCommit). Main-process memory only,
// so a commit from before a restart is not in it, and the push refuses it (fail closed).
const pipelineCommits = new Set<string>();

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

export interface OutgoingCommit { sha: string; paths: string[] }

/**
 * PURE (t/683). May these outgoing commits be pushed? Every one must be a commit this pipeline
 * made, and every path it touches must lie under a surface a step declares. Otherwise refuse,
 * naming the commits and paths.
 */
export function planPush(outgoing: OutgoingCommit[], ownShas: ReadonlySet<string>, surfaces: readonly string[]): { ok: true } | { ok: false; reason: string } {
  const foreign = outgoing.filter(c => !ownShas.has(c.sha));
  if (foreign.length > 0) {
    const lines = foreign.map(c => `  ${c.sha.slice(0, 12)}: ${c.paths.join(', ') || '(no paths)'}`);
    return { ok: false, reason: `Refusing to push: ${foreign.length} local commit(s) were not made by this pipeline run:\n${lines.join('\n')}\nOnly the pipeline's own commits are pushed (t/683, t/651).` };
  }
  const outside: string[] = [];
  for (const c of outgoing) {
    for (const p of c.paths) {
      const inside = surfaces.some(sf => {
        const dir = sf.endsWith('/') ? sf : sf + '/';
        return p === sf || p.startsWith(dir);
      });
      if (!inside) outside.push(`${c.sha.slice(0, 12)} ${p}`);
    }
  }
  if (outside.length > 0) {
    return { ok: false, reason: `Refusing to push: pipeline commits touch paths outside the declared surfaces:\n  ${outside.join('\n  ')}` };
  }
  return { ok: true };
}

/**
 * The push step, in-process (t/683). Pushes only commits this pipeline made, after checking each
 * commit's paths. A bare `git push` would publish every local commit on the branch, including an
 * Electron auto-commit of user content. Fails closed: no upstream means refuse.
 */
export function runGitPush(
  dataRoot: string,
  onData: (text: string) => void,
  onError: (text: string) => void,
  /** Test seam: runs after the check, before the push. Not used by the app. */
  afterCheck?: () => void,
): { exitCode: number } {
  try {
    // The SHA the check covers. The push names it explicitly, so a commit made after
    // this point (an electron-auto commit) is not published (Security, t/683).
    let upstream: string;
    try {
      upstream = gitOut(dataRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim();
    } catch {
      onError('Refusing to push: the data branch has no upstream, so its outgoing commits cannot be checked (t/683).\n');
      return { exitCode: 1 };
    }
    const slash = upstream.indexOf('/');
    if (slash <= 0) {
      onError(`Refusing to push: upstream "${upstream}" is not remote/branch (t/683).\n`);
      return { exitCode: 1 };
    }
    const remote = upstream.slice(0, slash);
    const branch = upstream.slice(slash + 1);
    const checkedSha = gitOut(dataRoot, ['rev-parse', 'HEAD']).trim();
    const shas = gitOut(dataRoot, ['rev-list', '--reverse', `${upstream}..${checkedSha}`]).split('\n').map(x => x.trim()).filter(Boolean);
    if (shas.length === 0) {
      onData('Nothing to push.\n');
      return { exitCode: 0 };
    }
    const outgoing: OutgoingCommit[] = shas.map(sha => ({
      sha,
      paths: gitOut(dataRoot, ['show', '--name-only', '--format=', sha]).split('\n').map(x => x.trim()).filter(Boolean),
    }));
    const surfaces = Array.from(new Set(PIPELINE_STEPS.flatMap(s => s.writes)));
    const plan = planPush(outgoing, pipelineCommits, surfaces);
    if (!plan.ok) {
      onError(`${plan.reason}\n`);
      return { exitCode: 1 };
    }
    afterCheck?.();
    onData(`Pushing ${outgoing.length} pipeline commit(s) up to ${checkedSha.slice(0, 12)}.\n`);
    onData(gitOut(dataRoot, ['push', remote, `${checkedSha}:refs/heads/${branch}`]));
    return { exitCode: 0 };
  } catch (err) {
    onError(`${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 1 };
  }
}

/** Test seam: forget the run record. */
export function resetPipelineState(): void {
  embeddingsWritten = false;
  gitCommitAttempted = false;
  gitCommitDone = false;
  runBaseline = null;
  stepsSinceBaseline.length = 0;
  pipelineCommits.clear();
}

/**
 * Restores embeddings.json to HEAD in the data repo if the embeddings step
 * completed but git-commit was never attempted. Call on pipeline cancel/app quit.
 * Does nothing if git-commit was attempted (user should retry commit, not lose data).
 * Never throws.
 */
export function restoreEmbeddingsIfAbandoned(): boolean {
  if (!embeddingsWritten || gitCommitAttempted) return false;
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    const dataRoot = getDataRoot();
    execSync('git restore taxonomy/Origin/embeddings.json', { cwd: dataRoot, windowsHide: true });
    console.warn('[pipeline] restoreEmbeddingsIfAbandoned: restored embeddings.json to HEAD (embeddings ran, git-commit never attempted)');
    embeddingsWritten = false;
    return true;
  } catch (err) {
    console.warn('[pipeline] restoreEmbeddingsIfAbandoned: git restore failed (may already be clean):', err);
    return false;
  }
}

export function runStep(
  stepId: string,
  config: Record<string, unknown>,
  onData: (text: string) => void,
  onError: (text: string) => void,
): Promise<{ exitCode: number }> {
  // Reset state at the start of a fresh embeddings run so prior abandoned state
  // doesn't carry over when the user reruns embeddings without committing.
  if (stepId === 'embeddings') {
    embeddingsWritten = false;
    gitCommitAttempted = false;
    gitCommitDone = false;
  }
  if (stepId === 'git-commit') {
    gitCommitAttempted = true;
    const result = runGitCommit(getDataRoot(), config, onData, onError);
    if (result.exitCode === 0) gitCommitDone = true;
    return Promise.resolve(result);
  }
  if (stepId === 'git-push') {
    return Promise.resolve(runGitPush(getDataRoot(), onData, onError));
  }

  return new Promise((resolve, reject) => {
    try {
      // Before spawning: a step that fails partway may still have written, so it counts.
      recordDataStep(stepId, getDataRoot());
      const psCommand = buildPsCommand(stepId, config);
      const shell = getPowerShellCommand();

      const args = ['-NoProfile', '-NonInteractive', '-Command', psCommand];

      onData(`> ${shell} -Command "${stepId}"\n`);
      onData(`${psCommand}\n\n`);

      const child = spawn(shell, args, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      activeProcess = child;

      child.stdout?.on('data', (chunk: Buffer) => {
        onData(chunk.toString('utf-8'));
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        if (text.startsWith('VERBOSE:') || text.startsWith('WARNING:')) {
          onData(text);
        } else {
          onError(text);
        }
      });

      child.on('close', (code) => {
        activeProcess = null;
        const exitCode = code ?? 1;
        if (stepId === 'embeddings' && exitCode === 0) embeddingsWritten = true;
        resolve({ exitCode });
      });

      child.on('error', (err) => {
        activeProcess = null;
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

export function cancelStep(): void {
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = null;
  }
}

export function getGitStatus(): { summary: string; hasChanges: boolean } {
  const dataRoot = getDataRoot();
  try {
    const { execSync } = require('child_process');
    const status = execSync('git status --porcelain', { cwd: dataRoot, encoding: 'utf-8', windowsHide: true });
    const lines = status.trim().split('\n').filter((l: string) => l.trim());
    return {
      summary: status || 'No changes',
      hasChanges: lines.length > 0,
    };
  } catch {
    return { summary: 'Error reading git status', hasChanges: false };
  }
}

export function getGitDiffStat(): string {
  const dataRoot = getDataRoot();
  try {
    const { execSync } = require('child_process');
    const diff = execSync('git diff --stat HEAD', { cwd: dataRoot, encoding: 'utf-8', windowsHide: true });
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: dataRoot, encoding: 'utf-8', windowsHide: true });
    let result = diff || '';
    if (untracked.trim()) {
      result += '\nNew files:\n' + untracked.trim().split('\n').map((f: string) => `  + ${f}`).join('\n');
    }
    return result || 'No changes';
  } catch {
    return 'Error reading git diff';
  }
}

export function listProposalFiles(): string[] {
  const projectRoot = getProjectRoot();
  const proposalDir = path.join(projectRoot, 'taxonomy', 'proposals');
  try {
    if (!fs.existsSync(proposalDir)) return [];
    return fs.readdirSync(proposalDir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(proposalDir, f));
  } catch {
    return [];
  }
}

export function readProposalFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}
