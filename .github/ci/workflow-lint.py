#!/usr/bin/env python3
"""Workflow lint gate — enforces three conventions across all workflow YAML files.

Checks:
  1. All action `uses:` refs must be SHA-pinned (40-hex commit SHA), not tag/branch refs.
     Matches BOTH plain key form ('        uses: a/b@ref') AND compact list-item form
     ('      - uses: a/b@ref').  The original USES_RE missed the compact form (t/2529 GV fail).
  2. `${{ inputs.VARNAME }}` must not appear directly in shell run blocks — use env-var indirection.
     Bare refs only; conditional expressions (${{ inputs.X == 'val' && ... }}) are safe.
  3. Every workflow file must declare a `permissions:` block (workflow-level or job-level).

Run with --self-test to execute the built-in fixture tests (both syntax forms must be caught).
Exit 0 = all checks pass. Exit 1 = violations found or self-test failed.
Mechanically catches the M14/M15/L8 failure classes (t/2529).
"""
import re
import sys
import glob

SHA_RE = re.compile(r'^[0-9a-f]{40}$')

# Matches both forms:
#   plain key:       '        uses: owner/action@REF'
#   compact step:    '      - uses: owner/action@REF'
# Excludes local workflow calls (./path) which don't need SHA pins.
USES_RE = re.compile(r'^\s*(?:-\s+)?uses:\s+([^./]\S+)@(\S+)')

# Only flag bare ${{ inputs.VARNAME }} — raw value reaches the shell (injection risk).
# Safe: ${{ inputs.X == 'val' && '1' || '' }} — expression produces a bounded value;
# GitHub Actions evaluates the expression before the shell runs, never exposing the raw input.
INPUTS_RE = re.compile(r'\$\{\{\s*inputs\.\w+\s*\}\}')

PERMISSIONS_RE = re.compile(r'^\s*permissions:', re.MULTILINE)

# GitHub's documented GITHUB_TOKEN permission scopes (t/4347). An invalid key here isn't a
# style nit -- GitHub rejects the entire workflow file, killing every trigger it declares.
PERMISSION_ALLOWLIST = {
    'actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions',
    'id-token', 'issues', 'models', 'packages', 'pages', 'pull-requests',
    'repository-projects', 'security-events', 'statuses',
}

# t/4414 (e/349#6, SO follow-up): "an alert issue opened without a watched label" is a class --
# continuous-deploy.yml's dead-gate issue (#3771) opened once, then sat unseen for two days because
# nothing watched its label. This check flags any `gh issue create`/`gh issue edit` call in a run:
# block that doesn't apply the label the r/23 escalation bridge (Get-CiAlertEscalations.ps1) watches
# -- or carry an exemption comment recording why it's covered another way. WARN-ONLY for now, same
# promotion discipline as the required-context rules above (t/3646): a later blocking-promotion PR
# needs its own evidence + its own Second Opinion, not bundled into this one.
#
# SCOPE (e/349#10, SO): THIS repo's rule is `alert-escalated` -> the r/23 bridge. The sibling
# `ai-triad-data` repo uses a DIFFERENT, already-correct mapping -- `data-compliance` -> the r/25
# sweep (bdi-boundary, citation-link-integrity, data-compliance-watchdog, large-file-guard,
# source-index-regen, taxonomy-node-removal all apply it; the watchdog adds `bridge-stale` for its
# own staleness alerts). This check only scans `.github/workflows/*.yml` in THIS repo and
# deliberately does not, and should not, apply the alert-escalated rule there.
ALERT_LABEL = 'alert-escalated'
GH_ISSUE_CREATE_RE = re.compile(r'\bgh issue create\b')
# SO e/349#8 point 2: only an edit that TOUCHES LABELS is the alert path -- a plain
# close/comment (the auto-resolve path) never needs alert-escalated.
GH_ISSUE_EDIT_ALERT_RE = re.compile(r'\bgh issue edit\b.*(?:--add-label|--remove-label)')
# github-script's `github.rest.issues.create(` (e/349#8): deliberately does NOT match
# `.createComment(` -- "create" immediately followed by "Comment" has no "(" right after
# "create", so this regex (which requires create( or create\s*() never matches it.
JS_ISSUES_CREATE_RE = re.compile(r'issues\.create\s*\(')
ALERT_LABEL_EXEMPT_RE = re.compile(r'(?:#|//)\s*lint:alert-label-exempt:\s*(t/\d+|\d{4}-\d{2}-\d{2})\s+\S')


def parse_step_key(line):
    """Return (key_name, line_indent) for a YAML key line, handling compact list-item form.

    Examples:
      '        run: |'       → ('run', 8)
      '      - run: cmd'     → ('run', 6)   # indent = position of dash
      '        uses: a/b@c'  → ('uses', 8)
      '      - uses: a/b@c'  → ('uses', 6)
    Returns (None, indent) when the line is not a YAML key line.
    """
    s = line.lstrip()
    indent = len(line) - len(s)
    if s.startswith('- '):
        s = s[2:].lstrip()
    if ':' not in s:
        return None, indent
    key = s.split(':')[0].strip()
    if re.match(r'^\w[\w-]*$', key):
        return key, indent
    return None, indent


def lint_file(path, content):
    """Return list of violation strings for one workflow file."""
    errs = []
    lines = content.splitlines()

    # ── Check 1: unpinned actions ──────────────────────────────────────────────
    for i, line in enumerate(lines, 1):
        m = USES_RE.match(line)
        if m:
            ref = m.group(2).split('#')[0].strip()
            if not SHA_RE.match(ref):
                errs.append(f'{path}:{i}: unpinned action ref @{ref!r} — pin to 40-char hex SHA')

    # ── Check 2: bare ${{ inputs.* }} in shell run blocks ─────────────────────
    # Walk lines tracking whether we're inside a `run:` value context.
    in_run = False
    run_indent = 0
    for i, line in enumerate(lines, 1):
        key, indent = parse_step_key(line)

        if key is not None:
            if key == 'run':
                in_run = True
                run_indent = indent
                # Check inline run: value (same line, not a block scalar marker)
                s = line.lstrip()
                if s.startswith('- '):
                    s = s[2:].lstrip()
                rest = s[len('run:'):].strip()
                if rest and rest not in ('|', '|-', '>'):
                    if INPUTS_RE.search(rest):
                        errs.append(
                            f'{path}:{i}: direct ${{{{ inputs.* }}}} in inline run: — '
                            f'use env: block for shell indirection'
                        )
            elif in_run and indent <= run_indent:
                in_run = False
        elif in_run:
            stripped = line.lstrip()
            if stripped and len(line) - len(stripped) > run_indent:
                if INPUTS_RE.search(line):
                    errs.append(
                        f'{path}:{i}: direct ${{{{ inputs.* }}}} in run block content — '
                        f'use env: block for shell indirection'
                    )
            elif stripped and len(line) - len(stripped) <= run_indent:
                in_run = False

    # ── Check 3: missing permissions block ────────────────────────────────────
    if not PERMISSIONS_RE.search(content):
        errs.append(f'{path}: no permissions: block — add explicit minimal permissions')

    # ── Check 4: permissions: keys against GitHub's documented allowlist (t/4347) ──
    # PR #3527 (t/4340, TL review): environment-branch-policy-check.yml declared
    # `permissions: { environments: read }` -- not a real GITHUB_TOKEN permission key.
    # GitHub rejected the entire file outright (run 39478983829: a push-event run with
    # ZERO jobs and conclusion failure, for a workflow with no push: trigger at all) --
    # workflow-lint ran and passed, but nothing had proved the file was actually valid
    # against GitHub's own acceptance of it. This check closes that: any `permissions:`
    # child key not in the allowlist below is flagged, since GitHub rejects the WHOLE
    # file on an invalid key, which silently kills every trigger the workflow declares,
    # not just the job that would have used that permission.
    errs.extend(_check_permissions_allowlist(path, content))

    return errs


def _check_permissions_allowlist(path, content):
    """Check 4 (t/4347): every `permissions:` block's child keys must be in GitHub's
    documented GITHUB_TOKEN permission set. Does NOT flag the shorthand forms
    `permissions: read-all` / `write-all` / `none` / `{}` -- those have no child keys to
    validate."""
    errs = []
    lines = content.splitlines()
    for i, line in enumerate(lines):
        key, indent = parse_step_key(line)
        if key != 'permissions':
            continue
        s = line.lstrip()
        if s.startswith('- '):
            s = s[2:].lstrip()
        rest = s[len('permissions:'):].strip()
        if rest and rest != '{}':
            continue  # shorthand form (read-all/write-all/none/an expression) -- no child keys
        j = i + 1
        while j < len(lines):
            cline = lines[j]
            cstripped = cline.strip()
            if not cstripped:
                j += 1
                continue
            cindent = len(cline) - len(cline.lstrip())
            if cindent <= indent:
                break
            ckey, _ = parse_step_key(cline)
            if ckey is not None and ckey not in PERMISSION_ALLOWLIST:
                errs.append(
                    f'{path}:{j + 1}: permissions: key {ckey!r} is not a real GITHUB_TOKEN '
                    f'permission -- GitHub rejects the WHOLE workflow file on an invalid key '
                    f'(every trigger silently dead, not just this permission). Valid keys: '
                    f'{", ".join(sorted(PERMISSION_ALLOWLIST))}.'
                )
            j += 1
    return errs


# ─────────────────────────────────────────────────────────────────────────────
# t/3646: a workflow that PROVIDES a REQUIRED status context must never be able to
# fail-to-report or report a stale verdict. Applied ONLY to the files named in the
# SSOT (.github/ci/required-contexts.json). These are the invariants — a reader can
# DIFF this list against the code below, not just trust a prose claim (TL t/3646#1):
#   R1  no `paths:`/`paths-ignore:` UNDER `pull_request:` — a path filter means the
#       check may not run, which is incompatible with "required".
#   R2  the reporting job (job id == context name) `if:` must be ABSENT or EXACTLY
#       `always()`. NOT "starts with always()": `always() && github.event_name==push`
#       starts with always() yet skips on pull_request → the required context hangs
#       forever (TL t/3646#2). A genuine `always() && X` must carry a co-located
#       `# lint:allow-if: <reason>` exemption.
#   R3  EXACTLY ONE `# lint:gated-events: <csv>` declaration per file, PRESENT and
#       NON-EMPTY, and `on.pull_request.types` must be a SUPERSET of it. Empty/missing
#       => failure ("empty/malformed declaration"), never a vacuous pass on `types ⊇ {}`
#       (TL t/3646#3). >1 declaration => failure — the scan is first-match-wins, so a
#       second would be silently ignored (TL t/3646#1333).
#       LIMIT (SO e/209#2): R3 asserts `types ⊇ declaration` — CONSISTENCY, not
#       COMPLETENESS. A declaration that is itself incomplete (author's blind spot)
#       passes. Catching an incomplete declaration against the code is t/3663.
#   R4  no `concurrency: cancel-in-progress:` set to anything but the literal `false`.
#       The old `: true` literal match missed the expression idiom
#       `${{ github.ref != 'refs/heads/main' }}`, which evaluates true on exactly the PRs
#       a required context protects (SO/TL e/209). Flag any value that is not `false`.
#   R5  a reporting job with `if: always()` runs regardless of whether its `needs:` passed,
#       so it is a false-green unless it (a) asserts over `needs.*.result` AND (b) carries a
#       co-located `# lint:skipped-tolerated: yes|no <why>` declaration that AGREES with the
#       gating `if:` (yes => the `if:` must not reference `skipped`; no => it must). The
#       `skipped`-reference scan is scoped to `^if:` lines ONLY — comments mention `skipped`
#       all over ci.yml and a body-wide search false-REDs the gate (TL e/209#14). Pairing is
#       consistency (inherits R3's limit); the structural legit-vs-Arm-E skip discriminator
#       is t/3663.
RC_SSOT_PATH = '.github/ci/required-contexts.json'
# BLOCKING as of t/3646 flip (warn-cycle green + drift-guard green on main #2418 + live-fire
# RED+GREEN in real CI #2430/#2431 + mandatory Second Opinion e/209 with TL sign-off). A
# required-context violation now reds the workflow-lint job → ci-gate → blocks the PR.
REQUIRED_CONTEXT_BLOCKING = True
GATED_EVENTS_RE = re.compile(r'#\s*lint:gated-events:\s*(.*)$')
ALLOW_IF_RE = re.compile(r'#\s*lint:allow-if:\s*\S')
# R5(b): `# lint:skipped-tolerated: yes|no <why>` — disposition (group 1) + mandatory reason (group 2).
SKIPPED_TOL_RE = re.compile(r'#\s*lint:skipped-tolerated:\s*(yes|no)\b(.*)$')
# Condition 3 (SO/TL e/209) — allow-if ratchet: the committed count of `# lint:allow-if:` exemptions
# across SSOT workflows. `actual != expected` fails. Baseline 0 today; the FIRST legitimate allow-if
# must bump this in the same commit (that is the ratchet working as designed, not a bug).
ALLOW_IF_EXPECTED = 0
# t/3663 Half-B: `# lint:tolerated-skip: <job> <ticket-or-date> <why>` — declares that a needed job
# which can skip WITHOUT gating on `needs.changes.outputs.*` is a deliberately-tolerated skip. The
# ticket ref (t/NNNN) or ISO date is MANDATORY (TL cond 3) — a bare <why> is an unauditable
# suppression list; the ref/date lets a stale exemption be found later.
TOLERATED_SKIP_RE = re.compile(r'#\s*lint:tolerated-skip:\s*(\S+)\s+(t/\d+|\d{4}-\d{2}-\d{2})\b')
# Loose form: detect a present-but-malformed marker (missing the ref/date) so it is FLAGGED, not
# silently ignored — a tolerated-skip with no audit anchor must fail the rule (TL cond 3).
TOLERATED_SKIP_ANY_RE = re.compile(r'#\s*lint:tolerated-skip:\s*(.*)$')


def _strip_comment(line):
    """t/3663 (TL cond 1): drop a `#` comment (whole-line or trailing) before scanning a job body,
    so a token mentioned ONLY in a comment does NOT raise the gated-events floor. Errs toward NOT
    matching (a `#` inside a quoted string is rare and a false negative is the safe direction for a
    warn-only heuristic — a false positive is what gets the whole rule muted)."""
    return re.sub(r'(^|\s)#.*$', '', line)


def _block_end(lines, header_idx, header_indent):
    """Index one past the last line of the block whose header is at lines[header_idx]
    (column header_indent). Body = lines after the header until the next non-blank,
    non-comment line whose indent <= header_indent."""
    j = header_idx + 1
    while j < len(lines):
        stripped = lines[j].strip()
        if stripped == '' or stripped.startswith('#'):
            j += 1
            continue
        indent = len(lines[j]) - len(lines[j].lstrip())
        if indent <= header_indent:
            break
        j += 1
    return j


def _find_key(lines, key, indent, start=0, end=None):
    """Return the index of the first `<indent spaces>key:` line in [start, end), else -1."""
    if end is None:
        end = len(lines)
    pat = re.compile(r'^' + (' ' * indent) + re.escape(key) + r'\s*:')
    for i in range(start, end):
        if pat.match(lines[i]):
            return i
    return -1


def _parse_inline_list(value):
    """`[a, b, c]` -> ['a','b','c']; returns None if not an inline [..] list."""
    v = value.strip()
    if not (v.startswith('[') and v.endswith(']')):
        return None
    inner = v[1:-1].strip()
    if inner == '':
        return []
    return [x.strip() for x in inner.split(',') if x.strip()]


def _find_reporting_job(lines, jobs_idx, context_name):
    """Return the index of the job that POSTS the required check-run named `context_name`, else -1.

    INVARIANT (t/3691, TL e/215#6): the posted check-run name is the job's `name:` if set, else its
    id — and a matrix expands it to `name (value)`. `needs:` references the job id and is unaffected.
    Both the SSOT<->API and SSOT<->job comparisons are exact string equality, so a gated job must not
    be matrixed (live example: `test-powershell` was matrixed by t/3668 and could not become a
    required context as-is), and no normalization — case-folding, trim — may be introduced on either
    side without breaking the transitivity that closes the seam.

    Return the job whose POSTED name equals context_name, where posted name = the job's `name:` if
    set, ELSE its id. This is NOT "name-first then id-fallback across all jobs": a job that sets
    `name: X` posts its check-run as "X" and must NOT match a context equal to its id Y — matching it
    by id would be the SO's "misleading green" (e/215#2), a context that never reports while the lint
    passes. `ci-gate` sets `name: ci-gate` == its id (resolves by the name route); `joint-gv-guard`
    sets no `name:` (resolves by id) — both correct, by different routes.
    """
    jobs_end = _block_end(lines, jobs_idx, 0)
    j = jobs_idx + 1
    while j < jobs_end:
        m = re.match(r'^ {2}([\w-]+):\s*(#.*)?$', lines[j])  # an indent-2 job-id header
        if m:
            job_id = m.group(1)
            job_end = _block_end(lines, j, 2)
            # A matrixed job posts `name (value)` check-runs — NEVER the bare name/id — so it cannot
            # satisfy a bare required context. Skip it, so a matrixed reporting job yields R2 "no job
            # posts X" (mechanizing the "a gated job must not be matrixed" invariant, t/3691 / TL
            # e/215#6; live near-instance: `test-powershell` sharded by t/3668, posts `... (1)`/`(2)`).
            strat_idx = _find_key(lines, 'strategy', 4, j + 1, job_end)
            if strat_idx != -1 and _find_key(lines, 'matrix', 6, strat_idx + 1, job_end) != -1:
                j = job_end
                continue
            name_idx = _find_key(lines, 'name', 4, j + 1, job_end)
            posted = lines[name_idx].split(':', 1)[1].strip().strip('\'"') if name_idx != -1 else job_id
            if posted == context_name:
                return j
            j = job_end
        else:
            j += 1
    return -1


def load_required_contexts(root='.'):
    """Load the SSOT. Returns (entries, error_or_None). Missing/malformed SSOT is a hard
    error (a required-context lint with no list is itself the silent-no-op failure)."""
    import json, os
    p = os.path.join(root, RC_SSOT_PATH)
    if not os.path.exists(p):
        return [], f'{RC_SSOT_PATH}: SSOT missing — cannot lint required-context workflows'
    try:
        with open(p, encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:  # noqa: BLE001
        return [], f'{RC_SSOT_PATH}: malformed JSON ({e})'
    entries = data.get('required_contexts')
    if not isinstance(entries, list) or not entries:
        return [], f'{RC_SSOT_PATH}: required_contexts must be a non-empty array'
    return entries, None


def check_required_context(path, content, context_name, posts=None):
    """Return violation strings for a required-context workflow file (R1–R5).

    `posts` (t/3691): the SSOT entry's optional `posts` marker. `posts == 'app-aggregate'` means the
    check-run is posted by a GitHub App as an aggregate (e.g. CodeQL), NOT by a job in this file — so
    the FILE-level rules (R1/R3/R4) still apply, but the JOB-level rules (R2/R5, which look up a job
    whose posted name == context_name) are N/A and skipped. A verifiable claim, not a bare opt-out
    (app-posted = bare `/runs/<id>` status; a workflow job = `/actions/runs/.../job/`) — SO e/215#2."""
    errs = []
    lines = content.splitlines()
    gated_decl = None            # t/3663: hoisted so the Half-A completeness floor (in the jobs
    has_branches_filter = False  #   section below) can compare the declaration against the job body

    # Locate on.pull_request block (indent 2 under `on:`).
    pr_idx = _find_key(lines, 'pull_request', 2)
    if pr_idx == -1:
        errs.append(f'{path}: required context "{context_name}" — no `pull_request:` trigger; a required PR check must run on pull_request')
        pr_end = 0
    else:
        pr_end = _block_end(lines, pr_idx, 2)
        # t/3663 Half-A input: a `branches:` filter under pull_request means a base-retarget (which
        # arrives as an `edited` event) can flip whether this required context should run — so the
        # floor will require `edited` in the declaration.
        has_branches_filter = _find_key(lines, 'branches', 4, pr_idx + 1, pr_end) != -1
        # R1: no paths / paths-ignore inside pull_request
        for i in range(pr_idx + 1, pr_end):
            if re.match(r'^\s{4}paths(-ignore)?\s*:', lines[i]):
                errs.append(f'{path}:{i + 1}: R1 required context "{context_name}" — `paths:`/`paths-ignore:` under pull_request can skip the check → a required context that may never report')

        # R3: types superset of a present+non-empty gated-events declaration
        types_idx = _find_key(lines, 'types', 4, pr_idx + 1, pr_end)
        types_list = None
        if types_idx != -1:
            val = lines[types_idx].split(':', 1)[1]
            types_list = _parse_inline_list(val)
        # Exactly ONE declaration per file. The scan is first-match-wins, so a second
        # declaration would be SILENTLY ignored (TL t/3646#1333) — flag >1 explicitly.
        gated_matches = [m for m in (GATED_EVENTS_RE.search(ln) for ln in lines) if m]
        if len(gated_matches) > 1:
            errs.append(f'{path}: R3 required context "{context_name}" — {len(gated_matches)} `# lint:gated-events:` declarations found; exactly ONE per file (a second would be silently ignored)')
        else:
            gated_decl = [x.strip() for x in gated_matches[0].group(1).split(',') if x.strip()] if gated_matches else None
            if gated_decl is None:
                errs.append(f'{path}: R3 required context "{context_name}" — missing `# lint:gated-events:` declaration (name every event that can change the gated condition)')
            elif len(gated_decl) == 0:
                errs.append(f'{path}: R3 required context "{context_name}" — EMPTY `# lint:gated-events:` declaration (asserts nothing; `types ⊇ {{}}` is vacuously true) — list the events explicitly')
            elif types_list is None:
                errs.append(f'{path}: R3 required context "{context_name}" — `on.pull_request.types` missing or not an inline [..] list; cannot verify it covers the declared gated-events {gated_decl}')
            else:
                missing = [e for e in gated_decl if e not in types_list]
                if missing:
                    errs.append(f'{path}: R3 required context "{context_name}" — pull_request.types is missing declared gated-event(s) {missing} (declared: {gated_decl}, types: {types_list})')

    # R4: `cancel-in-progress:` must be the literal `false` (or omitted). The old `: true` match
    # missed `${{ github.ref != 'refs/heads/main' }}` — true on exactly the protected PRs (e/209).
    for i, ln in enumerate(lines):
        m = re.match(r'^\s*cancel-in-progress\s*:\s*(.+?)\s*$', ln)
        if m and m.group(1).strip().strip('\'"') != 'false':
            errs.append(f'{path}:{i + 1}: R4 required context "{context_name}" — `cancel-in-progress: {m.group(1).strip()}` is not the literal `false`; a cancelled run does not satisfy a required check (the expression form evaluates true on exactly the PRs this protects). Use `cancel-in-progress: false` or omit it.')

    # R2 + R5: the reporting job (id == context_name).
    jobs_idx = _find_key(lines, 'jobs', 0)
    if jobs_idx == -1:
        errs.append(f'{path}: required context "{context_name}" — no `jobs:` block')
    else:
        job_idx = _find_reporting_job(lines, jobs_idx, context_name)
        if job_idx == -1:
            if posts == 'app-aggregate':
                pass  # app-posted aggregate (e.g. CodeQL): R1/R3/R4 linted the file above; R2/R5 N/A
            else:
                errs.append(f'{path}: R2 required context "{context_name}" — no job whose posted name (`name:` if set, else id) is "{context_name}" (a required check-run must be posted by a job in this workflow). Causes: (a) the reporting job is MATRIXED — it posts `name (value)`, never the bare name, so a gated job must not be matrixed (the likeliest real trigger, e.g. `test-powershell` t/3668); (b) a genuinely GitHub-App-posted aggregate (like CodeQL) — mark the SSOT entry `"posts": "app-aggregate"` to exempt R2/R5; (c) a typo or missing job.')
        else:
            job_end = _block_end(lines, job_idx, 2)
            job_body = lines[job_idx + 1:job_end]

            # ── t/3663 Half A: gated-events completeness FLOOR (WARN-ONLY, tagged R3-floor) ──
            # R3 checks types ⊇ declaration (declaration vs itself). This checks the declaration
            # against the CODE: events the reporting job BODY reacts to must appear in
            # `# lint:gated-events:`. Heuristic + deliberately INCOMPLETE — raises a floor, not a
            # completeness proof (t/3646 cond 4). Only when a non-empty declaration exists (R3
            # already flags missing/empty). Comment-stripped scan (cond 1): a token only in a `#`
            # comment must NOT raise the floor.
            if gated_decl:
                body_code = ' '.join(_strip_comment(bl) for bl in job_body)
                floor = set()
                if 'autoMergeRequest' in body_code:
                    floor.update(('auto_merge_enabled', 'auto_merge_disabled'))
                if re.search(r'\.labels\b|\bevent\.label\b', body_code):
                    floor.update(('labeled', 'unlabeled'))
                # `edited`: a `branches:` base filter means a PR base-retarget (an `edited` event)
                # can flip whether this required context runs, so the declaration must include it.
                # CONSEQUENCE (cond 2): `edited` ALSO delivers title/body edits — a job obliged to
                # add it therefore receives those; confirm it tolerates them (the two current
                # required contexts are if:always() gates that already do).
                if has_branches_filter:
                    floor.add('edited')
                floor_missing = sorted(floor - set(gated_decl))
                if floor_missing:
                    errs.append(f'{path}: R3-floor required context "{context_name}" — job body reacts to event(s) missing from `# lint:gated-events:` {floor_missing} (declared: {sorted(gated_decl)}). Add them AND confirm the job tolerates what they deliver (note: `edited` also fires on title/body edits). Heuristic floor — a minimum, not a completeness proof.')

            # ── t/3663 Half B: `skipped` structural discriminator (WARN-ONLY, tagged R5-skip) ──
            # Every job in the reporting job's `needs:` that can skip must either gate on
            # `needs.changes.outputs.*` (legitimate path-filtered skip) OR be declared in a
            # co-located `# lint:tolerated-skip: <job> <ticket-or-date> <why>`. A job that can skip
            # with neither is the Arm-E kind (skips on an unanticipated event → gate green on a red
            # SHA). Structural (checks each needed job's `if:` vs code); heuristic.
            needs_idx = _find_key(lines, 'needs', 4, job_idx + 1, job_end)
            if needs_idx != -1:
                needed = _parse_inline_list(lines[needs_idx].split(':', 1)[1]) or []
                tol_jobs = set()
                for k in range(job_idx + 1, job_end):
                    mt = TOLERATED_SKIP_RE.search(lines[k])
                    if mt:
                        tol_jobs.add(mt.group(1))
                    elif TOLERATED_SKIP_ANY_RE.search(lines[k]):
                        errs.append(f'{path}:{k + 1}: R5-skip required context "{context_name}" — `# lint:tolerated-skip:` is missing its mandatory `<job> <ticket-ref-or-date>` (an unauditable suppression). Use e.g. `# lint:tolerated-skip: my-job t/1234 <why>`.')
                for name in needed:
                    if name == 'changes':
                        continue  # the paths-filter producer itself
                    nj = _find_key(lines, name, 2, jobs_idx + 1)
                    if nj == -1:
                        continue
                    nj_end = _block_end(lines, nj, 2)
                    if _find_key(lines, 'if', 4, nj + 1, nj_end) == -1:
                        continue  # no `if:` → runs unconditionally, cannot skip (not this hazard)
                    nj_body = ' '.join(lines[nj + 1:nj_end])
                    if 'needs.changes.outputs.' in nj_body:
                        continue  # legitimate path-filtered skip
                    if name in tol_jobs:
                        continue  # deliberately tolerated (audited via ticket/date)
                    errs.append(f'{path}: R5-skip required context "{context_name}" — needed job "{name}" has an `if:` that can skip but does NOT gate on `needs.changes.outputs.*` and is not in a `# lint:tolerated-skip:` list. An unanticipated skip passes the gate on a red SHA (Arm-E). Gate it on the paths filter, or add `# lint:tolerated-skip: {name} <ticket-or-date> <why>`.')

            # R2: `if:` must be absent or EXACTLY always().
            job_if_always = False
            if_idx = _find_key(lines, 'if', 4, job_idx + 1, job_end)
            if if_idx != -1:
                if_val = lines[if_idx].split(':', 1)[1].strip()
                normalized = re.sub(r'\s+', ' ', if_val.strip('\'"').replace('${{', '').replace('}}', '')).strip()
                has_exemption = any(ALLOW_IF_RE.search(lines[k]) for k in range(job_idx + 1, job_end))
                if normalized == 'always()':
                    job_if_always = True
                elif not has_exemption:
                    errs.append(f'{path}:{if_idx + 1}: R2 required context "{context_name}" — reporting-job `if:` must be absent or EXACTLY `always()` (got `{if_val}`); `always() && X` still skips on the excluded event → context hangs. Add `# lint:allow-if: <reason>` in the job to exempt a deliberate case.')

            # R5: an `if: always()` reporting job runs regardless of `needs:` — false-green unless
            # (a) it asserts over needs.*.result AND (b) it declares its `skipped` disposition
            # matching the gating `if:`. (A job with no `if:` runs conditionally on its trigger and
            # is not this hazard.)
            if job_if_always:
                if not any(re.search(r'needs\S*\.result', bl) for bl in job_body):
                    errs.append(f'{path}: R5 required context "{context_name}" — reporting job is `if: always()` but has NO `needs.*.result` assertion; it reports success regardless of what failed beneath it (permanent false-green). Add a step that fails on needs.*.result.')
                decl = decl_why = None
                decl_ln = -1
                for k in range(job_idx + 1, job_end):
                    mm = SKIPPED_TOL_RE.search(lines[k])
                    if mm:
                        decl, decl_why, decl_ln = mm.group(1), mm.group(2).strip(), k
                        break
                if decl is None:
                    errs.append(f'{path}: R5 required context "{context_name}" — `if: always()` reporting job must carry a co-located `# lint:skipped-tolerated: yes|no <why>` declaration (records + explains whether a skipped need is tolerated).')
                elif not decl_why:
                    errs.append(f'{path}:{decl_ln + 1}: R5 required context "{context_name}" — `# lint:skipped-tolerated: {decl}` is missing its required <why> (a disposition with no reason is a checkbox, not a decision).')
                else:
                    # Pairing — scope the `skipped` reference to `if:` lines ONLY. Comments mention
                    # `skipped` throughout ci.yml; a body-wide search would false-RED a `yes` gate and
                    # block every PR (TL e/209#14). Consistency check (inherits R3's limit).
                    cond_refs_skipped = any('skipped' in bl for bl in job_body if re.match(r'^\s*if\s*:', bl))
                    if decl == 'yes' and cond_refs_skipped:
                        errs.append(f'{path}: R5 required context "{context_name}" — declares `skipped-tolerated: yes` but a gating `if:` references `skipped` (the condition blocks on skip while the declaration says it is tolerated — they disagree).')
                    elif decl == 'no' and not cond_refs_skipped:
                        errs.append(f'{path}: R5 required context "{context_name}" — declares `skipped-tolerated: no` but no gating `if:` references `skipped` (a skipped need would pass the gate, contradicting the declaration).')

    return errs


def _find_block_scalar_spans(lines, target_key):
    """Return [(start_idx, end_idx, indent)] 0-based spans for every `<target_key>:` block
    scalar value (e.g. 'run' or 'script'), mirroring Check 2's in_run/run_indent tracking
    in lint_file()."""
    blocks = []
    in_block = False
    block_indent = 0
    start = None
    for i, line in enumerate(lines):
        key, indent = parse_step_key(line)
        # Block-scalar CONTENT one line can look exactly like "word: value" (e.g. a bash
        # string `Run: $RUN_URL"`, or JS `title: ...`) even though it's inside the block,
        # not a sibling YAML key. Valid block-scalar content is always indented > the key's
        # own indent -- so a parse_step_key "hit" only counts as a real key line while
        # in_block when it's at or above that indent; deeper, it's content, whatever it looks
        # like.
        if in_block and key is not None and indent > block_indent:
            key = None
        if key is not None:
            if in_block:
                blocks.append((start, i, block_indent))
                in_block = False
            if key == target_key:
                in_block = True
                block_indent = indent
                start = i
        elif in_block:
            stripped = line.lstrip()
            if stripped and len(line) - len(stripped) <= block_indent:
                blocks.append((start, i, block_indent))
                in_block = False
    if in_block:
        blocks.append((start, len(lines), block_indent))
    return blocks


def _find_run_blocks(lines):
    """Return [(start_idx, end_idx, run_indent)] 0-based spans for every `run:` block value."""
    return _find_block_scalar_spans(lines, 'run')


def _gh_issue_commands(block, start):
    """Join backslash line-continuations in a bash `run:` block into logical commands,
    tracking the first physical line number of each. Skips pure comment lines (a bash
    comment can say "gh issue create" in PROSE describing past behavior -- e.g.
    deploy-drift-check.yml:131 -- without being a real invocation)."""
    commands = []  # (first_line_no, joined_text)
    buf = []
    buf_start = None
    for j, bl in enumerate(block):
        if not buf and bl.lstrip().startswith('#'):
            continue
        if buf_start is None:
            buf_start = start + j
        stripped = bl.rstrip()
        if stripped.endswith('\\'):
            buf.append(stripped[:-1])
            continue
        buf.append(bl)
        commands.append((buf_start, ' '.join(buf)))
        buf = []
        buf_start = None
    if buf:
        commands.append((buf_start, ' '.join(buf)))
    return commands


def check_alert_label(path, content):
    """WARN-ONLY (t/4414, e/349#6, e/349#8): flag an alert-issue call -- `gh issue create`,
    an ALERT-path `gh issue edit` (one that touches labels, not a plain close/comment), or
    `github.rest.issues.create(...)` inside an actions/github-script `script:` block -- that
    applies neither the `alert-escalated` label nor a `# lint:alert-label-exempt:
    <ticket-or-date> <reason>` comment elsewhere in the same block.

    `gh issue edit` is narrowed to label-touching calls only (SO e/349#8 point 2): a plain
    close/comment edit on the auto-resolve path doesn't need the label, and flagging it would
    fill the warn-only rule with exemptions until it stops being read -- the same class this
    rule exists to prevent, just at the review layer instead of the alert layer.

    The github-script arm can't parse a JS object literal with a regex, so it uses a bounded
    heuristic: scan up to 40 lines forward from the `issues.create(` call, or until the next
    `issues.create(`/`async function` boundary (whichever comes first), for `alert-escalated`
    or the exempt comment. Good enough for a warn-only lint; a false negative here only means
    a real gap goes unflagged one cycle, not that anything blocks."""
    findings = []
    lines = content.splitlines()

    for start, end, _indent in _find_run_blocks(lines):
        block = lines[start:end]
        has_exempt = any(ALERT_LABEL_EXEMPT_RE.search(bl) for bl in block)
        for line_no, cmd in _gh_issue_commands(block, start):
            if GH_ISSUE_CREATE_RE.search(cmd):
                pass
            elif GH_ISSUE_EDIT_ALERT_RE.search(cmd):
                pass
            else:
                continue
            if ALERT_LABEL in cmd or has_exempt:
                continue
            findings.append(
                f'{path}:{line_no + 1}: `gh issue create`/alert-path `edit` without the '
                f'`{ALERT_LABEL}` label (the r/23 escalation bridge only watches that label) — '
                f'add `--label {ALERT_LABEL}` (create) / `--add-label {ALERT_LABEL}` (edit), or '
                f'add a co-located `# lint:alert-label-exempt: <ticket-or-date> <reason>` '
                f'recording why this alert is covered another way.'
            )

    script_blocks = _find_block_scalar_spans(lines, 'script')
    js_creates = []  # (line_idx, block_end_idx, block_has_exempt) for every issues.create(
    for start, end, _indent in script_blocks:
        block_has_exempt = any(ALERT_LABEL_EXEMPT_RE.search(lines[j]) for j in range(start, end))
        for j in range(start, end):
            if JS_ISSUES_CREATE_RE.search(lines[j]):
                js_creates.append((j, end, block_has_exempt))
    for idx, (line_idx, block_end, block_has_exempt) in enumerate(js_creates):
        if block_has_exempt:
            continue
        next_create_idx = js_creates[idx + 1][0] if idx + 1 < len(js_creates) else block_end
        window_end = min(line_idx + 40, block_end, next_create_idx)
        window_text = '\n'.join(lines[line_idx:window_end])
        # ESCALATED_LABEL is main-ci-monitor.mjs's exported JS binding for the literal
        # 'alert-escalated' string (confirmed: `export const ESCALATED_LABEL =
        # 'alert-escalated'`) -- a labels: array referencing the symbol, not the literal,
        # is equally real evidence the label is applied.
        if ALERT_LABEL in window_text or 'ESCALATED_LABEL' in window_text:
            continue
        findings.append(
            f'{path}:{line_idx + 1}: `github.rest.issues.create(...)` without the `{ALERT_LABEL}` '
            f'label (the r/23 escalation bridge only watches that label) — add it to the `labels:` '
            f'array, or add a co-located `# lint:alert-label-exempt: <ticket-or-date> <reason>` '
            f'recording why this alert is covered another way.'
        )
    return findings


def self_test():
    """Verify that both uses: syntax forms and run: forms are correctly detected."""
    print('=== workflow-lint self-test ===')
    failures = []

    # Fixture 1: compact list-item `- uses:` form must be caught by Check 1
    fixture_compact_uses = """\
permissions:
  contents: read
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
"""
    errs = lint_file('fixture_compact_uses', fixture_compact_uses)
    if not any('unpinned action ref' in e for e in errs):
        failures.append('Check 1 MISSED compact "- uses: action@v4" form')
    else:
        print('  PASS: Check 1 catches compact "- uses: action@v4"')

    # Fixture 2: plain key `uses:` form must also be caught
    fixture_plain_uses = """\
permissions:
  contents: read
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - name: step
        uses: actions/checkout@v4
"""
    errs = lint_file('fixture_plain_uses', fixture_plain_uses)
    if not any('unpinned action ref' in e for e in errs):
        failures.append('Check 1 MISSED plain "  uses: action@v4" form')
    else:
        print('  PASS: Check 1 catches plain "  uses: action@v4"')

    # Fixture 3: SHA-pinned ref must NOT be flagged
    fixture_pinned = """\
permissions:
  contents: read
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7
"""
    errs = lint_file('fixture_pinned', fixture_pinned)
    if any('unpinned' in e for e in errs):
        failures.append('Check 1 incorrectly flagged a properly SHA-pinned action')
    else:
        print('  PASS: Check 1 ignores properly pinned action')

    # Fixture 3b (t/4347): an invalid permissions: key must be caught by Check 4
    fixture_bad_permission = """\
permissions:
  environments: read
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
"""
    errs = lint_file('fixture_bad_permission', fixture_bad_permission)
    if not any("'environments'" in e for e in errs):
        failures.append("Check 4 MISSED an invalid permissions: key ('environments')")
    else:
        print('  PASS: Check 4 catches an invalid permissions: key')

    # Fixture 3c: a job-level permissions: block with an invalid key must also be caught
    fixture_bad_job_permission = """\
permissions:
  contents: read
jobs:
  job:
    runs-on: ubuntu-latest
    permissions:
      environments: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
"""
    errs = lint_file('fixture_bad_job_permission', fixture_bad_job_permission)
    if not any("'environments'" in e for e in errs):
        failures.append('Check 4 MISSED an invalid key in a JOB-level permissions: block')
    else:
        print('  PASS: Check 4 catches an invalid key in a job-level permissions: block')

    # Fixture 3d: every valid allowlisted key must NOT be flagged
    fixture_good_permissions = """\
permissions:
  contents: read
  issues: write
  id-token: write
  pull-requests: read
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
"""
    errs = lint_file('fixture_good_permissions', fixture_good_permissions)
    if any('is not a real GITHUB_TOKEN permission' in e for e in errs):
        failures.append('Check 4 incorrectly flagged a valid allowlisted permissions: key')
    else:
        print('  PASS: Check 4 ignores every valid allowlisted permissions: key')

    # Fixture 3e: shorthand forms (read-all/write-all/{}) must NOT be treated as a key block
    fixture_shorthand_permissions = """\
permissions: read-all
jobs:
  job:
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
"""
    errs = lint_file('fixture_shorthand_permissions', fixture_shorthand_permissions)
    if any('is not a real GITHUB_TOKEN permission' in e for e in errs):
        failures.append('Check 4 incorrectly treated a shorthand permissions: form as a key block')
    else:
        print('  PASS: Check 4 ignores shorthand permissions: forms (read-all/write-all/{})')

    # Fixture 4: bare ${{ inputs.X }} in run block must be caught
    fixture_inputs_run = """\
permissions:
  contents: read
on:
  workflow_dispatch:
    inputs:
      image:
        type: string
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - name: pull
        run: docker pull "${{ inputs.image }}"
"""
    errs = lint_file('fixture_inputs_run', fixture_inputs_run)
    if not any('inputs' in e for e in errs):
        failures.append('Check 2 MISSED bare ${{ inputs.image }} in inline run:')
    else:
        print('  PASS: Check 2 catches bare ${{ inputs.image }} in inline run:')

    # Fixture 5: conditional expression ${{ inputs.X == ... }} must NOT be flagged
    fixture_inputs_expr = """\
permissions:
  contents: read
on:
  workflow_dispatch:
    inputs:
      mode:
        type: choice
        options: [a, b]
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - run: echo "mode=${{ inputs.mode == 'a' && '1' || '' }}"
"""
    errs = lint_file('fixture_inputs_expr', fixture_inputs_expr)
    if any('inputs' in e for e in errs):
        failures.append('Check 2 incorrectly flagged a conditional expression')
    else:
        print('  PASS: Check 2 ignores conditional ${{ inputs.X == ... }} expressions')

    # ── t/3646: required-context rule (R1–R4) — both arms per rule ────────────
    # These prove the DETECTION logic. NOTE (TL t/3646#5): passing here does NOT prove
    # the rule is live in real CI — fixtures exercise layers below platform execution
    # and can be silently dead. A live-fire in a real run is a separate flip-gate.
    rc_ok = (
        "permissions:\n  contents: read\n"
        "on:\n  pull_request:\n"  # t/3663: no branches filter here → Half-A floor requires no `edited` (the branches→edited case is tested by rc_floor_edited)
        "    # lint:gated-events: opened,synchronize,reopened\n"
        "    types: [opened, synchronize, reopened]\n"
        "jobs:\n  ci-gate:\n    if: always()\n"
        "    # lint:skipped-tolerated: yes — fixture: path-filtered skips are fine\n"
        "    runs-on: ubuntu-latest\n    steps:\n"
        "      - name: gate\n        if: contains(needs.*.result, 'failure')\n        run: echo ok\n"
    )
    if check_required_context('rc_ok', rc_ok, 'ci-gate'):
        failures.append(f'RC compliant fixture unexpectedly flagged: {check_required_context("rc_ok", rc_ok, "ci-gate")!r}')
    else:
        print('  PASS: RC compliant required-context workflow → 0 findings')

    # ── t/3663 Half A: gated-events completeness FLOOR (warn-only, tagged R3-floor) ──
    # Must-flag = the joint-gv-guard pre-t/3607 shape: job body reads autoMergeRequest but the
    # declaration omits auto_merge_*. If the floor can't catch this, it isn't worth adding.
    rc_floor_amr = (
        "permissions:\n  contents: read\n"
        "on:\n  pull_request:\n"
        "    # lint:gated-events: opened,synchronize,reopened\n"
        "    types: [opened, synchronize, reopened]\n"
        "jobs:\n  ci-gate:\n    if: always()\n"
        "    # lint:skipped-tolerated: yes — fixture\n"
        "    runs-on: ubuntu-latest\n    steps:\n"
        "      - name: gate\n        if: contains(needs.*.result, 'failure')\n"
        "        run: node -e \"pr.data.autoMergeRequest\"\n"
    )
    _f = check_required_context('rc_floor_amr', rc_floor_amr, 'ci-gate')
    if not any('R3-floor' in e and 'auto_merge_disabled' in e for e in _f):
        failures.append(f'Half-A floor MISSED autoMergeRequest → auto_merge_* (joint-gv-guard pre-t/3607 case): {_f!r}')
    else:
        print('  PASS: Half-A floor flags an autoMergeRequest body whose declaration omits auto_merge_*')

    # Cond 1 negative control: autoMergeRequest ONLY in a comment must NOT raise the floor.
    rc_floor_cmt = rc_floor_amr.replace(
        "        run: node -e \"pr.data.autoMergeRequest\"\n",
        "        # note: autoMergeRequest handling lives elsewhere — comment only\n        run: echo ok\n")
    if any('R3-floor' in e for e in check_required_context('rc_floor_cmt', rc_floor_cmt, 'ci-gate')):
        failures.append('Half-A floor FALSE-POSITIVE on a comment-only autoMergeRequest mention (cond 1)')
    else:
        print('  PASS: Half-A floor ignores a comment-only autoMergeRequest mention (cond 1 negative control)')

    # Complete declaration → floor silent.
    rc_floor_ok = rc_floor_amr.replace(
        "    # lint:gated-events: opened,synchronize,reopened\n",
        "    # lint:gated-events: opened,synchronize,reopened,auto_merge_enabled,auto_merge_disabled\n").replace(
        "    types: [opened, synchronize, reopened]\n",
        "    types: [opened, synchronize, reopened, auto_merge_enabled, auto_merge_disabled]\n")
    if any('R3-floor' in e for e in check_required_context('rc_floor_ok', rc_floor_ok, 'ci-gate')):
        failures.append('Half-A floor FALSE-POSITIVE when the declaration already covers auto_merge_*')
    else:
        print('  PASS: Half-A floor silent when the declaration covers the body events')

    # Cond 2: a branches: filter → floor requires `edited` (base-retarget).
    rc_floor_edited = rc_ok.replace("on:\n  pull_request:\n", "on:\n  pull_request:\n    branches: [main]\n")
    if not any('R3-floor' in e and 'edited' in e for e in check_required_context('rc_floor_edited', rc_floor_edited, 'ci-gate')):
        failures.append('Half-A floor MISSED branches-filter → edited requirement (cond 2)')
    else:
        print('  PASS: Half-A floor requires `edited` when a branches: filter is present (cond 2)')

    # ── t/3663 Half B: `skipped` structural discriminator (warn-only, tagged R5-skip) ──
    rc_skip_flag = (
        "permissions:\n  contents: read\n"
        "on:\n  pull_request:\n"
        "    # lint:gated-events: opened,synchronize,reopened\n"
        "    types: [opened, synchronize, reopened]\n"
        "jobs:\n"
        "  heavy:\n    if: github.event_name == 'push'\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo heavy\n"
        "  ci-gate:\n    needs: [heavy]\n    if: always()\n"
        "    # lint:skipped-tolerated: yes — fixture\n"
        "    runs-on: ubuntu-latest\n    steps:\n"
        "      - name: gate\n        if: contains(needs.*.result, 'failure')\n        run: echo ok\n"
    )
    if not any('R5-skip' in e and 'heavy' in e for e in check_required_context('rc_skip_flag', rc_skip_flag, 'ci-gate')):
        failures.append('Half-B MISSED a needed job that can skip without a needs.changes.outputs gate')
    else:
        print('  PASS: Half-B flags an Arm-E-style skippable need (no paths-filter gate, not tolerated)')

    rc_skip_pf = rc_skip_flag.replace("    if: github.event_name == 'push'\n", "    if: needs.changes.outputs.heavy == 'true'\n")
    if any('R5-skip' in e for e in check_required_context('rc_skip_pf', rc_skip_pf, 'ci-gate')):
        failures.append('Half-B FALSE-POSITIVE on a legit needs.changes.outputs path-filtered skip')
    else:
        print('  PASS: Half-B silent on a path-filtered (needs.changes.outputs.*) skip')

    rc_skip_tol = rc_skip_flag.replace(
        "    # lint:skipped-tolerated: yes — fixture\n",
        "    # lint:skipped-tolerated: yes — fixture\n    # lint:tolerated-skip: heavy t/9999 push-only by design\n")
    if any('R5-skip' in e for e in check_required_context('rc_skip_tol', rc_skip_tol, 'ci-gate')):
        failures.append('Half-B still flagged a need covered by an audited (ticket-anchored) tolerated-skip')
    else:
        print('  PASS: Half-B silent when the skippable need has a ticket-anchored tolerated-skip')

    rc_skip_bad = rc_skip_flag.replace(
        "    # lint:skipped-tolerated: yes — fixture\n",
        "    # lint:skipped-tolerated: yes — fixture\n    # lint:tolerated-skip: heavy just because\n")
    if not any('R5-skip' in e and 'unauditable' in e for e in check_required_context('rc_skip_bad', rc_skip_bad, 'ci-gate')):
        failures.append('Half-B MISSED a tolerated-skip marker lacking a ticket ref or date (cond 3)')
    else:
        print('  PASS: Half-B flags a tolerated-skip marker missing its ticket-ref/date (cond 3)')

    rc_r1 = rc_ok.replace('    types: [opened, synchronize, reopened]\n',
                          "    paths: ['src/**']\n    types: [opened, synchronize, reopened]\n")
    if not any('R1' in e for e in check_required_context('rc_r1', rc_r1, 'ci-gate')):
        failures.append('R1 MISSED `paths:` under pull_request')
    else:
        print('  PASS: R1 flags paths: under pull_request')

    rc_r2 = rc_ok.replace('    if: always()\n', "    if: always() && github.event_name == 'push'\n")
    if not any('R2' in e for e in check_required_context('rc_r2', rc_r2, 'ci-gate')):
        failures.append('R2 MISSED `always() && X` reporting-job if: (the starts-with hole)')
    else:
        print('  PASS: R2 flags `always() && X` reporting-job if:')

    rc_noif = rc_ok.replace('    if: always()\n', '')
    if any('R2' in e for e in check_required_context('rc_noif', rc_noif, 'ci-gate')):
        failures.append('R2 false-flagged an ABSENT reporting-job if:')
    else:
        print('  PASS: R2 allows an absent reporting-job if:')

    rc_r3m = rc_ok.replace('    # lint:gated-events: opened,synchronize,reopened\n', '')
    if not any('R3' in e and 'missing' in e for e in check_required_context('rc_r3m', rc_r3m, 'ci-gate')):
        failures.append('R3 MISSED a missing lint:gated-events declaration')
    else:
        print('  PASS: R3 flags a missing gated-events declaration')

    rc_r3e = rc_ok.replace('    # lint:gated-events: opened,synchronize,reopened\n',
                           '    # lint:gated-events:\n')
    if not any('EMPTY' in e for e in check_required_context('rc_r3e', rc_r3e, 'ci-gate')):
        failures.append('R3 MISSED an EMPTY gated-events declaration (vacuous-pass guard)')
    else:
        print('  PASS: R3 flags an EMPTY gated-events declaration (closes the vacuous arm)')

    rc_r3g = rc_ok.replace('    # lint:gated-events: opened,synchronize,reopened\n',
                           '    # lint:gated-events: opened,synchronize,reopened,labeled\n')
    if not any('R3' in e and 'labeled' in e for e in check_required_context('rc_r3g', rc_r3g, 'ci-gate')):
        failures.append('R3 MISSED a declared gated-event absent from types')
    else:
        print('  PASS: R3 flags a declared event missing from types')

    rc_r3dup = rc_ok.replace('    # lint:gated-events: opened,synchronize,reopened\n',
                             '    # lint:gated-events: opened,synchronize,reopened\n    # lint:gated-events: opened\n')
    if not any('declarations' in e for e in check_required_context('rc_r3dup', rc_r3dup, 'ci-gate')):
        failures.append('R3 MISSED >1 lint:gated-events declarations (silent-second-declaration gap)')
    else:
        print('  PASS: R3 flags >1 gated-events declaration (closes the silent-second-decl gap)')

    rc_r4 = rc_ok.replace('on:\n', 'concurrency:\n  group: g\n  cancel-in-progress: true\non:\n')
    if not any('R4' in e for e in check_required_context('rc_r4', rc_r4, 'ci-gate')):
        failures.append('R4 MISSED cancel-in-progress: true')
    else:
        print('  PASS: R4 flags cancel-in-progress: true')

    rc_r4x = rc_ok.replace('on:\n', "concurrency:\n  group: g\n  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}\non:\n")
    if not any('R4' in e for e in check_required_context('rc_r4x', rc_r4x, 'ci-gate')):
        failures.append('R4 MISSED cancel-in-progress expression form (not literal false)')
    else:
        print('  PASS: R4 flags the cancel-in-progress ${{ }} expression form')

    rc_r5a = rc_ok.replace("        if: contains(needs.*.result, 'failure')\n", '')
    if not any('R5' in e for e in check_required_context('rc_r5a', rc_r5a, 'ci-gate')):
        failures.append('R5 MISSED an if:always() job with no needs.*.result assertion (false-green)')
    else:
        print('  PASS: R5 flags if:always() with no needs.*.result assertion (false-green)')

    rc_r5b = rc_ok.replace('    # lint:skipped-tolerated: yes — fixture: path-filtered skips are fine\n', '')
    if not any('skipped-tolerated' in e for e in check_required_context('rc_r5b', rc_r5b, 'ci-gate')):
        failures.append('R5 MISSED a missing skipped-tolerated declaration')
    else:
        print('  PASS: R5 flags a missing skipped-tolerated declaration')

    rc_r5why = rc_ok.replace('yes — fixture: path-filtered skips are fine', 'yes')
    if not any('R5' in e and 'why' in e for e in check_required_context('rc_r5why', rc_r5why, 'ci-gate')):
        failures.append('R5 MISSED a skipped-tolerated declaration with no <why>')
    else:
        print('  PASS: R5 flags a skipped-tolerated declaration missing <why>')

    rc_r5yp = rc_ok.replace("if: contains(needs.*.result, 'failure')", "if: contains(needs.*.result, 'skipped')")
    if not any('R5' in e and 'disagree' in e for e in check_required_context('rc_r5yp', rc_r5yp, 'ci-gate')):
        failures.append('R5 MISSED yes-declaration whose gating if: references skipped (pairing disagree)')
    else:
        print('  PASS: R5 flags yes-declaration + if:references-skipped (pairing)')

    # TL/SO e/209#14/#1343 — REQUIRED both fixtures. Comments mention `skipped` all over ci.yml;
    # a body-wide search would false-RED a `yes` gate and block every PR. The `if:`-lines-only scope fixes it.
    rc_r5cmt = rc_ok.replace("    steps:\n", "    steps:\n      # note: skipped needs are expected here\n")
    if any('R5' in e for e in check_required_context('rc_r5cmt', rc_r5cmt, 'ci-gate')):
        failures.append('R5 FALSE-RED on a `skipped` comment in the job body (would block every PR)')
    else:
        print('  PASS: R5 ignores a `skipped` comment in the job body (no false-RED)')

    rc_r5no = rc_r5cmt.replace('yes — fixture: path-filtered skips are fine', 'no — fixture: skips NOT tolerated')
    if not any('R5' in e for e in check_required_context('rc_r5no', rc_r5no, 'ci-gate')):
        failures.append('R5 FALSE-PASS: `no` declaration but the condition never checks skipped (comment must not satisfy it)')
    else:
        print('  PASS: R5 flags `no` whose condition never checks skipped (comment does not satisfy it)')

    # ── t/3691: file-vs-job separation (posts marker) + name-then-id lookup + matrix guard ──
    # Arm A: an app-posted aggregate (posts='app-aggregate') with NO matching job → R2/R5 N/A
    # (skipped); the FILE rules (R1/R3/R4) still ran on it. rc_ok's job id is 'ci-gate'; ask 'CodeQL'.
    if any('R2' in e for e in check_required_context('rc_appagg', rc_ok, 'CodeQL', 'app-aggregate')):
        failures.append('t/3691 Arm A: app-aggregate context wrongly R2-failed (should skip job-level rules)')
    else:
        print('  PASS: t/3691 A — app-aggregate context skips R2/R5 (no matching job is expected there)')

    # Arm B: the SAME shape UNMARKED (posts=None) → R2 FAILS. The marker is the ONLY thing that
    # distinguishes a genuine app-posted aggregate from a typo/missing job — typo catch preserved.
    if not any('R2' in e for e in check_required_context('rc_unmarked', rc_ok, 'CodeQL')):
        failures.append('t/3691 Arm B: unmarked context with no matching job did NOT R2-fail (typo catch lost)')
    else:
        print('  PASS: t/3691 B — unmarked context with no matching job still R2-fails (typo catch preserved)')

    # Fixture: job id 'analyze' but `name: report-ctx`. GitHub posts the check-run under the NAME, so
    # the reporting context is 'report-ctx', NOT 'analyze'.
    rc_nameid = (
        "permissions:\n  contents: read\n"
        "on:\n  pull_request:\n"
        "    # lint:gated-events: opened,synchronize,reopened\n"
        "    types: [opened, synchronize, reopened]\n"
        "jobs:\n  analyze:\n    name: report-ctx\n    if: always()\n"
        "    runs-on: ubuntu-latest\n    steps:\n"
        "      - name: gate\n        if: contains(needs.*.result, 'failure')\n        run: echo ok\n"
    )
    # Arm C: context == the NAME ('report-ctx') → found via the name route (name≠id), no R2 failure.
    if any('R2' in e for e in check_required_context('rc_nameid_ok', rc_nameid, 'report-ctx')):
        failures.append('t/3691 Arm C: name-match (report-ctx) wrongly R2-failed (name-then-id lookup broken)')
    else:
        print('  PASS: t/3691 C — a job whose name==context is found by the name route (name≠id)')

    # Arm D: context == the ID ('analyze') while name:'report-ctx' is set → the check-run posts as
    # 'report-ctx', so a required 'analyze' would HANG → R2 must FAIL (SO "misleading green", e/215#2).
    # An id-only fallback would wrongly find job id 'analyze' and pass — the bug this arm guards.
    if not any('R2' in e for e in check_required_context('rc_nameid_stale', rc_nameid, 'analyze')):
        failures.append('t/3691 Arm D: stale context==id while name:X set did NOT R2-fail (misleading green)')
    else:
        print('  PASS: t/3691 D — context==id while a different name is set R2-fails (no misleading green)')

    # Arm E: a MATRIXED reporting job posts `name (value)`, never the bare name → cannot satisfy a
    # bare required context; context=='shard' must R2-fail (mechanizes "a gated job must not be
    # matrixed", TL e/215#6). Without the matrix-skip the lint would false-PASS on `name: shard`.
    rc_matrix = (
        "permissions:\n  contents: read\n"
        "on:\n  pull_request:\n"
        "    # lint:gated-events: opened,synchronize,reopened\n"
        "    types: [opened, synchronize, reopened]\n"
        "jobs:\n  shard:\n    name: shard\n    strategy:\n      matrix:\n        n: [1, 2]\n    if: always()\n"
        "    runs-on: ubuntu-latest\n    steps:\n"
        "      - name: gate\n        if: contains(needs.*.result, 'failure')\n        run: echo ok\n"
    )
    if not any('R2' in e for e in check_required_context('rc_matrix', rc_matrix, 'shard')):
        failures.append("t/3691 Arm E: a matrixed reporting job (posts 'shard (n)') did NOT R2-fail for bare context 'shard'")
    else:
        print('  PASS: t/3691 E — a matrixed reporting job R2-fails a bare context (name (value) != name)')

    # t/4414 (e/349#6): check_alert_label fixtures.
    fixture_alert_missing = """\
permissions:
  issues: write
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - run: |
          gh issue create --title "x" --label "some-other-label" --body "y"
"""
    findings = check_alert_label('fixture_alert_missing', fixture_alert_missing)
    if not any('without the' in f for f in findings):
        failures.append('check_alert_label MISSED a gh issue create with no alert-escalated label')
    else:
        print('  PASS: check_alert_label catches gh issue create missing alert-escalated')

    fixture_alert_present = """\
permissions:
  issues: write
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - run: |
          gh issue create --title "x" --label "alert-escalated" --body "y"
"""
    findings = check_alert_label('fixture_alert_present', fixture_alert_present)
    if findings:
        failures.append('check_alert_label FALSE-FLAGGED a gh issue create that already has alert-escalated')
    else:
        print('  PASS: check_alert_label ignores a call that already carries alert-escalated')

    fixture_alert_multiline = """\
permissions:
  issues: write
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - run: |
          gh issue create \\
            --title "x" \\
            --label "alert-escalated" \\
            --body "y"
"""
    findings = check_alert_label('fixture_alert_multiline', fixture_alert_multiline)
    if findings:
        failures.append('check_alert_label FALSE-FLAGGED a backslash-continued gh issue create with alert-escalated on a later line')
    else:
        print('  PASS: check_alert_label joins backslash continuations before searching for the label')

    fixture_alert_exempt = """\
permissions:
  issues: write
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - run: |
          # lint:alert-label-exempt: t/4053 covered by the r/30 data-compliance watchdog bridge instead
          gh issue create --title "x" --label "data-compliance" --body "y"
"""
    findings = check_alert_label('fixture_alert_exempt', fixture_alert_exempt)
    if findings:
        failures.append('check_alert_label FALSE-FLAGGED a call with a valid lint:alert-label-exempt comment')
    else:
        print('  PASS: check_alert_label honors a lint:alert-label-exempt comment in the same run: block')

    fixture_alert_comment_mention = """\
permissions:
  issues: write
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - run: |
          # history: `gh issue create --label` used to error here before this fix
          gh issue create --title "x" --label "alert-escalated" --body "y"
"""
    findings = check_alert_label('fixture_alert_comment_mention', fixture_alert_comment_mention)
    if findings:
        failures.append('check_alert_label FALSE-FLAGGED a comment line that merely mentions "gh issue create" in prose')
    else:
        print('  PASS: check_alert_label ignores "gh issue create" mentioned inside a comment, not invoked')

    fixture_alert_edit_close_only = """\
permissions:
  issues: write
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - run: |
          gh issue edit "$NUM" --state closed
          gh issue comment "$NUM" --body "resolved"
"""
    findings = check_alert_label('fixture_alert_edit_close_only', fixture_alert_edit_close_only)
    if findings:
        failures.append('check_alert_label FALSE-FLAGGED a plain close/comment gh issue edit (SO e/349#8 point 2)')
    else:
        print('  PASS: check_alert_label ignores a plain close/comment gh issue edit, not the alert path')

    fixture_alert_edit_add_label = """\
permissions:
  issues: write
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - run: |
          gh issue edit "$NUM" --remove-label "owner-acked" --add-label "some-other-label"
"""
    findings = check_alert_label('fixture_alert_edit_add_label', fixture_alert_edit_add_label)
    if not any('edit' in f for f in findings):
        failures.append('check_alert_label MISSED a label-touching gh issue edit missing alert-escalated')
    else:
        print('  PASS: check_alert_label catches a label-touching gh issue edit missing alert-escalated')

    fixture_js_create_missing = """\
permissions:
  issues: write
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3
        with:
          script: |
            await github.rest.issues.create({
              owner, repo,
              title: 'Something broke',
              labels: ['some-label', 'bug']
            });
"""
    findings = check_alert_label('fixture_js_create_missing', fixture_js_create_missing)
    if not any('github.rest.issues.create' in f for f in findings):
        failures.append('check_alert_label MISSED a github.rest.issues.create(...) missing alert-escalated')
    else:
        print('  PASS: check_alert_label catches github.rest.issues.create(...) missing alert-escalated')

    fixture_js_create_present = """\
permissions:
  issues: write
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3
        with:
          script: |
            await github.rest.issues.create({
              owner, repo,
              title: 'Something broke',
              labels: ['some-label', 'alert-escalated']
            });
"""
    findings = check_alert_label('fixture_js_create_present', fixture_js_create_present)
    if findings:
        failures.append('check_alert_label FALSE-FLAGGED a github.rest.issues.create(...) that already carries alert-escalated')
    else:
        print('  PASS: check_alert_label ignores github.rest.issues.create(...) that already carries alert-escalated')

    fixture_js_create_comment_not_matched = """\
permissions:
  issues: write
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3
        with:
          script: |
            await github.rest.issues.createComment({ owner, repo, issue_number: n, body: 'hi' });
"""
    findings = check_alert_label('fixture_js_create_comment_not_matched', fixture_js_create_comment_not_matched)
    if findings:
        failures.append('check_alert_label FALSE-FLAGGED issues.createComment(...) as if it were issues.create(...)')
    else:
        print('  PASS: check_alert_label does not mistake issues.createComment(...) for issues.create(...)')

    fixture_js_create_exempt = """\
permissions:
  issues: write
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3
        with:
          script: |
            // lint:alert-label-exempt: t/4414 heartbeat marker the r/23 bridge reads directly
            await github.rest.issues.create({
              owner, repo,
              title: 'heartbeat',
              labels: ['main-ci-monitor-heartbeat']
            });
"""
    findings = check_alert_label('fixture_js_create_exempt', fixture_js_create_exempt)
    if findings:
        failures.append('check_alert_label FALSE-FLAGGED a github.rest.issues.create(...) with a valid exempt comment in the same script: block')
    else:
        print('  PASS: check_alert_label honors a lint:alert-label-exempt comment anywhere in the same script: block')

    if failures:
        for f in failures:
            print(f'  FAIL: {f}')
        print(f'\nSelf-test FAILED: {len(failures)} assertion(s)')
        sys.exit(1)

    print('Self-test PASSED — all assertions OK\n')


# ── Entry point ────────────────────────────────────────────────────────────────
if '--self-test' in sys.argv:
    self_test()

errors = []
workflows = sorted(glob.glob('.github/workflows/*.yml'))
if not workflows:
    print('workflow-lint: no workflows found in .github/workflows/')
    sys.exit(1)

for path in workflows:
    with open(path, encoding='utf-8') as f:
        content = f.read()
    errors.extend(lint_file(path, content))

# ── t/3646: required-context checks ──────────────────────────────────────────
# Rule findings are WARN-ONLY until REQUIRED_CONTEXT_BLOCKING flips (a deliberate
# promotion PR). But an ABSENT/MALFORMED SSOT, or an SSOT naming a nonexistent
# workflow, is ALWAYS a hard error even in warn-only mode: that means the check is
# silently NOT running — the exact "silently dead" failure this rule exists to
# prevent (it must fail loud, never no-op green).
import os as _os
rc_warnings = []
rc_entries, rc_ssot_err = load_required_contexts()
if rc_ssot_err:
    errors.append(rc_ssot_err)
else:
    for _e in rc_entries:
        _wf = _e.get('workflow')
        _ctx = _e.get('context')
        _posts = _e.get('posts')  # t/3691: 'app-aggregate' => app-posted (CodeQL); R2/R5 N/A, file rules still apply
        if not _wf:
            continue  # entry with no workflow file to lint (none today — CodeQL now names codeql.yml + posts:app-aggregate)
        if not _os.path.exists(_wf):
            errors.append(f'{_wf}: required context "{_ctx}" (SSOT {RC_SSOT_PATH}) names a workflow file that does not exist')
            continue
        with open(_wf, encoding='utf-8') as _f:
            _findings = check_required_context(_wf, _f.read(), _ctx, _posts)
        # t/3663: the completeness-floor (R3-floor) and skipped-discriminator (R5-skip) arms are
        # WARN-ONLY heuristics — they do NOT inherit R1–R5's blocking status (a later promotion
        # needs its own evidence + its own Second Opinion). Route them to rc_warnings REGARDLESS of
        # REQUIRED_CONTEXT_BLOCKING; the deterministic R1–R5 keep following the flip.
        _t3663 = [f for f in _findings if 'R3-floor' in f or 'R5-skip' in f]
        _core = [f for f in _findings if f not in _t3663]
        rc_warnings.extend(_t3663)
        if REQUIRED_CONTEXT_BLOCKING:
            errors.extend(_core)
        else:
            rc_warnings.extend(_core)

    # Condition 3 (e/209): allow-if ratchet — the committed ALLOW_IF_EXPECTED must equal the actual
    # count of `# lint:allow-if:` exemptions across required-context workflows. Baseline 0 today;
    # the first legitimate exemption bumps the constant in the same commit (the ratchet, not a bug).
    _allow_if_actual = 0
    for _e in rc_entries:
        _wf = _e.get('workflow')
        if not _wf or not _os.path.exists(_wf):
            continue
        with open(_wf, encoding='utf-8') as _f:
            _allow_if_actual += sum(1 for _l in _f if ALLOW_IF_RE.search(_l))
    if _allow_if_actual != ALLOW_IF_EXPECTED:
        _msg = (f'{RC_SSOT_PATH}: allow-if ratchet — {_allow_if_actual} `# lint:allow-if:` exemption(s) '
                f'across required-context workflows but ALLOW_IF_EXPECTED={ALLOW_IF_EXPECTED}. Added a '
                f'legitimate exemption? bump ALLOW_IF_EXPECTED in the same commit (ratchet, not a bug). '
                f'Else remove the stray marker.')
        if REQUIRED_CONTEXT_BLOCKING:
            errors.append(_msg)
        else:
            rc_warnings.append(_msg)

# t/4414 (e/349#6): alert-label check — WARN-ONLY, same promotion discipline as rc_warnings above.
alert_label_warnings = []
for _path in workflows:
    with open(_path, encoding='utf-8') as _f:
        alert_label_warnings.extend(check_alert_label(_path, _f.read()))

print(f'=== workflow-lint: {len(workflows)} workflows checked ===')
for e in errors:
    print(f'FAIL: {e}')
for w in rc_warnings:
    print(f'::warning::workflow-lint[required-context warn-only, t/3646]: {w}')
for w in alert_label_warnings:
    print(f'::warning::workflow-lint[alert-label warn-only, t/4414]: {w}')

if errors:
    print(f'\n::error::workflow-lint: {len(errors)} violation(s) — see output above')
    sys.exit(1)

if rc_warnings:
    print(f'\nworkflow-lint: {len(rc_warnings)} required-context WARNING(s) — warn-only (t/3646), not blocking yet')
if alert_label_warnings:
    print(f'\nworkflow-lint: {len(alert_label_warnings)} alert-label WARNING(s) — warn-only (t/4414), not blocking yet')
print('OK — 0 blocking violations')
