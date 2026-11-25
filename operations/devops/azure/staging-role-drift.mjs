// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Staging role-drift predicate (t/707, TL p/104#97).
//
// Answers one question: does the staging app identity hold a role assignment that the Bicep in
// deploy/azure/ does not declare? A grant made by hand (t/92#18 made one) is invisible to review
// and survives every deploy, because ARM incremental mode never removes what a template omits.
//
// Pure: it takes Bicep text and the JSON of `az role assignment list --assignee <id> --all`.
// It makes no Azure call. Anything it cannot resolve is reported as `unresolved` and fails the
// verdict; it never guesses a scope and never treats "could not tell" as "declared".
//
// CLI (for a by-hand check; the scheduled wiring is a separate T2 change):
//   az role assignment list --assignee <staging principal id> --all > live.json
//   node operations/devops/azure/staging-role-drift.mjs live.json deploy/azure/main.bicep deploy/azure/staging-keyvault.bicep

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Bicep expressions that mean "the staging app's managed identity". */
export const STAGING_PRINCIPAL_EXPRESSIONS = Object.freeze([
  'containerAppStaging.identity.principalId',
  'stagingPrincipalId',
]);

const ROLE_ASSIGNMENT_TYPE = 'microsoft.authorization/roleassignments';

/** ARM scope segment for each resource type a staging grant may be scoped to. */
const SCOPE_SEGMENT_BY_TYPE = Object.freeze({
  'microsoft.storage/storageaccounts/blobservices/containers': 'containers',
  'microsoft.storage/storageaccounts': 'storageaccounts',
  'microsoft.keyvault/vaults': 'vaults',
});

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Top-level `resource <symbol> '<type>@<version>' [existing] = {` blocks, body up to the closing column-0 brace. */
function resourceBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^resource\s+(\w+)\s+'([^'@]+)@[^']*'\s+(?:existing\s+)?=\s*(?:if\s*\(.*\)\s*)?\{\s*$/.exec(lines[i]);
    if (!head) continue;
    const body = [];
    let j = i + 1;
    while (j < lines.length && !/^\}/.test(lines[j])) {
      body.push(lines[j]);
      j += 1;
    }
    blocks.push({ symbol: head[1], type: head[2].toLowerCase(), body, line: i + 1 });
    i = j;
  }
  return blocks;
}

/** The value of a two-space-indented or deeper `key: value` property, trimmed, or null. */
function property(body, key) {
  const re = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`);
  for (const line of body) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** String literals bound by `var x = '…'` and `param x string = '…'`. */
function stringBindings(text) {
  const bindings = new Map();
  const re = /^(?:var\s+(\w+)|param\s+(\w+)\s+string)\s*=\s*'([^']*)'\s*$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) bindings.set(m[1] ?? m[2], m[3]);
  return bindings;
}

/** Resolve a Bicep name expression to a literal: a quoted string, or an identifier bound to one. */
function literal(expression, bindings) {
  if (expression === null) return null;
  const quoted = /^'([^'$]*)'$/.exec(expression);
  if (quoted) return quoted[1];
  if (/^\w+$/.test(expression) && bindings.has(expression)) return bindings.get(expression);
  return null;
}

/**
 * The role assignments one Bicep file declares for the staging identity.
 * @param {string} text Bicep source.
 * @param {string} [file] Name used in messages.
 * @returns {{declared: Array<{roleId: string, scopeSuffix: string, symbol: string, file: string, line: number}>, unresolved: string[]}}
 */
export function declaredStagingRoles(text, file = '<bicep>') {
  const bindings = stringBindings(text);
  const blocks = resourceBlocks(text);
  const bySymbol = new Map(blocks.map((b) => [b.symbol, b]));
  const declared = [];
  const unresolved = [];

  for (const block of blocks) {
    if (block.type !== ROLE_ASSIGNMENT_TYPE) continue;
    const at = `${file}:${block.line} (${block.symbol})`;
    const principal = property(block.body, 'principalId');
    if (principal === null) {
      unresolved.push(`${at}: no principalId, so it cannot be told whether this grant is staging's`);
      continue;
    }
    if (!STAGING_PRINCIPAL_EXPRESSIONS.includes(principal)) continue;

    const roleExpression = property(block.body, 'roleDefinitionId') ?? '';
    const roleName = /(\w+)\s*\)\s*$/.exec(roleExpression)?.[1] ?? '';
    const roleLiteral = /'([0-9a-fA-F-]{36})'\s*\)\s*$/.exec(roleExpression)?.[1];
    const roleId = roleLiteral ?? bindings.get(roleName);
    if (!roleId || !GUID.test(roleId)) {
      unresolved.push(`${at}: roleDefinitionId '${roleExpression}' does not resolve to a role GUID`);
      continue;
    }

    const scopeSymbol = property(block.body, 'scope');
    const target = scopeSymbol === null ? undefined : bySymbol.get(scopeSymbol);
    if (!target) {
      unresolved.push(`${at}: scope '${scopeSymbol}' is not a resource declared in this file`);
      continue;
    }
    const segment = SCOPE_SEGMENT_BY_TYPE[target.type];
    if (!segment) {
      unresolved.push(`${at}: scope '${scopeSymbol}' has type '${target.type}', which this check cannot map to a scope`);
      continue;
    }
    const name = literal(property(target.body, 'name'), bindings);
    if (name === null) {
      unresolved.push(`${at}: the name of scope '${scopeSymbol}' is not a string literal or a parameter with a literal default`);
      continue;
    }
    declared.push({
      roleId: roleId.toLowerCase(),
      scopeSuffix: `/${segment}/${name}`.toLowerCase(),
      symbol: block.symbol,
      file,
      line: block.line,
    });
  }
  return { declared, unresolved };
}

/**
 * Compare the live assignments with the declared ones.
 * @param {{declared: Array<{roleId: string, scopeSuffix: string, symbol: string}>, unresolved?: string[], live: unknown}} input
 *   `live` is the parsed output of `az role assignment list --assignee <id> --all`.
 * @returns {{ok: boolean, undeclared: Array<{name: string, role: string, scope: string}>, missing: string[], unresolved: string[], summary: string}}
 */
export function roleDriftVerdict({ declared, unresolved = [], live }) {
  const problems = [...unresolved];
  if (!Array.isArray(live)) {
    problems.push('the live assignment list is not a JSON array; an empty or failed read must not pass as "no drift"');
    return verdict([], [], problems);
  }

  const matched = new Set();
  const undeclared = [];
  for (const assignment of live) {
    const scope = String(assignment?.scope ?? '').toLowerCase();
    const roleId = String(assignment?.roleDefinitionId ?? '').toLowerCase().split('/').pop();
    if (!scope || !GUID.test(roleId)) {
      problems.push(`live assignment '${assignment?.name ?? '?'}' has no usable scope or roleDefinitionId`);
      continue;
    }
    const hit = declared.findIndex((d) => d.roleId === roleId && scope.endsWith(d.scopeSuffix));
    if (hit === -1) {
      undeclared.push({
        name: String(assignment.name ?? '?'),
        role: String(assignment.roleDefinitionName ?? roleId),
        scope: String(assignment.scope),
      });
    } else {
      matched.add(hit);
    }
  }
  const missing = declared
    .filter((_, index) => !matched.has(index))
    .map((d) => `${d.symbol} (role ${d.roleId} on …${d.scopeSuffix})`);
  return verdict(undeclared, missing, problems);
}

function verdict(undeclared, missing, unresolved) {
  const ok = undeclared.length === 0 && unresolved.length === 0;
  const parts = [];
  if (undeclared.length > 0) {
    parts.push(
      `${undeclared.length} role assignment(s) on the staging identity are not declared in Bicep: ` +
        undeclared.map((u) => `${u.role} on ${u.scope} (${u.name})`).join('; '),
    );
  }
  if (unresolved.length > 0) parts.push(`could not evaluate: ${unresolved.join('; ')}`);
  // A declared grant that is not live is reported, not failed: it is the state between a merge and
  // its deploy, and the deploy's own gates cover it.
  if (missing.length > 0) parts.push(`declared but not live (not a failure): ${missing.join('; ')}`);
  if (parts.length === 0) parts.push('every live role assignment on the staging identity is declared in Bicep');
  return { ok, undeclared, missing, unresolved, summary: parts.join('\n') };
}

function main(argv) {
  const [livePath, ...bicepPaths] = argv;
  if (!livePath || bicepPaths.length === 0) {
    console.error(
      'Goal: check the staging identity for undeclared role assignments.\n' +
        'Problem: missing arguments.\n' +
        'Location: operations/devops/azure/staging-role-drift.mjs\n' +
        'Next steps: node staging-role-drift.mjs <live.json> <file.bicep> [<file.bicep> …]',
    );
    return 2;
  }
  let live;
  try {
    live = JSON.parse(readFileSync(livePath, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    console.error(
      'Goal: read the live role assignments.\n' +
        `Problem: ${error.message}\n` +
        `Location: ${livePath}\n` +
        'Next steps: re-run `az role assignment list --assignee <staging principal id> --all` and save its JSON output.',
    );
    return 2;
  }
  const declared = [];
  const unresolved = [];
  for (const path of bicepPaths) {
    const result = declaredStagingRoles(readFileSync(path, 'utf8'), path);
    declared.push(...result.declared);
    unresolved.push(...result.unresolved);
  }
  const result = roleDriftVerdict({ declared, unresolved, live });
  console.log(result.summary);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
