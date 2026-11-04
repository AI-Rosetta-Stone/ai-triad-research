// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Complete check-context lists for the enqueue sweeps.
//
// WHY: the sweeps read a PR's checks through statusCheckRollup.contexts(first:100). A PR
// that runs the full suite has more than 100 contexts (#4475 had 142), and ci-gate, which
// finishes last, falls past the first page. The sweep then read ci-gate as "missing" and
// never enqueued the PR (2026-11-04, enqueue-sweep run after 14:30Z: "skip #4475: ci-gate
// is missing" while ci-gate had passed on that head). This module follows the pagination.
//
// Pure core (`collectAllContexts`, with the page fetcher injected) is unit-tested in
// pr-contexts.test.mjs; `readContextsPage` is the impure gh shim.

import { execFileSync } from 'node:child_process';

export const MAX_CONTEXT_PAGES = 10;

/**
 * Follows a contexts connection to the end. `conn` is the first page ({ nodes, pageInfo });
 * `fetchPage(cursor)` returns the next page in the same shape. Returns { nodes, complete }.
 * `complete` is false when a page fetch failed or the page cap was hit; the nodes read so
 * far are still returned, so a missing required check fails closed (the PR is skipped).
 */
export function collectAllContexts(conn, fetchPage, { maxPages = MAX_CONTEXT_PAGES, label = 'PR' } = {}) {
  const nodes = [...(conn?.nodes ?? [])];
  let info = conn?.pageInfo;
  let pages = 1;
  while (info?.hasNextPage) {
    if (pages >= maxPages) {
      console.warn(`WARN: ${label}: stopped reading check contexts after ${pages} pages (${nodes.length} read); ` +
        'checks past that are treated as missing, so the PR is skipped rather than enqueued.');
      return { nodes, complete: false };
    }
    let next;
    try {
      next = fetchPage(info.endCursor);
    } catch (err) {
      console.warn(`WARN: ${label}: could not read check contexts page ${pages + 1} (${err.message ?? err}); ` +
        'checks past that are treated as missing, so the PR is skipped rather than enqueued.');
      return { nodes, complete: false };
    }
    nodes.push(...(next?.nodes ?? []));
    info = next?.pageInfo;
    pages++;
  }
  return { nodes, complete: true };
}

/**
 * Reads one page of a PR's last-commit check contexts after `cursor`. `nodeFields` is the
 * GraphQL selection for each context node, the same one the caller's search query uses.
 */
export function readContextsPage(repo, number, cursor, nodeFields) {
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){' +
    'pullRequest(number:$number){commits(last:1){nodes{commit{statusCheckRollup{' +
    `contexts(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{${nodeFields}}}}}}}}}}`;
  const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`,
    '-f', `name=${name}`, '-F', `number=${number}`, '-f', `cursor=${cursor}`],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const conn = JSON.parse(out).data.repository.pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
  return conn ?? { nodes: [], pageInfo: { hasNextPage: false } };
}

/** All contexts for a PR whose first page came from a search query. */
export function allContextsFor(repo, number, firstConn, nodeFields) {
  return collectAllContexts(firstConn, (cursor) => readContextsPage(repo, number, cursor, nodeFields),
    { label: `#${number}` }).nodes;
}
