/**
 * Pure predicate for the advisory CL path-coupling check (t/4151, t/4109 migration C).
 *
 * Moves CL rules #2 (owned-files table), #3 (provenance register) and #9 (normative schema-edit
 * tiering) into an advisory, comment-only PR check. The path sets are CL-owned
 * (`research/comp-linguist/docs/cl-path-sets.json`), so CL can change them without a DevOps
 * change (TL ruling, t/4151#2). Config AND the schema's own normative-field list are read from
 * the BASE revision, never the PR head — otherwise a PR could narrow a set or the field list in
 * the same diff that should be caught by it (t/4151#2, same anti-self-narrowing posture as
 * tier-check's base-tip config load).
 *
 * Fail-closed (t/4151#2): a missing or unparseable base config, or a missing/unparseable
 * `taxonomy-schema.json` / normative-field list at base, reports "could not evaluate" visibly.
 * Never a silent pass.
 *
 * Known blanks, named up front (the 14-day replay this ticket asks for is how these get
 * measured, not engineered away before there is data):
 *  - the owned-files `name_tokens` heuristic is a heuristic; a new `lib/debate/FooGateHelper.ts`
 *    that has nothing to do with scoring/gating still matches on the `Gate` token.
 *  - the schema-rule's per-pattern classifier (below) does not understand every conceivable JSON
 *    reshape — it classifies by entry-identity and set-containment, which covers every pattern
 *    shape actually present in `normative_fields` today, but a pattern shape added later that
 *    doesn't fit "plain dotted", "key[].field" or "key.*.field" needs a predicate update.
 *  - this check is advisory only; it has no self-narrowing defense against an edit to the
 *    workflow file itself, same named blank as tier-check.
 */

/**
 * Contract version for everything the workflow imports from this module when loading it from
 * the base branch's live tip (not the PR's own head copy). Same purpose and same anti-self-
 * narrowing rationale as tier-check's TIER_CHECK_API (t/4103#14): under `pull_request`, the
 * checked-out head copy of THIS file is the PR's own code, so the workflow never imports it
 * directly — only the base-tip copy is trusted. A mismatch or missing export reads as a neutral
 * "skipped (skew/bootstrap)", never a crash and never a silent pass. Bump whenever an exported
 * name, its signature, or its return shape changes in a way the workflow depends on.
 */
export const CL_PATH_CHECK_API = 1;

/** @param {number|undefined} actualVersion @param {number} expectedVersion */
export function checkApiVersion(actualVersion, expectedVersion) {
  if (typeof actualVersion !== 'number') {
    return { compatible: false, reason: 'base predicate has no CL_PATH_CHECK_API export (pre-versioning, or not yet installed on base)' };
  }
  if (actualVersion !== expectedVersion) {
    return { compatible: false, reason: `base predicate API version ${actualVersion} does not match this workflow's expected ${expectedVersion}` };
  }
  return { compatible: true, reason: null };
}

// ── Path/glob matching (gitignore-style **, shared with the exclude list and every path set) ──

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Supports '**' (any number of path segments, including none) and '*' (one segment, no '/'). */
export function matchGlob(filePath, glob) {
  const pattern = glob
    .split('**')
    .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
    .join('.*');
  return new RegExp('^' + pattern + '$').test(filePath);
}

export function matchAnyGlob(filePath, globs) {
  return (globs ?? []).some((g) => matchGlob(filePath, g));
}

function isExcluded(filePath, config) {
  return matchAnyGlob(filePath, config.exclude);
}

// ── PR body waiver-line / schema-change-line style helpers ──

export function hasWaiverLine(body, waiverLine) {
  if (!body || !waiverLine) return false;
  return body.split('\n').some((line) => line.trim() === waiverLine.trim());
}

// ── Rule 1: owned-files table ──

/**
 * @param {Array<{path:string, status:'added'|'modified'|'removed'|'renamed'}>} files
 * @param {{exclude:string[], owned_files_rule:{paths:string[], name_tokens:{dir:string, extensions:string[], tokens:string[]}}}} config
 */
export function checkOwnedFiles(files, config) {
  const rule = config.owned_files_rule;
  const hits = [];
  for (const f of files) {
    if (f.status !== 'added') continue;
    if (isExcluded(f.path, config)) continue;
    if (matchAnyGlob(f.path, rule.paths)) {
      hits.push(f.path);
      continue;
    }
    const nt = rule.name_tokens;
    if (nt && f.path.startsWith(nt.dir) && !f.path.slice(nt.dir.length).includes('/')) {
      const base = f.path.slice(nt.dir.length);
      if ((nt.extensions ?? []).some((ext) => base.endsWith(ext)) && nt.tokens.some((t) => base.includes(t))) {
        hits.push(f.path);
      }
    }
  }
  if (hits.length === 0) return null;
  return { hits };
}

/** @param {ReturnType<typeof checkOwnedFiles>} result @param {string[]} touchedPaths @param {string} body @param {{owned_files_rule:{requires:string, waiver_line:string}}} config */
export function evaluateOwnedFiles(result, touchedPaths, body, config) {
  if (!result) return null;
  const rule = config.owned_files_rule;
  if (touchedPaths.includes(rule.requires)) return null;
  if (hasWaiverLine(body, rule.waiver_line)) return null;
  return {
    rule: 'owned-files',
    detail: `adds ${result.hits.join(', ')} without updating ${rule.requires} (or the waiver line \`${rule.waiver_line}\`)`,
  };
}

// ── Rule 2: provenance register ──

/** @param {Array<{path:string, status:string}>} files @param {object} config */
export function checkProvenance(files, config) {
  const rule = config.provenance_rule;
  const hits = [];
  for (const f of files) {
    if (f.status !== 'added' && f.status !== 'modified') continue;
    if (isExcluded(f.path, config)) continue;
    if (matchAnyGlob(f.path, rule.paths)) hits.push(f.path);
  }
  return hits.length === 0 ? null : { hits };
}

export function evaluateProvenance(result, touchedPaths, body, config) {
  if (!result) return null;
  const rule = config.provenance_rule;
  if (touchedPaths.includes(rule.requires)) return null;
  if (hasWaiverLine(body, rule.waiver_line)) return null;
  return {
    rule: 'provenance',
    detail: `touches ${result.hits.join(', ')} without updating ${rule.requires} (or the waiver line \`${rule.waiver_line}\`)`,
  };
}

// ── Rule 3: normative schema-edit tiering ──

/** Resolve a plain dotted path (no '[]', no '*') against an object. Returns undefined if absent. */
function getByPointer(obj, pointer) {
  return pointer.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * Parses one `normative_fields` entry into a classifiable shape descriptor.
 * @param {string} pattern
 */
export function parseNormativePattern(pattern) {
  let m = /^([^.[]+)\[\]\.(.+)$/.exec(pattern);
  if (m) return { kind: 'keyed', container: m[1], field: m[2] };
  m = /^([^.[]+)\.\*\.(.+)$/.exec(pattern);
  if (m) {
    const fields = m[2].split('/');
    return { kind: 'wildcard', container: m[1], fields };
  }
  return { kind: 'plain', pointer: pattern };
}

/**
 * Resolves one parsed pattern against a full schema object, returning a classification-ready
 * shape: `{ type: 'set', value: Set }` for array-like normative data (addition-only iff
 * base-set subset of head-set), or `{ type: 'entries', value: Map<string, any> }` for
 * per-named-entry fields (new key = addition, changed value for an existing key = retype,
 * missing key = removal).
 * @param {object} schema @param {ReturnType<typeof parseNormativePattern>} parsed
 */
export function resolveNormativeValue(schema, parsed) {
  if (parsed.kind === 'plain') {
    const v = getByPointer(schema, parsed.pointer);
    if (Array.isArray(v)) return { type: 'set', value: new Set(v.map((x) => JSON.stringify(x))) };
    return { type: 'scalar', value: v === undefined ? undefined : JSON.stringify(v) };
  }
  const container = schema?.[parsed.container];
  if (container == null || typeof container !== 'object') return { type: 'entries', value: new Map() };
  const entries = new Map();
  for (const [entryKey, entryVal] of Object.entries(container)) {
    if (parsed.kind === 'keyed') {
      const fv = entryVal?.[parsed.field];
      entries.set(entryKey, fv === undefined ? undefined : JSON.stringify(fv));
    } else {
      // wildcard: one combined value per entry across all its fields, so a change to ANY of
      // them (e.g. either 'from' or 'to') is visible as a value change for that entry.
      const combined = {};
      for (const f of parsed.fields) combined[f] = entryVal?.[f];
      entries.set(entryKey, JSON.stringify(combined));
    }
  }
  return { type: 'entries', value: entries };
}

/**
 * Classifies one normative pattern's change between base and head schema objects.
 * @returns {'unchanged'|'addition'|'removal_or_retype'}
 */
export function classifyNormativeChange(baseSchema, headSchema, pattern) {
  const parsed = parseNormativePattern(pattern);
  const base = resolveNormativeValue(baseSchema, parsed);
  const head = resolveNormativeValue(headSchema, parsed);

  if (base.type === 'scalar') {
    if (base.value === head.value) return 'unchanged';
    // A field appearing for the first time where it was entirely absent before is additive;
    // any other scalar change (including disappearing) is not.
    if (base.value === undefined && head.value !== undefined) return 'addition';
    return 'removal_or_retype';
  }

  if (base.type === 'set') {
    if (base.value.size === head.value.size && [...base.value].every((v) => head.value.has(v))) return 'unchanged';
    const allBaseStillPresent = [...base.value].every((v) => head.value.has(v));
    return allBaseStillPresent ? 'addition' : 'removal_or_retype';
  }

  // entries
  let sawAddition = false;
  let sawChange = false;
  for (const [key, baseVal] of base.value) {
    if (!head.value.has(key)) return 'removal_or_retype'; // removed entry
    if (head.value.get(key) !== baseVal) sawChange = true;
  }
  for (const key of head.value.keys()) {
    if (!base.value.has(key)) sawAddition = true;
  }
  if (sawChange) return 'removal_or_retype';
  if (sawAddition) return 'addition';
  return 'unchanged';
}

/**
 * @param {object|null} baseSchema @param {object|null} headSchema @param {string[]} normativeFields
 * @returns {'none'|'addition'|'removal_or_retype'}
 */
export function classifySchemaChange(baseSchema, headSchema, normativeFields) {
  let worst = 'none';
  for (const pattern of normativeFields) {
    const c = classifyNormativeChange(baseSchema, headSchema, pattern);
    if (c === 'removal_or_retype') return 'removal_or_retype'; // worst case short-circuit
    if (c === 'addition') worst = 'addition';
  }
  return worst;
}

/**
 * Top-level rule 3 evaluation.
 * @param {string[]} touchedPaths
 * @param {object|null} baseSchema parsed base taxonomy-schema.json, or null if missing/unparseable
 * @param {object|null} headSchema parsed head taxonomy-schema.json, or null if missing/unparseable
 * @param {{file:string, list_pointer:string, free_pointer:string, change_control_pointer:string}} schemaRule
 */
export function evaluateSchemaRule(touchedPaths, baseSchema, headSchema, schemaRule) {
  if (!touchedPaths.includes(schemaRule.file)) return null;

  if (baseSchema == null) {
    return { rule: 'schema', kind: 'could_not_evaluate', detail: `${schemaRule.file} changed, but the base revision's copy is missing or unparseable — could not evaluate` };
  }

  const normativeFields = getByPointer(baseSchema, schemaRule.list_pointer);
  if (!Array.isArray(normativeFields)) {
    return { rule: 'schema', kind: 'could_not_evaluate', detail: `${schemaRule.list_pointer} is missing or not an array at the base revision — could not evaluate` };
  }

  if (headSchema == null) {
    return { rule: 'schema', kind: 'could_not_evaluate', detail: `${schemaRule.file} changed, but the head revision's copy is missing or unparseable — could not evaluate` };
  }

  // A diff to the list itself is always T2, regardless of any other classification.
  const baseList = JSON.stringify(normativeFields);
  const headListRaw = getByPointer(headSchema, schemaRule.list_pointer);
  const headList = JSON.stringify(headListRaw);
  if (baseList !== headList) {
    return { rule: 'schema', kind: 'list_changed', tier: 'T2', detail: `${schemaRule.list_pointer} itself changed — Tier: T2, gate config changed, CL review` };
  }

  // Any other change_control key besides the list (and besides free_fields, which is patch/no-op).
  const baseCC = getByPointer(baseSchema, schemaRule.change_control_pointer) ?? {};
  const headCC = getByPointer(headSchema, schemaRule.change_control_pointer) ?? {};
  const listKey = schemaRule.list_pointer.split('.').pop();
  const freeKey = schemaRule.free_pointer.split('.').pop();
  const otherKeyChanged = Object.keys({ ...baseCC, ...headCC }).some((k) => {
    if (k === listKey || k === freeKey) return false;
    return JSON.stringify(baseCC[k]) !== JSON.stringify(headCC[k]);
  });
  if (otherKeyChanged) {
    return { rule: 'schema', kind: 'change_control_other', tier: 'T1', detail: `${schemaRule.change_control_pointer} changed (outside ${listKey}/${freeKey}) — Tier: T1, gate config, CL review` };
  }

  const classification = classifySchemaChange(baseSchema, headSchema, normativeFields);
  if (classification === 'none') return null;
  if (classification === 'addition') {
    return { rule: 'schema', kind: 'normative_addition', tier: 'T1', detail: 'normative field addition-only — Tier: T1, CL approval plus the normal Quality reviewer' };
  }
  return { rule: 'schema', kind: 'normative_removal_or_retype', tier: 'T2', detail: 'normative field removal or retype — Tier: T2, CL review (t/3361 SO bar)' };
}

// ── Combine ──

/**
 * @param {{body:string, tier:string|null, touchedPaths:string[], files:Array<{path:string,status:string}>, config:object|null, baseSchema:object|null, headSchema:object|null}} input
 */
export function evaluateClPathCheck(input) {
  const { body, tier, touchedPaths, files, config, baseSchema, headSchema } = input;

  if (config == null) {
    return { couldEvaluate: false, comments: ['cl-path-sets.json is missing or unparseable at the base revision — could not evaluate'] };
  }

  const comments = [];

  if (touchedPaths.includes('research/comp-linguist/docs/cl-path-sets.json')) {
    comments.push('cl-path-sets.json itself changed — gate config changed, CL review');
  }

  const owned = evaluateOwnedFiles(checkOwnedFiles(files, config), touchedPaths, body, config);
  if (owned) comments.push(owned.detail);

  const prov = evaluateProvenance(checkProvenance(files, config), touchedPaths, body, config);
  if (prov) comments.push(prov.detail);

  const schema = evaluateSchemaRule(touchedPaths, baseSchema, headSchema, config.schema_rule);
  if (schema) {
    if (schema.kind === 'could_not_evaluate') {
      return { couldEvaluate: false, comments: [...comments, schema.detail] };
    }
    const tierMismatch = tier !== schema.tier;
    comments.push(tierMismatch ? `${schema.detail} (declared: ${tier ?? '(none)'})` : schema.detail);
  }

  return { couldEvaluate: true, comments };
}
