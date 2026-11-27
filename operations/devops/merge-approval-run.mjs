// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/537: the IMPURE half of the `merge-approval` check: reads PR facts from the GitHub API, asks
// merge-approval-verdict.mjs for the verdict, and posts it as a check run with the
// ai-triad-merge-approval App's token. .github/workflows/merge-approval.yml imports this file from
// a checkout of the default branch; no PR code is ever loaded.
//
// ONE CLIENT (t/566, Security p/131#63): appGithub, the App's installation token (checks: write,
// metadata: read). It does EVERY call: the reads (pulls, files, reviews, comments, the merge-queue
// GraphQL read; the App's diagnostic proved all return 200, t/537#55), GET /installation/repositories
// (the scope check) and POST check-runs. Reads moved off the shared GITHUB_TOKEN pool that ran dry
// on 2026-11-24. runMergeApproval takes no GITHUB_TOKEN client at all, so a failed App read can only
// fail closed (a failure check run and a thrown error), never fall back to GITHUB_TOKEN.
//
// FAIL CLOSED: an API error after the retries (github-retry.mjs) throws. runMergeApproval catches
// it, posts a `failure` check run on the SHA if one is known, and rethrows so the job fails.
// Nothing here ever posts `neutral` or skips a SHA it has started to judge.
//
// SKIP (no post at all) only for a run that is not judging a PR head or a merge group of this
// repo: a plain-issue comment, a PR whose base is not main, a closed PR, a workflow_run from the
// wrong event / a fork / a non-queue branch, or a review relay whose PR head has moved. A skip
// never leaves a `success` behind that it did not compute: it posts nothing.
//
// RACES (no concurrency group shares runs; see merge-approval.yml): after posting on a PR head,
// the run re-reads everything and recomputes. If the verdict or the head changed in the meantime,
// it posts again, up to MAX_PASSES. So the last check run any run leaves on a head was computed
// from facts that were still current after it was posted. A merge group is posted once: its
// queue entries change as soon as it merges, so re-reading would only find it gone.

import { failureVerdict, evaluateGroup, CHECK_NAME } from './merge-approval-verdict.mjs';
import { parseTier } from './t1-approval-guard-predicate.mjs';
import { earliestCheckRunStartMs } from './design-gate.mjs';
import { immediateManifestPaths, packageJsonTargets, scriptsGatePaths } from './gate-file-change.mjs';

export const EXPECTED_INSTALLATION_REPOS = Object.freeze(['AI-Rosetta-Stone/ai-triad-research']);
export const GROUP_RELAY_WORKFLOW = 'merge-approval-group-relay';
export const REVIEW_RELAY_WORKFLOW = 'merge-approval-review-relay';
export const QUEUE_BRANCH_RE = /^gh-readonly-queue\/main\/pr-([0-9]+)-[0-9a-f]{40}$/;
export const PR_FILES_API_CAP = 3000;
export const MAX_PASSES = 3;
const SHA_RE = /^[0-9a-f]{40}$/;

const noRetry = (label, fn) => fn();

function repoOf(context) {
  return { owner: context.repo.owner, repo: context.repo.repo, fullName: `${context.repo.owner}/${context.repo.repo}` };
}

const skip = (reason) => ({ action: 'skip', reason });

/** Every open PR into main whose head is `sha` (all of them share the SHA's check runs). */
export async function openPullRequestsAtHead(github, context, sha, { retry = noRetry } = {}) {
  const { owner, repo } = repoOf(context);
  const list = await retry('repos.listPullRequestsAssociatedWithCommit', () => github.paginate(
    github.rest.repos.listPullRequestsAssociatedWithCommit, { owner, repo, commit_sha: sha, per_page: 100 }));
  return list.filter((p) => p.state === 'open' && p.head?.sha === sha && p.base?.ref === 'main').map((p) => p.number);
}

/**
 * pull_request_target and issue_comment: the PR from the payload, its head from a FRESH pulls.get
 * (never the payload's head, which may be stale). Returns { action: 'evaluate', kind: 'pr', prNumber }
 * or a skip.
 */
export async function resolvePullRequestTarget(github, context, { retry = noRetry } = {}) {
  const { owner, repo } = repoOf(context);
  const p = context.payload ?? {};
  let prNumber = null;
  if (p.pull_request) prNumber = p.pull_request.number;
  else if (p.issue?.pull_request) prNumber = p.issue.number;
  if (!Number.isInteger(prNumber)) return skip('not a pull request event');
  const { data: pr } = await retry('pulls.get', () => github.rest.pulls.get({ owner, repo, pull_number: prNumber }));
  if (pr.state !== 'open') return skip(`#${prNumber} is ${pr.state}`);
  if (pr.base?.ref !== 'main') return skip(`#${prNumber} targets ${pr.base?.ref}, not main`);
  return { action: 'evaluate', kind: 'pr', prNumber, headSha: pr.head.sha };
}

/**
 * workflow_run of the review relay. Accepts only event pull_request_review from this repo, and
 * finds the PR through the API from workflow_run.head_sha: exactly one open PR into main whose
 * head is that SHA. If there is none (the head moved, or the PR is closed), it skips without
 * posting: the push that moved the head starts its own pull_request_target run.
 */
export async function resolveReviewRelay(github, context, { retry = noRetry } = {}) {
  const { fullName } = repoOf(context);
  const wr = context.payload?.workflow_run;
  if (!wr) return skip('no workflow_run in the payload');
  if (wr.name !== REVIEW_RELAY_WORKFLOW) return skip(`workflow_run of ${wr.name}, not ${REVIEW_RELAY_WORKFLOW}`);
  if (wr.event !== 'pull_request_review') return skip(`relay event is ${wr.event}, not pull_request_review`);
  if (wr.head_repository?.full_name !== fullName) return skip(`relay head repository is ${wr.head_repository?.full_name}, not ${fullName}`);
  if (typeof wr.head_sha !== 'string' || !SHA_RE.test(wr.head_sha)) return skip('relay head_sha is not a commit SHA');
  const prs = await openPullRequestsAtHead(github, context, wr.head_sha, { retry });
  if (prs.length === 0) return skip(`no open PR into main has head ${wr.head_sha.slice(0, 9)} (the head moved or the PR closed)`);
  // Several PRs at one head: they share the head's check runs, and the PR path judges all of
  // them together, so any one of them is a correct entry point.
  return { action: 'evaluate', kind: 'pr', prNumber: Math.min(...prs), headSha: wr.head_sha, requireHead: wr.head_sha };
}

/**
 * PURE. Security's three conditions on the merge-group relay's workflow_run, plus the relay's
 * name and a well-formed SHA. Returns { ok: true, headSha, branchPr } or { ok: false, reason }.
 */
export function mergeGroupConditions(context) {
  const { fullName } = repoOf(context);
  const wr = context.payload?.workflow_run;
  const no = (reason) => ({ ok: false, reason });
  if (!wr) return no('no workflow_run in the payload');
  if (wr.name !== GROUP_RELAY_WORKFLOW) return no(`workflow_run of ${wr.name}, not ${GROUP_RELAY_WORKFLOW}`);
  if (wr.event !== 'merge_group') return no(`relay event is ${wr.event}, not merge_group`);
  if (wr.head_repository?.full_name !== fullName) return no(`relay head repository is ${wr.head_repository?.full_name}, not ${fullName}`);
  const m = QUEUE_BRANCH_RE.exec(String(wr.head_branch ?? ''));
  if (!m) return no(`relay head branch ${JSON.stringify(wr.head_branch)} is not a main merge-queue branch`);
  if (typeof wr.head_sha !== 'string' || !SHA_RE.test(wr.head_sha)) return no('relay head_sha is not a commit SHA');
  return { ok: true, headSha: wr.head_sha, branchPr: Number(m[1]) };
}

/**
 * workflow_run of the merge-group relay (Security's conditions, t/537). Reads nothing from the
 * relay run except the event's own workflow_run fields: no outputs, artifacts or logs.
 *   - workflow_run.event === 'merge_group'
 *   - workflow_run.head_repository.full_name === this repo
 *   - workflow_run.head_branch matches ^gh-readonly-queue/main/pr-[0-9]+-[0-9a-f]{40}$
 * Then reads main's merge queue by GraphQL and finds exactly one entry whose headCommit is
 * workflow_run.head_sha (0 or more than 1 is a failure), and judges that PR and every entry ahead
 * of it, because a group commit contains all of them.
 */
export async function resolveMergeGroup(github, context, { retry = noRetry } = {}) {
  const { owner, repo } = repoOf(context);
  const cond = mergeGroupConditions(context);
  if (!cond.ok) return skip(cond.reason);
  const { headSha, branchPr } = cond;

  const query = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){mergeQueue(branch:"main"){' +
    'entries(first:100){totalCount pageInfo{hasNextPage} nodes{position headCommit{oid} pullRequest{number headRefOid}}}}}}';
  const data = await retry('graphql mergeQueue', () => github.graphql(query, { owner, name: repo }));
  const entries = data?.repository?.mergeQueue?.entries;
  if (!entries || !Array.isArray(entries.nodes)) return { action: 'fail', headSha, reason: 'the merge queue for main could not be read' };
  const matches = entries.nodes.filter((n) => n?.headCommit?.oid === headSha);
  if (matches.length !== 1) {
    const more = entries.pageInfo?.hasNextPage ? ' (the queue has more than 100 entries; only the first 100 were read)' : '';
    return { action: 'fail', headSha, reason: `${matches.length} merge-queue entries have head commit ${headSha.slice(0, 9)}; exactly 1 is required${more}` };
  }
  const entry = matches[0];
  if (entry.pullRequest?.number !== branchPr) {
    return { action: 'fail', headSha, reason: `the queue entry at ${headSha.slice(0, 9)} is #${entry.pullRequest?.number}, but the queue branch names #${branchPr}` };
  }
  const members = entries.nodes
    .filter((n) => Number.isInteger(n?.position) && n.position <= entry.position)
    .sort((a, b) => a.position - b.position);
  if (members.some((n) => !Number.isInteger(n.pullRequest?.number) || !SHA_RE.test(String(n.pullRequest?.headRefOid ?? '')))) {
    return { action: 'fail', headSha, reason: 'a merge-queue entry ahead of this group has no readable PR number or head' };
  }
  return {
    action: 'evaluate', kind: 'group', headSha, position: entry.position,
    members: members.map((n) => ({ number: n.pullRequest.number, headRefOid: n.pullRequest.headRefOid, position: n.position })),
  };
}

/** Routes an event to its resolver. */
export async function resolveTarget(github, context, deps = {}) {
  if (context.eventName === 'pull_request_target' || context.eventName === 'issue_comment') return resolvePullRequestTarget(github, context, deps);
  if (context.eventName === 'workflow_run') {
    const ev = context.payload?.workflow_run?.event;
    if (ev === 'merge_group') return resolveMergeGroup(github, context, deps);
    if (ev === 'pull_request_review') return resolveReviewRelay(github, context, deps);
    return skip(`workflow_run from a ${ev} run is not a relay event`);
  }
  return skip(`event ${context.eventName} is not handled`);
}

/**
 * The App must be installed on this repository and nothing else. Run on every evaluation; the
 * result goes in the summary, and anything but exactly EXPECTED_INSTALLATION_REPOS fails the check.
 * Needs a token minted for the whole installation (owner set, no repositories filter), or the
 * answer would only echo the token's own repository list.
 */
export async function checkInstallationScope(appGithub, { retry = noRetry, expected = EXPECTED_INSTALLATION_REPOS } = {}) {
  try {
    const repos = await retry('GET /installation/repositories', () => appGithub.paginate('GET /installation/repositories', { per_page: 100 }));
    const names = (Array.isArray(repos) ? repos : []).map((r) => r?.full_name).sort();
    const ok = names.length === expected.length && names.every((n, i) => n === [...expected].sort()[i]);
    return ok
      ? { ok: true, detail: `installed on ${names.join(', ')} only` }
      : { ok: false, detail: `installed on [${names.join(', ')}], expected exactly [${expected.join(', ')}]` };
  } catch (err) {
    return { ok: false, detail: `could not list the installation's repositories (${String(err?.message ?? err).split('\n')[0]})` };
  }
}

/** Creates the `merge-approval` check run, completed, on exactly `headSha`, with the App token. */
export async function postCheck(appGithub, context, headSha, verdict, { retry = noRetry } = {}) {
  if (typeof headSha !== 'string' || !SHA_RE.test(headSha)) throw new Error(`postCheck: ${JSON.stringify(headSha)} is not a commit SHA`);
  if (verdict?.conclusion !== 'success' && verdict?.conclusion !== 'failure') throw new Error(`postCheck: conclusion ${verdict?.conclusion} is not success or failure`);
  const { owner, repo } = repoOf(context);
  const summary = String(verdict.summary ?? '').slice(0, 65000);
  const { data } = await retry('checks.create', () => appGithub.rest.checks.create({
    owner, repo, name: CHECK_NAME, head_sha: headSha, status: 'completed', conclusion: verdict.conclusion,
    output: { title: String(verdict.title ?? CHECK_NAME).slice(0, 255), summary },
  }));
  return data;
}

/**
 * t/559: the package.json paths of this PR whose `scripts` changed, or that cannot be read or parsed at the merge base or head
 * (a gate change). Reads each side through the API; the decision is gate-file-change.mjs's scriptsGatePaths, shared with
 * enqueue-pr.mjs. When nothing is read (no package.json changed) nothing is asked of the API. Any failure to find the merge base is
 * unreadable for every changed package.json (fail closed).
 */
export async function readScriptsGatePaths({ github, retry = noRetry, owner, repo, pr, files }) {
  const targets = packageJsonTargets(files);
  const immediate = immediateManifestPaths(files);
  if (targets.length === 0) return immediate;
  const side = async (path, ref) => {
    try {
      const { data } = await retry(`repos.getContent ${path}`, () => github.rest.repos.getContent({ owner, repo, path, ref, mediaType: { format: 'raw' } }));
      return typeof data === 'string' ? { text: data } : { error: new Error('the content was not text') };
    } catch (err) {
      return err?.status === 404 ? { missing: true } : { error: err };
    }
  };
  try {
    const { data: cmp } = await retry('repos.compareCommitsWithBasehead', () => github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${pr.base.ref}...${pr.head.sha}` }));
    const mergeBase = cmp?.merge_base_commit?.sha;
    if (typeof mergeBase !== 'string' || !/^[0-9a-f]{40}$/.test(mergeBase)) throw new Error('no merge base for the compare');
    const reads = { base: {}, head: {} };
    for (const { path, basePath } of targets) {
      reads.base[basePath] = await side(basePath, mergeBase);
      reads.head[path] = await side(path, pr.head.sha);
    }
    return scriptsGatePaths({ entries: files, reads });
  } catch {
    return [...new Set([...immediate, ...targets.map((t) => t.path)])];
  }
}

/**
 * One PR's verdict input, read fresh. `expectedHead`: when set, the head must still be this SHA.
 * The head is read before and after the other reads; a push in between is reported as a moved
 * head so the caller judges again rather than mixing two heads' facts.
 */
export async function fetchPullRequestInput(github, context, prNumber, { retry = noRetry } = {}) {
  const { owner, repo } = repoOf(context);
  const { data: pr } = await retry('pulls.get', () => github.rest.pulls.get({ owner, repo, pull_number: prNumber }));
  const files = await retry('pulls.listFiles', () => github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 }));
  // t/559: a changed package.json whose `scripts` changed, or that cannot be read or parsed at the merge base or the head, is a
  // gate change: read both sides through the API and let the shared helper decide (same helper as enqueue-pr.mjs).
  const scriptsGatePathsList = await readScriptsGatePaths({ github, retry, owner, repo, pr, files });
  const reviews = await retry('pulls.listReviews', () => github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 }));
  const comments = await retry('issues.listComments', () => github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 }));
  // t/751: the Dependabot exemption reads every commit, so list them only for a PR with no Tier line
  // (the only case that needs them). A list that cannot be read throws: the run fails closed.
  const commits = parseTier(pr.body ?? '') === null
    ? await retry('pulls.listCommits', () => github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: prNumber, per_page: 100 }))
    : null;
  // t/752: the Design gate's push time, the way the sweeps read it: the earliest check-run start on the
  // head. A committer date is author-controlled. Unreadable throws (fail closed).
  const checkRuns = await retry('checks.listForRef', () => github.paginate(github.rest.checks.listForRef, { owner, repo, ref: pr.head?.sha, per_page: 100 }));
  const { data: again } = await retry('pulls.get', () => github.rest.pulls.get({ owner, repo, pull_number: prNumber }));
  if (again.head?.sha !== pr.head?.sha) return { moved: true, from: pr.head?.sha, to: again.head?.sha };
  return {
    moved: false,
    state: pr.state,
    baseRef: pr.base?.ref,
    input: {
      number: pr.number,
      headSha: pr.head?.sha,
      body: pr.body ?? '', // the API reports an empty description as null
      headRefName: pr.head?.ref,
      files: files.map((f) => ({ filename: f.filename, previous_filename: f.previous_filename, status: f.status })),
      filesTruncated: files.length >= PR_FILES_API_CAP || files.length !== pr.changed_files,
      scriptsGatePaths: scriptsGatePathsList,
      reviews,
      comments,
      dependabot: { authorLogin: pr.user?.login ?? null, headRepo: pr.head?.repo?.full_name ?? null, baseRepo: pr.base?.repo?.full_name ?? null, commits, commitsTotal: pr.commits, files: files.map((f) => ({ filename: f.filename, previous_filename: f.previous_filename, status: f.status, patch: f.patch })), filesTotal: pr.changed_files },
      headPushedAtMs: earliestCheckRunStartMs(checkRuns),
      lastPushAt: null, // not read: a committer date is author-controlled (see merge-approval-verdict.mjs)
      labels: (pr.labels ?? []).map((l) => l?.name).filter(Boolean),
    },
  };
}

async function fetchStable(github, context, prNumber, deps) {
  for (let i = 0; i < 3; i++) {
    const r = await fetchPullRequestInput(github, context, prNumber, deps);
    if (!r.moved) return r;
  }
  throw new Error(`#${prNumber}'s head kept moving while it was being read`);
}

/** Evaluates a PR head: every open PR into main at that head. Returns { skip } or { headSha, verdict }. */
export async function evaluatePrHead(github, context, prNumber, { tierConfig, scope, requireHead, ...deps } = {}) {
  const first = await fetchStable(github, context, prNumber, deps);
  if (first.state !== 'open') return { skip: `#${prNumber} is ${first.state}` };
  if (first.baseRef !== 'main') return { skip: `#${prNumber} targets ${first.baseRef}, not main` };
  const headSha = first.input.headSha;
  if (requireHead && headSha !== requireHead) return { skip: `#${prNumber}'s head moved from ${requireHead.slice(0, 9)} to ${String(headSha).slice(0, 9)}` };
  const siblings = (await openPullRequestsAtHead(github, context, headSha, deps)).filter((n) => n !== prNumber);
  const inputs = [first.input];
  for (const n of [...new Set(siblings)].sort((a, b) => a - b)) {
    const r = await fetchStable(github, context, n, deps);
    if (r.input.headSha !== headSha) throw new Error(`#${n} no longer has head ${headSha.slice(0, 9)}`);
    inputs.push(r.input);
  }
  const ctx = [`Head ${headSha} of ${inputs.map((p) => `#${p.number}`).join(', ')}${inputs.length > 1 ? ' (every open PR into main at this head shares its checks)' : ''}.`];
  return { headSha, verdict: evaluateGroup({ prs: inputs, tierConfig, scope, context: ctx }) };
}

/** Evaluates a merge-group commit: the queued PR and every entry ahead of it, each at its own head. */
export async function evaluateMergeGroup(github, context, target, { tierConfig, scope, ...deps } = {}) {
  const inputs = [];
  const problems = [];
  for (const m of target.members) {
    const r = await fetchStable(github, context, m.number, deps);
    if (r.input.headSha !== m.headRefOid) problems.push(`#${m.number}'s head is ${String(r.input.headSha).slice(0, 9)}, but its queue entry has ${m.headRefOid.slice(0, 9)}`);
    inputs.push(r.input);
  }
  const ctx = [`Merge group ${target.headSha} (queue position ${target.position}): ${target.members.map((m) => `#${m.number}`).join(', ')}.`];
  if (problems.length) return failureVerdict(problems.join('; '), ctx);
  return evaluateGroup({ prs: inputs, tierConfig, scope, context: ctx });
}

const sameVerdict = (a, b) => a.conclusion === b.conclusion && a.title === b.title && a.summary === b.summary;

/**
 * The whole run. Returns { posted: [{ headSha, conclusion }], skipped?: reason }. Throws after a
 * best-effort `failure` post when anything goes wrong once a SHA is known.
 *   deps: { retry, log } -- retry is withGitHubRetry bound to a logger; log(msg) for info lines.
 */
export async function runMergeApproval({ appGithub, context, tierConfig, retry = noRetry, log = () => {} }) {
  // t/566: every read uses the App token. There is deliberately no GITHUB_TOKEN client here.
  const github = appGithub;
  const deps = { retry };
  const posted = [];
  let knownSha = null;
  const post = async (sha, verdict) => {
    await postCheck(appGithub, context, sha, verdict, deps);
    posted.push({ headSha: sha, conclusion: verdict.conclusion });
    log(`${CHECK_NAME}: posted ${verdict.conclusion} on ${sha}: ${verdict.title}`);
  };
  try {
    const target = await resolveTarget(github, context, deps);
    if (target.action === 'skip') {
      log(`${CHECK_NAME}: skipped, ${target.reason}`);
      return { posted, skipped: target.reason };
    }
    knownSha = target.headSha;
    const scope = await checkInstallationScope(appGithub, deps);
    log(`${CHECK_NAME}: installation scope ${scope.ok ? 'OK' : 'FAIL'}, ${scope.detail}`);

    if (target.action === 'fail') {
      await post(target.headSha, failureVerdict(target.reason, [`Installation scope: ${scope.ok ? 'OK' : 'FAIL'}, ${scope.detail}`]));
      return { posted };
    }
    if (target.kind === 'group') {
      await post(target.headSha, await evaluateMergeGroup(github, context, target, { tierConfig, scope, ...deps }));
      return { posted };
    }

    // PR head: post, then re-read and recompute; post again if anything changed (RACES above).
    let requireHead = target.requireHead;
    let last = null;
    for (let pass = 1; pass <= MAX_PASSES + 1; pass++) {
      const r = await evaluatePrHead(github, context, target.prNumber, { tierConfig, scope, requireHead, ...deps });
      if (r.skip) {
        log(`${CHECK_NAME}: ${last ? 'stopped' : 'skipped'}, ${r.skip}`);
        return { posted, skipped: last ? undefined : r.skip };
      }
      requireHead = undefined; // only the first read is tied to the relay's SHA
      knownSha = r.headSha;
      if (last && last.headSha === r.headSha && sameVerdict(last.verdict, r.verdict)) return { posted };
      if (pass > MAX_PASSES) {
        await post(r.headSha, failureVerdict(`the PR's state kept changing during ${MAX_PASSES} evaluations; re-run when it settles`));
        return { posted };
      }
      await post(r.headSha, r.verdict);
      last = r;
    }
    return { posted };
  } catch (err) {
    const msg = String(err?.message ?? err).split('\n')[0];
    // A merge group's SHA is known as soon as Security's conditions hold, even if the queue read
    // itself is what failed.
    if (!knownSha && context.eventName === 'workflow_run' && context.payload?.workflow_run?.event === 'merge_group') {
      const cond = mergeGroupConditions(context);
      if (cond.ok) knownSha = cond.headSha;
    }
    if (knownSha) {
      try {
        await postCheck(appGithub, context, knownSha, failureVerdict(`the evaluation crashed: ${msg}`), deps);
        posted.push({ headSha: knownSha, conclusion: 'failure' });
      } catch (postErr) {
        log(`${CHECK_NAME}: could not post the failure check on ${knownSha} either: ${String(postErr?.message ?? postErr).split('\n')[0]}`);
      }
    }
    throw err;
  }
}
