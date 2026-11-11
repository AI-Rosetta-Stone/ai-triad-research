// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Enqueue T0 PRs that are green and idle but were never put in the merge queue.
//
// WHY: AGENTS.md asks authors to arm T0 PRs at creation, and they often don't. Over the
// five days after the merge queue launched, 9 T0 PRs waited 1-14h (about 35h in total)
// with green checks and nothing enqueued (e.g. #4077-#4084, ~3h each). This sweep does
// the arming: it runs as the GitHub App (GITHUB_TOKEN-initiated auto-merge never entered
// the queue, see dependabot-enqueue-sweep.mjs) and enqueues through enqueue-pr.mjs,
// which pins the head and verifies queue entry.
//
// A PR is enqueued only when ALL of these hold (PI decision, 2026-11-02):
//   - the body's first non-empty line declares `Tier: T0`, base is main, not a draft,
//     not already queued, not authored by Dependabot (that flow has its own sweep);
//   - no hold or opt-out label: consult-hold, joint-gv, no-auto-enqueue;
//   - not dequeued by hand at this head: when the most recent queue event is a manual
//     removal and nothing has been pushed since, someone pulled it out on purpose (usually
//     to push a fix). Re-enqueueing it merged #4561 with its old head 29s after the
//     dequeue (t/4879);
//   - no merge conflict, and every REQUIRED_GREEN context passed on the head;
//   - a `docker/base-repin-*` head is STILL a pure base-pin bump (t/309): the drift workflow
//     classifies the tier once, at PR creation, so a later push to that branch would otherwise
//     merge as T0. The head must change only taxonomy-editor/Dockerfile, and Docker's own
//     classifyRepinTier must say T0 on merge-base vs head. Anything else, or facts we can't
//     read, skips with a WARN and one comment asking for T1 review;
//   - IDLE: nothing pushed for IDLE_MINUTES. Pushing to a queued PR is refused, so an
//     author still adding commits must not be cut off. The push time is taken as the
//     earliest check-run start on the head (CI starts within seconds of a push; GitHub's
//     commit pushedDate is deprecated and usually null).
//
// Pure core (`selectT0Candidates`) is unit-tested in t0-enqueue-sweep.test.mjs.
//
//   GH_TOKEN=<app token> node operations/devops/t0-enqueue-sweep.mjs <owner>/<repo> [--dry-run]

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueuePR } from './enqueue-pr.mjs';
import { checkVerdict } from './dependabot-enqueue-sweep.mjs';
import { liveEnqueueVerdict, readLivePR } from './live-pr-state.mjs';
import { allContextsFor } from './pr-contexts.mjs';
import { isUserFacing } from './design-review-scope.mjs';
import { latestRoleVerdicts } from './role-review-verdicts.mjs';
import { BRANCH_PREFIX as REPIN_BRANCH_PREFIX, classifyRepinTier } from './docker/base-pin-drift.mjs';

// t/309: the one file a re-pin PR may touch (check-base-pin-drift.yml's DOCKERFILE).
export const REPIN_DOCKERFILE = 'taxonomy-editor/Dockerfile';
export const REPIN_COMMENT_MARKER = '<!-- t0-sweep-repin-not-t0:';

export function isRepinBranch(headRefName) {
  return typeof headRefName === 'string' && headRefName.startsWith(REPIN_BRANCH_PREFIX);
}

/**
 * PURE (t/309). Is a re-pin PR's CURRENT head still a pure base-pin bump? `files` is the PR's
 * changed-file list; `beforeText`/`afterText` are REPIN_DOCKERFILE at the merge base and at the
 * head. Docker's classifyRepinTier only sees the Dockerfile, so an extra changed file (a script,
 * a workflow) is checked here first. Never duplicates classifyRepinTier's line rules.
 * @returns {{tier:'T0'|'T1', reason:string}}
 */
export function repinTierCheck({ files, beforeText, afterText }) {
  const list = files ?? [];
  if (list.length !== 1 || list[0] !== REPIN_DOCKERFILE) {
    return { tier: 'T1', reason: `changes ${list.length} file(s) (${list.slice(0, 5).join(', ')}${list.length > 5 ? ', ...' : ''}), want only ${REPIN_DOCKERFILE}` };
  }
  if (typeof beforeText !== 'string' || typeof afterText !== 'string') {
    return { tier: 'T1', reason: `could not read ${REPIN_DOCKERFILE} at both merge base and head` };
  }
  return classifyRepinTier(beforeText, afterText);
}

export const IDLE_MINUTES = 15;
export const REQUIRED_CONTEXTS = ['ci-gate', 'CodeQL Analysis', 'joint-gv-guard', 'consult-hold-guard'];
// Same shared reviewer App account every other review-reading guard uses (ci.yml,
// t1-approval-guard.yml, tier-check.yml use REST and see 'ai-triad-reviewer-jpsnover[bot]') --
// every role reviews through this one GitHub account (t/4952 gap 2). This sweep reads reviews
// and comments through GraphQL, not REST, and GraphQL's `author.login` omits the `[bot]` suffix
// entirely (confirmed live: a REST login of 'ai-triad-reviewer-jpsnover[bot]' comes back from
// GraphQL as plain 'ai-triad-reviewer-jpsnover') -- using the REST-style constant here would
// silently match nothing and disable both new skips with no error.
export const REVIEWER_APP_LOGIN = 'ai-triad-reviewer-jpsnover';
export const BLOCKING_LABELS = ['consult-hold', 'joint-gv', 'no-auto-enqueue'];

/** PURE. True when the first non-empty line of a PR body declares Tier: T0 (AGENTS.md format). */
export function declaresT0(body) {
  const first = String(body ?? '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return /^\s*Tier:\s*T0\b/i.test(first);
}

/** PURE. Earliest check-run start on the head, as a push-time proxy; null when unknown. */
export function headPushedAt(contexts) {
  const starts = (contexts ?? []).map((c) => Date.parse(c.startedAt ?? '')).filter((t) => !Number.isNaN(t));
  return starts.length ? Math.min(...starts) : null;
}

/**
 * PURE. The manual dequeue still holding this PR out of the queue, or null. `queueEvents` are
 * the PR's Added/RemovedFromMergeQueue timeline events, oldest first. Only the most recent
 * one counts: a later re-add (by a human) ends the hold. A push after the removal ends it too,
 * since the author has delivered the fix. Push time unknown counts as no push (fails closed).
 */
export function manualDequeueHold(queueEvents, pushedMs) {
  const last = (queueEvents ?? []).at(-1);
  if (!last || last.type !== 'RemovedFromMergeQueueEvent') return null;
  if (String(last.reason ?? '').toLowerCase() !== 'manual') return null;
  const removedMs = Date.parse(last.createdAt ?? '');
  if (Number.isNaN(removedMs)) return null;
  if (pushedMs != null && pushedMs > removedMs) return null;
  return { removedAt: last.createdAt, actor: last.actor ?? 'unknown' };
}

/**
 * PURE. Splits open PRs into those to enqueue now and those to skip (with the reason).
 * `waiting` lists the skipped PRs whose ONLY blocker is the idle window, with the time
 * (ms) they become eligible, so an event-triggered run can wait for them (planNextWake).
 */
export function selectT0Candidates(prs, nowMs, { idleMinutes = IDLE_MINUTES } = {}) {
  const enqueue = [];
  const skip = [];
  const waiting = [];
  for (const pr of prs) {
    const labels = pr.labels ?? [];
    const blocking = BLOCKING_LABELS.find((l) => labels.includes(l));
    let reason = null;
    let hold = null;
    let needsRepinComment = false;
    // Security: the repo is public and `main` requires checks, not a review. A fork PR that
    // writes `Tier: T0` and goes green must never be merged with no human looking at it.
    // Same-repo branches need write access. Fails closed: an unknown value counts as a fork.
    if (pr.isCrossRepository !== false) reason = 'fork PR (never auto-enqueued; a maintainer must review and enqueue it)';
    else if (!declaresT0(pr.body)) reason = 'not declared Tier: T0';
    else if (pr.baseRefName !== 'main') reason = `base is ${pr.baseRefName}, not main`;
    else if (pr.isDraft) reason = 'draft';
    else if (pr.isInMergeQueue) reason = 'already in merge queue';
    else if (/dependabot/i.test(pr.author ?? '')) reason = 'Dependabot PR (handled by dependabot-enqueue-sweep)';
    else if (blocking) reason = `label ${blocking}`;
    else if ((hold = manualDequeueHold(pr.queueEvents, headPushedAt(pr.contexts)))) {
      reason = `WARN: manually dequeued by ${hold.actor} at ${hold.removedAt} and nothing pushed since ` +
        '(push a new head, or enqueue it by hand, to release it)';
    }
    else if (pr.mergeStateStatus === 'DIRTY') reason = 'merge conflict';
    // t/309: re-check a re-pin branch's head, not the tier the drift workflow declared at
    // creation. No result (fetch failed, or the caller skipped it) fails closed.
    else if (isRepinBranch(pr.headRefName) && pr.repinCheck?.tier !== 'T0') {
      reason = pr.repinCheck
        ? `WARN: ${pr.headRefName} head is not a pure base-pin bump (${pr.repinCheck.reason}); needs T1 review, not auto-enqueued`
        : `WARN: ${pr.headRefName} head could not be re-classified (re-pin facts unavailable) -- failing closed`;
      if (pr.repinCheck) needsRepinComment = true;
    }
    // t/4952(a): the Design gate and an active changes-request both read role-tagged review/
    // comment BODIES (role-review-verdicts.mjs), never GitHub's review `state` or
    // `reviewDecision` -- gap 2 (#4686: Design's CHANGES_REQUESTED and Quality's APPROVED, same
    // reviewer-App login, same head, GitHub kept only the latest-per-user and silently dropped
    // Design's block). Fails closed on a fetch problem, per the ticket's ask.
    else if (pr.reviewDataError) reason = 'WARN: could not fetch files/reviews/comments (or the files list was truncated) -- failing closed';
    else {
      const verdicts = latestRoleVerdicts({
        reviews: pr.reviews, comments: pr.comments, reviewerAppLogin: REVIEWER_APP_LOGIN,
        headSha: pr.headRefOid, lastPushAt: headPushedAt(pr.contexts),
      });
      const changesRequestedBy = [...verdicts.entries()].find(([, v]) => v.kind === 'changes_requested');
      const designVerdict = verdicts.get('Design');
      const designPasses = designVerdict?.kind === 'approved' || designVerdict?.kind === 'exempt';
      if (changesRequestedBy) {
        const [role, v] = changesRequestedBy;
        // Quality, p/780#46: a reviewer-App body that says "changes requested" but doesn't match
        // the strict grammar still blocks (role-review-verdicts.mjs's fail-closed backstop) --
        // flagged with a WARN here so a human notices the unrecognized shape, instead of it
        // quietly looking like an ordinary, well-formed block.
        reason = v.unparsed
          ? `WARN: changes requested by ${role} (unparsed reviewer-App body -- check its exact wording against the grammar)`
          : `changes requested by ${role}`;
      }
      else if (isUserFacing(pr.files) && !designPasses) reason = 'awaiting Design gate';
    }
    if (!reason) {
      for (const name of REQUIRED_CONTEXTS) {
        const v = checkVerdict(pr.contexts, name);
        if (v !== 'success') { reason = `${name} is ${v}`; break; }
      }
      if (!reason) {
        const pushed = headPushedAt(pr.contexts);
        if (pushed == null) reason = 'push time unknown (no check runs with a start time)';
        else {
          const idle = (nowMs - pushed) / 60000;
          if (idle < idleMinutes) {
            reason = `idle ${Math.floor(idle)}m < ${idleMinutes}m since last push`;
            waiting.push({ number: pr.number, eligibleAt: pushed + idleMinutes * 60000 });
          }
        }
      }
    }
    if (reason) skip.push({ number: pr.number, reason, ...(needsRepinComment ? { repinComment: { headRefOid: pr.headRefOid, reason: pr.repinCheck.reason } } : {}) });
    else enqueue.push({ number: pr.number, headRefOid: pr.headRefOid, armed: pr.autoMergeRequest != null });
  }
  return { enqueue, skip, waiting };
}

/**
 * PURE. When should a run wake to sweep again? The earliest `eligibleAt` plus a small
 * margin, if that is no later than `deadlineMs`; otherwise null (stop, and leave the PR to
 * the next CI-completion trigger or the schedule).
 */
export function planNextWake(waiting, nowMs, deadlineMs, { marginMs = 20000 } = {}) {
  if (!waiting?.length) return null;
  const wake = Math.max(nowMs, Math.min(...waiting.map((w) => w.eligibleAt)) + marginMs);
  return wake <= deadlineMs ? wake : null;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

// t/316: the open-PR search is a heavy nested query (contexts, files, reviews, comments per PR).
// At 50 PRs a page, GitHub's GraphQL gateway timed out on it as the open-PR count grew: HTTP
// 502/504 on 11 of 13 sweep runs in one hour (t/313#14). Smaller pages cut the per-request cost;
// SEARCH_MAX_PAGES keeps the same reach (300 PRs vs the old 10 x 50 = 500, far above real counts).
export const SEARCH_PAGE_SIZE = 15;
export const SEARCH_MAX_PAGES = 20;

/** PURE (t/316). True for a GitHub gateway error worth retrying: HTTP 502, 503 or 504. */
export function isTransientGatewayError(message) {
  return /\bHTTP 50[234]\b/.test(String(message ?? ''));
}

/**
 * t/316. Runs `fn`; on a transient gateway error, waits and retries, up to `delaysMs.length`
 * extra tries. Anything else, or a gateway error that outlasts the retries, is rethrown, so the
 * sweep still fails closed. `sleep` and `log` are injectable for tests.
 */
export function withGatewayRetry(fn, { delaysMs = [5000, 15000], sleep = sleepSync, log = console.log, label = 'request' } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      const msg = `${err?.message ?? err}\n${err?.stderr ?? ''}`;
      if (!isTransientGatewayError(msg) || attempt >= delaysMs.length) throw err;
      log(`WARN: ${label} hit a GitHub gateway error (${msg.match(/HTTP 50[234]/)[0]}); retrying in ${delaysMs[attempt] / 1000}s (attempt ${attempt + 2} of ${delaysMs.length + 1}). Transient, not a sweep failure.`);
      sleep(delaysMs[attempt]);
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * PURE (should-fix, t/4952#5). True when the raw GraphQL `files`/`reviews`/`comments`
 * sub-objects for one PR node are missing or truncated. `files` pages forward (first:100):
 * truncation there (`hasNextPage`) could hide the one relevant renderer file past page 1,
 * silently misreporting a user-facing PR as not user-facing. `reviews`/`comments` page
 * BACKWARD from the end (last:50): truncation there (`hasPreviousPage`) means 50+ later,
 * unrelated items could have pushed a role's still-active `Changes requested` out of the kept
 * window -- a PR with a genuine unaddressed block would then look like it has no verdict at all
 * and get enqueued. Either direction fails closed (skip with a WARN), never silently proceeds.
 */
export function hasReviewDataError({ files, reviews, comments }) {
  if (files == null || reviews == null || comments == null) return true;
  if (files.pageInfo?.hasNextPage === true) return true;
  if (reviews.pageInfo?.hasPreviousPage === true) return true;
  if (comments.pageInfo?.hasPreviousPage === true) return true;
  return false;
}

// A full-suite PR has more than 100 contexts; allContextsFor reads past the first page (#4475).
const CONTEXT_FIELDS = '... on CheckRun{name status conclusion startedAt} ... on StatusContext{context state}';

function listOpenPRs(repo) {
  const query = `query($q:String!,$cursor:String){search(query:$q,type:ISSUE,first:${SEARCH_PAGE_SIZE},after:$cursor){
    pageInfo{hasNextPage endCursor}
    nodes{... on PullRequest{
      number body headRefOid headRefName baseRefName isDraft isInMergeQueue mergeStateStatus isCrossRepository
      author{login} labels(first:30){nodes{name}} autoMergeRequest{enabledAt}
      timelineItems(last:10,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{
        __typename ... on RemovedFromMergeQueueEvent{createdAt reason actor{login}}
        ... on AddedToMergeQueueEvent{createdAt actor{login}}}}
      commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage endCursor} nodes{
        ${CONTEXT_FIELDS}}}}}}}
      files(first:100){pageInfo{hasNextPage} nodes{path}}
      reviews(last:50){pageInfo{hasPreviousPage} nodes{body author{login} commit{oid} submittedAt}}
      comments(last:50){pageInfo{hasPreviousPage} nodes{body author{login} createdAt lastEditedAt}}}}}}`;
  const prs = [];
  let cursor = null;
  for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `q=repo:${repo} is:pr is:open base:main`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const r = JSON.parse(withGatewayRetry(() => gh(args), { label: `open-PR search page ${page + 1}` })).data.search;
    for (const n of r.nodes) {
      const reviewDataError = hasReviewDataError(n);
      prs.push({
        number: n.number, body: n.body, headRefOid: n.headRefOid, headRefName: n.headRefName, baseRefName: n.baseRefName,
        isDraft: n.isDraft, isInMergeQueue: n.isInMergeQueue, mergeStateStatus: n.mergeStateStatus,
        isCrossRepository: n.isCrossRepository,
        author: n.author?.login ?? '', labels: n.labels.nodes.map((l) => l.name),
        autoMergeRequest: n.autoMergeRequest,
        reviewDataError,
        files: (n.files?.nodes ?? []).map((f) => f.path),
        reviews: (n.reviews?.nodes ?? []).map((rv) => ({
          body: rv.body, login: rv.author?.login ?? null, commitId: rv.commit?.oid ?? null, submittedAt: rv.submittedAt,
        })),
        comments: (n.comments?.nodes ?? []).map((c) => ({
          body: c.body, login: c.author?.login ?? null, createdAt: c.createdAt, updatedAt: c.lastEditedAt ?? null,
        })),
        queueEvents: (n.timelineItems?.nodes ?? []).map((e) => ({
          type: e.__typename, createdAt: e.createdAt, reason: e.reason ?? null, actor: e.actor?.login ?? null,
        })),
        contexts: allContextsFor(repo, n.number, n.commits.nodes[0]?.commit.statusCheckRollup?.contexts, CONTEXT_FIELDS),
      });
    }
    if (!r.pageInfo.hasNextPage) break;
    cursor = r.pageInfo.endCursor;
    const warn = pageCapWarning(page + 1, r.pageInfo.hasNextPage);
    if (warn) console.log(warn);
  }
  return prs;
}

/**
 * PURE (t/316, Quality's #5030 note). A WARN when the search stopped at SEARCH_MAX_PAGES with
 * results still unread, else null. Stopping is the safe direction (the unread PRs just aren't
 * enqueued this pass), but it must be visible rather than silent.
 */
export function pageCapWarning(pagesRead, hasNextPage, maxPages = SEARCH_MAX_PAGES, pageSize = SEARCH_PAGE_SIZE) {
  if (!hasNextPage || pagesRead < maxPages) return null;
  return `WARN: open-PR search stopped at its ${maxPages}-page cap (${maxPages * pageSize} PRs) with more results unread; PRs past the cap are not considered this pass (raise SEARCH_MAX_PAGES if open PRs really exceed it).`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// t/309: REPIN_DOCKERFILE at the merge base and at the head, for repinTierCheck. Any failure
// returns null, which selectT0Candidates turns into a fail-closed skip.
function readRepinCheck(repo, pr) {
  try {
    const mergeBase = JSON.parse(gh(['api', `repos/${repo}/compare/main...${pr.headRefOid}`, '--jq', '{sha: .merge_base_commit.sha}'])).sha;
    const read = (ref) => gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${REPIN_DOCKERFILE}?ref=${ref}`]);
    return repinTierCheck({ files: pr.files, beforeText: read(mergeBase), afterText: read(pr.headRefOid) });
  } catch (err) {
    console.log(`WARN: #${pr.number}: could not read re-pin facts (${err.message ?? err}); it will be skipped, failing closed`);
    return null;
  }
}

// t/309: one comment per head asking for T1 review. Best-effort: a failed post only WARNs,
// since the skip itself already kept the PR out of the queue.
function postRepinComment(repo, number, { headRefOid, reason }) {
  const marker = `${REPIN_COMMENT_MARKER}${headRefOid} -->`;
  try {
    const bodies = JSON.parse(gh(['api', `repos/${repo}/issues/${number}/comments?per_page=100`, '--jq', '[.[].body]']));
    if (bodies.some((b) => (b ?? '').includes(marker))) return;
    const body = [
      `**T0 sweep: not auto-enqueuing this re-pin PR (t/309).** Its head \`${headRefOid.slice(0, 9)}\` is no longer a pure base-pin bump: ${reason}.`,
      '',
      '`Tier: T0` was set when the drift workflow opened this PR. A later push changed more than the runtime `FROM` pin, so it needs a T1 review: change line 1 to `Tier: T1`, get the review, and enqueue it as usual. (Or restore the head to a pure pin bump.)',
      marker,
    ].join('\n');
    gh(['api', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`]);
    console.log(`commented on #${number}: re-pin head not T0`);
  } catch (err) {
    console.log(`WARN: #${number}: could not post the re-pin T1 comment (${err.message ?? err}); the PR is still skipped`);
  }
}

// Fetch re-pin facts only where they can change the verdict: same-repo T0 re-pin PRs whose
// review data loaded (the earlier skips in selectT0Candidates would fire first otherwise).
function withRepinChecks(repo, prs) {
  for (const pr of prs) {
    if (isRepinBranch(pr.headRefName) && pr.isCrossRepository === false && declaresT0(pr.body) && !pr.reviewDataError) {
      pr.repinCheck = readRepinCheck(repo, pr);
    }
  }
  return prs;
}

/**
 * One or more passes. With waitMaxMinutes > 0 (the event-triggered mode), a PR blocked only
 * by the idle window makes this run sleep until it qualifies and sweep again, for up to
 * waitMaxMinutes in total. GitHub's scheduler runs this repo's crons hours late (#4389), so
 * without waiting, a PR that goes green right after a CI-completion trigger could sit until
 * the next unrelated CI run.
 */
export async function sweep(repo, { dryRun = false, waitMaxMinutes = 0 } = {}) {
  const deadline = Date.now() + waitMaxMinutes * 60000;
  const failures = new Set();
  for (let pass = 1; ; pass++) {
    const { enqueue, skip, waiting } = selectT0Candidates(withRepinChecks(repo, listOpenPRs(repo)), Date.now());
    for (const s of skip) {
      console.log(`skip #${s.number}: ${s.reason}`);
      if (s.repinComment) {
        if (dryRun) console.log(`[dry-run] would comment on #${s.number}: re-pin head not T0`);
        else postRepinComment(repo, s.number, s.repinComment);
      }
    }
    if (enqueue.length === 0) console.log(`pass ${pass}: no T0 PRs to enqueue.`);

    for (const pr of enqueue) {
      if (dryRun) { console.log(`[dry-run] would enqueue #${pr.number} at ${pr.headRefOid}`); continue; }
      // Search results lag: re-read the PR directly right before acting (see live-pr-state.mjs).
      const before = liveEnqueueVerdict(readLivePR(repo, pr.number), pr.headRefOid);
      if (!before.ok) {
        console.log(`skip #${pr.number} at enqueue time: ${before.reason}` +
          (before.raced ? '' : ' (WARN: will retry on the next sweep)'));
        continue;
      }
      try {
        // An arm that never reached the queue (the silent-miss class, t/4740) is a no-op to
        // re-arm, so clear it first.
        if (pr.armed) gh(['pr', 'merge', String(pr.number), '-R', repo, '--disable-auto']);
        const result = await enqueuePR(repo, pr.number);
        console.log(`enqueued #${pr.number} (${JSON.stringify(result)})`);
        failures.delete(pr.number);
      } catch (err) {
        // The PR may have moved on in the seconds since the check above (merged by the queue,
        // queued by its author, closed). That is a race, not a failure.
        const after = liveEnqueueVerdict(readLivePR(repo, pr.number), pr.headRefOid);
        if (after.raced) {
          console.log(`skip #${pr.number}: ${after.reason} while enqueuing (race, not a failure): ${err.message ?? err}`);
          continue;
        }
        failures.add(pr.number);
        console.error(`::error::#${pr.number}: ${err.message ?? err}`);
      }
    }

    if (dryRun) break;
    const wake = planNextWake(waiting, Date.now(), deadline);
    if (wake == null) break;
    const ids = waiting.map((w) => `#${w.number}`).join(', ');
    console.log(`waiting ${Math.round((wake - Date.now()) / 1000)}s for ${ids} to pass the ${IDLE_MINUTES}-minute idle window`);
    await sleep(wake - Date.now());
  }
  if (failures.size) {
    throw new Error(
      `t0-enqueue-sweep: failed to enqueue ${[...failures].map((n) => `#${n}`).join(', ')} on ${repo}.\n` +
      '  Goal:       land green, idle T0 PRs through the merge queue.\n' +
      '  Problem:    enqueue-pr.mjs could not get these PRs into the queue as the App.\n' +
      '  Location:   operations/devops/t0-enqueue-sweep.mjs (see the ::error:: lines above).\n' +
      "  Next steps: check each PR's mergeStateStatus; the next sweep retries automatically.",
    );
  }
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('Usage: node operations/devops/t0-enqueue-sweep.mjs <owner>/<repo> [--dry-run] [--wait-max-minutes=N]');
    process.exit(1);
  }
  const waitArg = process.argv.find((a) => a.startsWith('--wait-max-minutes='));
  const waitMaxMinutes = waitArg ? Number(waitArg.split('=')[1]) || 0 : 0;
  sweep(repo, { dryRun: process.argv.includes('--dry-run'), waitMaxMinutes }).then(
    () => {},
    (err) => { console.error(err.message ?? err); process.exit(1); },
  );
}
