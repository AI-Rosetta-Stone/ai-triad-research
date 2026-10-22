// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// local/require-windows-hide-disable-reason (t/4238, TL e/351#2): the escape hatch for the now-blocking
// local/require-windows-hide rule. A disable of local/require-windows-hide or local/require-windows-hide-unverifiable
// is allowed only as a line-scoped directive that carries a reason and a ticket:
//
//   // eslint-disable-next-line local/require-windows-hide -- <reason> (t/NNNN)
//
// Rejected: no `--` description, a description without a t/NNNN ticket, and file- or block-scoped
// `/* eslint-disable local/require-windows-hide */` directives (they hide every later call in the file).
//
// It is a separate rule id on purpose: disabling local/require-windows-hide cannot silence this check. Known gap: a
// blanket `/* eslint-disable */` (no rule list) above a directive suppresses this rule too; that is out of scope here.

const GUARDED = new Set(['local/require-windows-hide', 'local/require-windows-hide-unverifiable']);
const DIRECTIVE = /^\s*eslint-disable(-next-line|-line)?(?:\s+([^]*))?$/;
const TICKET = /\bt\/\d+\b/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'A disable of local/require-windows-hide must be line-scoped and carry a reason and a ticket (t/4238)' },
    schema: [],
    messages: {
      noReason:
        'Disabling {{rule}} needs a reason and a ticket after `--`, e.g. ' +
        '`// eslint-disable-next-line {{rule}} -- <why it is safe> (t/NNNN)`. (t/4238)',
      blockScoped:
        'A file- or block-scoped disable of {{rule}} hides every later child_process call in the file. Use ' +
        '`// eslint-disable-next-line {{rule}} -- <reason> (t/NNNN)` on the one line instead. (t/4238)',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const m = DIRECTIVE.exec(comment.value);
          if (!m) continue;
          const [ruleList, ...rest] = (m[2] ?? '').split(/\s--\s?/);
          const description = rest.join(' -- ').trim();
          const rules = ruleList.split(',').map((r) => r.trim()).filter(Boolean);
          const guarded = rules.find((r) => GUARDED.has(r));
          if (!guarded) continue;
          if (!m[1]) {
            context.report({ loc: comment.loc, messageId: 'blockScoped', data: { rule: guarded } });
          } else if (!description || !TICKET.test(description)) {
            context.report({ loc: comment.loc, messageId: 'noReason', data: { rule: guarded } });
          }
        }
      },
    };
  },
};
