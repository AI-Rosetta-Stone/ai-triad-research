// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// local/no-bare-throw (t/4153, t/4109 migration D2) — the TypeScript half of root rule #19:
// unrecoverable errors use ActionableError (Goal / Problem / Location / Next Steps), never a bare
// `throw new Error('message')`. The PowerShell half is tests/BareThrowLint.Tests.ps1 (t/4152).
//
// FLAGS a throw whose message is written inline:
//   throw new Error('…')  /  throw Error('…')  /  throw new Error(`…${x}`)  /  throw new Error('…: ' + x)
//   throw '…'  /  throw `…`
// NOT flagged: rethrows (`throw err`), `throw new ActionableError({…})`, `new Error(variable)`, and
// other Error subclasses (TypeError, RangeError, …) — out of scope, as for the PowerShell lint.
//
// BASELINE (ratchet): one JSON of per-file counts shared by lib's and taxonomy-editor's configs, keyed by
// REPO-RELATIVE path so the two cwds agree. A file whose count rises above its entry, or any offender in
// an unlisted file, is reported; a count that falls is fine. Regenerate with
// `node eslint-rules/generate-bare-throw-baseline.mjs` (from lib/), which uses isBareThrow() below, so the
// generator and the rule cannot disagree. No baseline option = bootstrap mode: every offender reports.
//
// Ships at 'warn'. Promoting it to 'error' makes it a blocking gate: T2 under t/4092.

import { readFileSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** @param {any} node */
function isInlineText(node) {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string';
  if (node.type === 'TemplateLiteral') return true;
  if (node.type === 'BinaryExpression' && node.operator === '+') return isInlineText(node.left) || isInlineText(node.right);
  return false;
}

/**
 * True when a `throw` argument is a bare, inline-message error.
 * @param {any} arg - the ThrowStatement's argument node
 */
export function isBareThrow(arg) {
  if (!arg) return false;
  if (isInlineText(arg)) return true;
  if ((arg.type === 'NewExpression' || arg.type === 'CallExpression')
      && arg.callee.type === 'Identifier' && arg.callee.name === 'Error') {
    return isInlineText(arg.arguments[0]);
  }
  return false;
}

/** Repo-relative, forward-slash key for a linted file. */
export function baselineKey(filename) {
  return relative(REPO_ROOT, filename).replace(/\\/g, '/');
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Unrecoverable errors use ActionableError, not a bare throw new Error(\'…\') (root rule #19)' },
    messages: {
      bare: 'Bare throw ({{count}} in this file, baseline {{baseline}}). Throw an ActionableError (lib/debate/errors.ts) with goal, problem, location and nextSteps; see docs/error-handling.md. Rethrowing a caught error is fine.',
      baselineLoadError: 'Could not load the no-bare-throw baseline "{{path}}": {{error}}. Fix the path or regenerate it with eslint-rules/generate-bare-throw-baseline.mjs.',
    },
    schema: [{
      type: 'object',
      properties: {
        // string → path relative to the REPO ROOT (not the ESLint cwd, so a run from any directory finds
        // the same file); object → inline { "<key>": count } (tests)
        baseline: { oneOf: [{ type: 'string' }, { type: 'object' }] },
      },
      additionalProperties: false,
    }],
  },

  create(context) {
    const opt = context.options[0]?.baseline;
    /** @type {Record<string, number> | null} */
    let baseline = null;
    /** @type {string | null} */
    let loadError = null;
    if (typeof opt === 'string') {
      try {
        const { __meta__, ...files } = JSON.parse(readFileSync(resolve(REPO_ROOT, opt), 'utf-8'));
        baseline = files;
      } catch (err) {
        // A missing or malformed baseline must not silently become {} (every file unlisted) or
        // disable the rule; report it on the file instead.
        loadError = err instanceof Error ? err.message : String(err);
      }
    } else if (opt && typeof opt === 'object') {
      const { __meta__, ...files } = /** @type {any} */ (opt);
      baseline = files;
    }

    /** @type {any[]} */
    const hits = [];
    return {
      ThrowStatement(node) {
        if (isBareThrow(node.argument)) hits.push(node);
      },
      'Program:exit'(program) {
        if (loadError) {
          context.report({ node: program, messageId: 'baselineLoadError', data: { path: String(opt), error: loadError } });
          return;
        }
        const key = typeof opt === 'object' && opt ? context.filename.replace(/\\/g, '/') : baselineKey(context.filename);
        const allowed = baseline ? (baseline[key] ?? 0) : 0;
        if (hits.length <= allowed) return;
        for (const node of hits) {
          context.report({ node, messageId: 'bare', data: { count: String(hits.length), baseline: String(allowed) } });
        }
      },
    };
  },
};
