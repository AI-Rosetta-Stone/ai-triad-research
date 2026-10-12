#!/usr/bin/env bash
# t/1319 — commit-hygiene warning gate. Warning-only; never fails CI.
# Flags anonymous / under-length / bare-merge commit subjects on the pushed range.
# Points at ../ai-triad-data/CONTRIBUTING.md and the code-repo commit rules.

set -euo pipefail

# Which range to check
if [[ -n "${GITHUB_EVENT_NAME:-}" && "$GITHUB_EVENT_NAME" == "pull_request" ]]; then
    BASE="${GITHUB_BASE_REF:-main}"
    HEAD="${GITHUB_HEAD_REF:-HEAD}"
    RANGE="origin/${BASE}..HEAD"
elif [[ -n "${GITHUB_EVENT_BEFORE:-}" && "$GITHUB_EVENT_BEFORE" != "0000000000000000000000000000000000000000" ]]; then
    RANGE="${GITHUB_EVENT_BEFORE}..HEAD"
else
    # Fallback: last 20 commits (workflow_dispatch, first push after branch create)
    RANGE="HEAD~20..HEAD"
fi

echo "Checking commit-message hygiene on range: $RANGE"

FLAGS=0
CHECKED=0

# git may fail if the range is invalid on a shallow clone — degrade to last commit
if ! git log --format='%H %s' "$RANGE" > /tmp/commits.txt 2>/dev/null; then
    echo "  (range not resolvable — checking HEAD only)"
    git log --format='%H %s' -1 > /tmp/commits.txt
fi

while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    CHECKED=$((CHECKED + 1))
    SHA="${line%% *}"
    SUBJ="${line#* }"

    # Rule A — anonymous canned subjects
    if [[ "$SUBJ" =~ ^chore:[[:space:]]*(pipeline[[:space:]]+update|sync|update|misc)$ ]]; then
        echo "::warning title=Anonymous commit subject::${SHA:0:8}: \"$SUBJ\" — see data-repo CONTRIBUTING.md § 3 (tool-generated commits need workflow name, run id, triggered-by)"
        FLAGS=$((FLAGS + 1))
        continue
    fi

    # Rule B — subject under 15 characters
    if [[ ${#SUBJ} -lt 15 ]]; then
        echo "::warning title=Commit subject too short::${SHA:0:8}: \"$SUBJ\" (${#SUBJ} chars) — subjects should be 15+ chars, operation-first (see data-repo CONTRIBUTING.md § 1)"
        FLAGS=$((FLAGS + 1))
        continue
    fi

    # Rule C — bare merge subjects (Git default merge messages with no summary)
    if [[ "$SUBJ" =~ ^Merge[[:space:]](branch|pull[[:space:]]request)[[:space:]]\'[^\']+\'?$ ]]; then
        echo "::warning title=Bare merge subject::${SHA:0:8}: \"$SUBJ\" — merges should describe what integrated (see data-repo CONTRIBUTING.md § 1)"
        FLAGS=$((FLAGS + 1))
        continue
    fi
done < /tmp/commits.txt

echo ""
echo "commit-hygiene: checked $CHECKED commit(s), flagged $FLAGS"
if [[ $FLAGS -gt 0 ]]; then
    echo "Reference: https://github.com/AI-Rosetta-Stone/ai-triad-data/blob/main/CONTRIBUTING.md"
fi
exit 0  # advisory only — never fail CI
