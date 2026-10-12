# Runbook: Force Push / History Rewrite Recovery

**Trigger:** `cache.invalidate` events with trigger `force-push`, or Compare API returning 404/422

## Symptoms
- Flight recorder shows `cache.invalidate` with `trigger: force-push`
- Cache fully invalidated and re-fetched (brief slowdown)
- Active session branches may show warnings: "Main branch was rewritten"
- Users may see stale data briefly during re-fetch

## Steps

1. **Verify what happened:**
   ```bash
   # Check recent force-pushes on the data repo
   gh api repos/AI-Rosetta-Stone/ai-triad-data/events --jq '.[] | select(.type=="PushEvent") | {ref: .payload.ref, forced: .payload.forced, pusher: .actor.login, created: .created_at}' | head -5
   ```

2. **Check cache recovery:**
   ```bash
   curl -s .../health | jq '{mainSha: .storage.mainSha, cacheFileCount: .storage.cacheFileCount, fallbackActive: .storage.fallbackActive}'
   ```
   Cache should have auto-recovered (full re-fetch via Trees API).

3. **Check active session branches:**
   ```bash
   gh api repos/AI-Rosetta-Stone/ai-triad-data/git/refs/heads/api-session --jq '.[].ref' 2>/dev/null
   ```
   If any exist, verify their base SHA is still in main's history:
   ```bash
   gh api repos/AI-Rosetta-Stone/ai-triad-data/compare/main...api-session/{userId} --jq '.status'
   ```
   - `ahead` or `behind` → branch is valid
   - `diverged` → branch needs rebase
   - 404 → branch base was rewritten, user must recreate

4. **Notify affected users:** If session branches were orphaned, users need to:
   - Download their changes (via PR diff if one exists)
   - Delete and recreate their session branch from current main

## Prevention
- Avoid force-pushes to the data repo's main branch
- If necessary, coordinate with active users first
- Cache auto-recovers within seconds (full tree re-fetch)
