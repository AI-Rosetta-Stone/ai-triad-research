Tier: T2

## Summary

Add stable identity key to UserContext (`<idp>:<value>` format) for GitHub and AAD, enabling idp-qualified matching for t/4328 (isAdmin fix) and t/4612 (Desktop Ask auth model).

Auth surface change. Joins t/4328/t/4612 SO round as joint-gv co-landing (not a separate consult).

## Implementation

- Record stableId in WeakMap (t/4540 pattern) in principalName.ts
  - GitHub: numeric ID from nameidentifier claim or x-ms-client-principal-id header
  - AAD: tid+oid combination from claims (fail-closed if either missing)
  - Google: deferred (no canonicalizeGoogle yet; stableId undefined for Google users)
- Add stableId field to UserContext interface
- Expose via getStableId() getter in userContext.ts
- Capture in resolveRequestUserContext via getRequestStableId(req)

## Testing

- 18 new tests covering GitHub (claim, header, mismatch), AAD (both fields, missing fields), invalid charset, non-GitHub/AAD IDPs, anonymous requests
- Equality test: getRequestStableId matches IDENTITY_MAP key when mapped
- All 65 tests pass (47 existing + 18 new)
- tsc --noEmit: no type errors

## Unblocks

- t/4328: isAdmin with idp-qualified matching (e.g., `github:12345` in ADMIN_USERS)
- t/4612: Desktop Ask auth model (stable identity binding for browser-mediated sign-in)

Both are T2 tickets in joint SO review waiting on this contract.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
