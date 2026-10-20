// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkApiVersion,
  matchGlob,
  hasWaiverLine,
  checkOwnedFiles,
  evaluateOwnedFiles,
  checkProvenance,
  evaluateProvenance,
  parseNormativePattern,
  resolveNormativeValue,
  classifyNormativeChange,
  classifySchemaChange,
  evaluateSchemaRule,
  evaluateClPathCheck,
} from './cl-path-check-predicate.mjs';

const CONFIG = {
  exclude: ['**/*.test.ts', '**/__tests__/**'],
  owned_files_rule: {
    requires: 'research/comp-linguist/docs/owned-files.md',
    waiver_line: 'Owned-files: not prompt or metric code',
    paths: ['lib/debate/prompts/**'],
    name_tokens: { dir: 'lib/debate/', extensions: ['.ts'], tokens: ['Gate', 'Metric'] },
  },
  provenance_rule: {
    requires: 'research/comp-linguist/docs/metric-provenance-register.md',
    waiver_line: 'Provenance: unchanged',
    paths: ['lib/debate/calibration-config.json', 'lib/debate/affectSignals.ts'],
  },
  schema_rule: {
    file: 'lib/schema/taxonomy-schema.json',
    list_pointer: 'meta.change_control.normative_fields',
    free_pointer: 'meta.change_control.free_fields',
    change_control_pointer: 'meta.change_control',
  },
};

test('checkApiVersion: missing/mismatched/matching', () => {
  assert.equal(checkApiVersion(undefined, 1).compatible, false);
  assert.equal(checkApiVersion(2, 1).compatible, false);
  assert.equal(checkApiVersion(1, 1).compatible, true);
});

test('matchGlob: ** matches any depth, * matches one segment', () => {
  assert.equal(matchGlob('lib/debate/prompts/foo.ts', 'lib/debate/prompts/**'), true);
  assert.equal(matchGlob('lib/debate/prompts/a/b.ts', 'lib/debate/prompts/**'), true);
  assert.equal(matchGlob('lib/other/foo.ts', 'lib/debate/prompts/**'), false);
});

test('hasWaiverLine: exact-trim match on any line', () => {
  assert.equal(hasWaiverLine('intro\nOwned-files: not prompt or metric code\nmore', 'Owned-files: not prompt or metric code'), true);
  assert.equal(hasWaiverLine('no waiver here', 'Owned-files: not prompt or metric code'), false);
  assert.equal(hasWaiverLine(null, 'x'), false);
});

test('checkOwnedFiles: fires on ADDED path-set match, not modified/removed', () => {
  const added = [{ path: 'lib/debate/prompts/new.ts', status: 'added' }];
  assert.deepEqual(checkOwnedFiles(added, CONFIG), { hits: ['lib/debate/prompts/new.ts'] });

  const modified = [{ path: 'lib/debate/prompts/new.ts', status: 'modified' }];
  assert.equal(checkOwnedFiles(modified, CONFIG), null);
});

test('checkOwnedFiles: name-token heuristic only matches top-level new files with a token', () => {
  const hit = [{ path: 'lib/debate/FooGateHelper.ts', status: 'added' }];
  assert.deepEqual(checkOwnedFiles(hit, CONFIG), { hits: ['lib/debate/FooGateHelper.ts'] });

  const nested = [{ path: 'lib/debate/sub/FooGateHelper.ts', status: 'added' }];
  assert.equal(checkOwnedFiles(nested, CONFIG), null);

  const noToken = [{ path: 'lib/debate/PlainHelper.ts', status: 'added' }];
  assert.equal(checkOwnedFiles(noToken, CONFIG), null);
});

test('checkOwnedFiles: exclude globs apply first', () => {
  const excluded = [{ path: 'lib/debate/prompts/foo.test.ts', status: 'added' }];
  assert.equal(checkOwnedFiles(excluded, CONFIG), null);
});

test('evaluateOwnedFiles: both arms — missing table fires, present table or waiver clears', () => {
  const hit = checkOwnedFiles([{ path: 'lib/debate/prompts/new.ts', status: 'added' }], CONFIG);

  const noTable = evaluateOwnedFiles(hit, ['lib/debate/prompts/new.ts'], '', CONFIG);
  assert.equal(noTable.rule, 'owned-files');

  const withTable = evaluateOwnedFiles(hit, ['lib/debate/prompts/new.ts', 'research/comp-linguist/docs/owned-files.md'], '', CONFIG);
  assert.equal(withTable, null);

  const withWaiver = evaluateOwnedFiles(hit, ['lib/debate/prompts/new.ts'], 'Owned-files: not prompt or metric code', CONFIG);
  assert.equal(withWaiver, null);
});

test('checkProvenance: fires on ADDED or MODIFIED, not removed', () => {
  const added = [{ path: 'lib/debate/affectSignals.ts', status: 'added' }];
  assert.deepEqual(checkProvenance(added, CONFIG), { hits: ['lib/debate/affectSignals.ts'] });

  const modified = [{ path: 'lib/debate/affectSignals.ts', status: 'modified' }];
  assert.deepEqual(checkProvenance(modified, CONFIG), { hits: ['lib/debate/affectSignals.ts'] });

  const removed = [{ path: 'lib/debate/affectSignals.ts', status: 'removed' }];
  assert.equal(checkProvenance(removed, CONFIG), null);
});

test('evaluateProvenance: both arms — missing register fires, present register or waiver clears', () => {
  const hit = checkProvenance([{ path: 'lib/debate/affectSignals.ts', status: 'modified' }], CONFIG);

  const noRegister = evaluateProvenance(hit, ['lib/debate/affectSignals.ts'], '', CONFIG);
  assert.equal(noRegister.rule, 'provenance');

  const withRegister = evaluateProvenance(hit, ['lib/debate/affectSignals.ts', 'research/comp-linguist/docs/metric-provenance-register.md'], '', CONFIG);
  assert.equal(withRegister, null);

  const withWaiver = evaluateProvenance(hit, ['lib/debate/affectSignals.ts'], 'Provenance: unchanged', CONFIG);
  assert.equal(withWaiver, null);
});

test('parseNormativePattern: all three real shapes', () => {
  assert.deepEqual(parseNormativePattern('node_id.grammar'), { kind: 'plain', pointer: 'node_id.grammar' });
  assert.deepEqual(parseNormativePattern('graph_attributes[].type'), { kind: 'keyed', container: 'graph_attributes', field: 'type' });
  assert.deepEqual(parseNormativePattern('situation_relations.*.from/to'), { kind: 'wildcard', container: 'situation_relations', fields: ['from', 'to'] });
});

test('resolveNormativeValue: plain array path resolves as a set', () => {
  const schema = { node_id: { pov: ['acc', 'saf', 'skp'] } };
  const r = resolveNormativeValue(schema, { kind: 'plain', pointer: 'node_id.pov' });
  assert.equal(r.type, 'set');
  assert.equal(r.value.size, 3);
});

test('resolveNormativeValue: plain scalar path resolves as scalar', () => {
  const schema = { node_id: { grammar: '^acc-\\d{3}$' } };
  const r = resolveNormativeValue(schema, { kind: 'plain', pointer: 'node_id.grammar' });
  assert.equal(r.type, 'scalar');
});

test('resolveNormativeValue: keyed (dict-of-dicts) resolves per entry', () => {
  const schema = { graph_attributes: { epistemic_type: { type: 'enum' }, node_scope: { type: 'enum' } } };
  const r = resolveNormativeValue(schema, { kind: 'keyed', container: 'graph_attributes', field: 'type' });
  assert.equal(r.type, 'entries');
  assert.equal(r.value.size, 2);
});

test('classifyNormativeChange: keyed — new entry is addition', () => {
  const base = { graph_attributes: { epistemic_type: { type: 'enum' } } };
  const head = { graph_attributes: { epistemic_type: { type: 'enum' }, node_scope: { type: 'enum' } } };
  const result = classifyNormativeChange(base, head, 'graph_attributes[].type');
  assert.equal(result, 'addition');
});

test('classifyNormativeChange: keyed — existing entry value change is removal_or_retype', () => {
  const base = { graph_attributes: { epistemic_type: { type: 'enum' } } };
  const head = { graph_attributes: { epistemic_type: { type: 'string' } } };
  const result = classifyNormativeChange(base, head, 'graph_attributes[].type');
  assert.equal(result, 'removal_or_retype');
});

test('classifyNormativeChange: keyed — removed entry is removal_or_retype', () => {
  const base = { graph_attributes: { epistemic_type: { type: 'enum' }, node_scope: { type: 'enum' } } };
  const head = { graph_attributes: { epistemic_type: { type: 'enum' } } };
  const result = classifyNormativeChange(base, head, 'graph_attributes[].type');
  assert.equal(result, 'removal_or_retype');
});

test('classifyNormativeChange: set (array) — superset is addition, missing element is removal_or_retype', () => {
  const baseGrown = { edges: { canonical: [{ type: 'SUPPORTS' }] } };
  const headGrown = { edges: { canonical: [{ type: 'SUPPORTS' }, { type: 'CONTRADICTS' }] } };
  assert.equal(classifyNormativeChange(baseGrown, headGrown, 'edges.canonical'), 'addition');

  const baseFull = { edges: { canonical: [{ type: 'SUPPORTS' }, { type: 'CONTRADICTS' }] } };
  const headShrunk = { edges: { canonical: [{ type: 'SUPPORTS' }] } };
  assert.equal(classifyNormativeChange(baseFull, headShrunk, 'edges.canonical'), 'removal_or_retype');
});

test('classifyNormativeChange: set — unchanged stays unchanged', () => {
  const base = { node_id: { pov: ['acc', 'saf'] } };
  const head = { node_id: { pov: ['acc', 'saf'] } };
  assert.equal(classifyNormativeChange(base, head, 'node_id.pov'), 'unchanged');
});

test('classifyNormativeChange: wildcard — new field on an existing entry is a change (removal_or_retype)', () => {
  const base = { situation_relations: { parent: { from: 'sit-*' } } };
  const head = { situation_relations: { parent: { from: 'sit-*', to: 'sit-*' } } };
  assert.equal(classifyNormativeChange(base, head, 'situation_relations.*.from/to'), 'removal_or_retype');
});

test('classifyNormativeChange: wildcard — brand new entry key is addition', () => {
  const base = { situation_relations: { parent: { from: 'sit-*', to: 'sit-*' } } };
  const head = { situation_relations: { parent: { from: 'sit-*', to: 'sit-*' }, groups: { from: 'sit-*', to: 'pov-node' } } };
  assert.equal(classifyNormativeChange(base, head, 'situation_relations.*.from/to'), 'addition');
});

test('classifySchemaChange: worst-case short-circuit across multiple patterns', () => {
  const base = { graph_attributes: { a: { type: 'enum' } }, node_id: { pov: ['acc'] } };
  const headAdditionOnly = { graph_attributes: { a: { type: 'enum' }, b: { type: 'enum' } }, node_id: { pov: ['acc'] } };
  assert.equal(classifySchemaChange(base, headAdditionOnly, ['graph_attributes[].type', 'node_id.pov']), 'addition');

  const headWithRetype = { graph_attributes: { a: { type: 'string' } }, node_id: { pov: ['acc', 'saf'] } };
  assert.equal(classifySchemaChange(base, headWithRetype, ['graph_attributes[].type', 'node_id.pov']), 'removal_or_retype');
});

test('classifySchemaChange: no changes is none', () => {
  const schema = { node_id: { pov: ['acc'] } };
  assert.equal(classifySchemaChange(schema, schema, ['node_id.pov']), 'none');
});

const SCHEMA_RULE = CONFIG.schema_rule;

test('evaluateSchemaRule: fail-closed when base schema is missing', () => {
  const r = evaluateSchemaRule(['lib/schema/taxonomy-schema.json'], null, {}, SCHEMA_RULE);
  assert.equal(r.kind, 'could_not_evaluate');
});

test('evaluateSchemaRule: fail-closed when list_pointer missing/not-array at base', () => {
  const r = evaluateSchemaRule(['lib/schema/taxonomy-schema.json'], { meta: { change_control: {} } }, {}, SCHEMA_RULE);
  assert.equal(r.kind, 'could_not_evaluate');
});

test('evaluateSchemaRule: fail-closed when head schema is missing but base is fine', () => {
  const base = { meta: { change_control: { normative_fields: ['node_id.pov'] } }, node_id: { pov: ['acc'] } };
  const r = evaluateSchemaRule(['lib/schema/taxonomy-schema.json'], base, null, SCHEMA_RULE);
  assert.equal(r.kind, 'could_not_evaluate');
});

test('evaluateSchemaRule: a diff to the file path not touching the schema at all returns null', () => {
  const r = evaluateSchemaRule(['some/other/file.ts'], null, null, SCHEMA_RULE);
  assert.equal(r, null);
});

test('evaluateSchemaRule: list_pointer itself changing is always T2', () => {
  const base = { meta: { change_control: { normative_fields: ['node_id.pov'] } }, node_id: { pov: ['acc'] } };
  const head = { meta: { change_control: { normative_fields: ['node_id.pov', 'node_id.category'] } }, node_id: { pov: ['acc'] } };
  const r = evaluateSchemaRule(['lib/schema/taxonomy-schema.json'], base, head, SCHEMA_RULE);
  assert.equal(r.kind, 'list_changed');
  assert.equal(r.tier, 'T2');
});

test('evaluateSchemaRule: another change_control key changing (not the list, not free_fields) is T1', () => {
  const base = { meta: { change_control: { normative_fields: ['node_id.pov'], normative_edit_rule: 'old text' } }, node_id: { pov: ['acc'] } };
  const head = { meta: { change_control: { normative_fields: ['node_id.pov'], normative_edit_rule: 'new text' } }, node_id: { pov: ['acc'] } };
  const r = evaluateSchemaRule(['lib/schema/taxonomy-schema.json'], base, head, SCHEMA_RULE);
  assert.equal(r.kind, 'change_control_other');
  assert.equal(r.tier, 'T1');
});

test('evaluateSchemaRule: free_fields-only change is a no-op (null)', () => {
  const base = { meta: { change_control: { normative_fields: ['node_id.pov'], free_fields: ['notes'] } }, node_id: { pov: ['acc'] } };
  const head = { meta: { change_control: { normative_fields: ['node_id.pov'], free_fields: ['notes', 'review_by'] } }, node_id: { pov: ['acc'] } };
  const r = evaluateSchemaRule(['lib/schema/taxonomy-schema.json'], base, head, SCHEMA_RULE);
  assert.equal(r, null);
});

test('evaluateSchemaRule: addition-only normative change is T1', () => {
  const base = { meta: { change_control: { normative_fields: ['node_id.pov'] } }, node_id: { pov: ['acc'] } };
  const head = { meta: { change_control: { normative_fields: ['node_id.pov'] } }, node_id: { pov: ['acc', 'saf'] } };
  const r = evaluateSchemaRule(['lib/schema/taxonomy-schema.json'], base, head, SCHEMA_RULE);
  assert.equal(r.kind, 'normative_addition');
  assert.equal(r.tier, 'T1');
});

test('evaluateSchemaRule: removal/retype normative change is T2', () => {
  const base = { meta: { change_control: { normative_fields: ['node_id.pov'] } }, node_id: { pov: ['acc', 'saf'] } };
  const head = { meta: { change_control: { normative_fields: ['node_id.pov'] } }, node_id: { pov: ['acc'] } };
  const r = evaluateSchemaRule(['lib/schema/taxonomy-schema.json'], base, head, SCHEMA_RULE);
  assert.equal(r.kind, 'normative_removal_or_retype');
  assert.equal(r.tier, 'T2');
});

test('evaluateClPathCheck: fail-closed when config itself is missing', () => {
  const r = evaluateClPathCheck({ body: '', tier: null, touchedPaths: [], files: [], config: null, baseSchema: null, headSchema: null });
  assert.equal(r.couldEvaluate, false);
});

test('evaluateClPathCheck: clean PR produces no comments', () => {
  const r = evaluateClPathCheck({
    body: '', tier: null, touchedPaths: ['README.md'], files: [{ path: 'README.md', status: 'modified' }],
    config: CONFIG, baseSchema: null, headSchema: null,
  });
  assert.equal(r.couldEvaluate, true);
  assert.deepEqual(r.comments, []);
});

test('evaluateClPathCheck: combines an owned-files hit and a schema-rule hit in one pass', () => {
  const base = { meta: { change_control: { normative_fields: ['node_id.pov'] } }, node_id: { pov: ['acc'] } };
  const head = { meta: { change_control: { normative_fields: ['node_id.pov'] } }, node_id: { pov: ['acc'] } }; // unchanged, no schema comment
  const r = evaluateClPathCheck({
    body: '', tier: null,
    touchedPaths: ['lib/debate/prompts/new.ts'],
    files: [{ path: 'lib/debate/prompts/new.ts', status: 'added' }],
    config: CONFIG, baseSchema: base, headSchema: head,
  });
  assert.equal(r.couldEvaluate, true);
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0], /owned-files|without updating/);
});

test('evaluateClPathCheck: editing cl-path-sets.json itself is flagged', () => {
  const r = evaluateClPathCheck({
    body: '', tier: null,
    touchedPaths: ['research/comp-linguist/docs/cl-path-sets.json'],
    files: [{ path: 'research/comp-linguist/docs/cl-path-sets.json', status: 'modified' }],
    config: CONFIG, baseSchema: null, headSchema: null,
  });
  assert.equal(r.couldEvaluate, true);
  assert.match(r.comments[0], /cl-path-sets\.json itself changed/);
});
