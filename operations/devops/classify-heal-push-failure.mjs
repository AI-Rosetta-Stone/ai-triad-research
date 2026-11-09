// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4137 item 3 (observability, credential-agnostic): `dependabot-lockfile-heal.yml`'s crash
 * guard only covered an ABSENT credential. A rejected/expired one (PAT lapsed, App key rotated,
 * App uninstalled) still failed with git's own opaque stderr, giving no actionable signal that
 * the credential itself is the problem. This classifies a failed `git push`'s stderr so the
 * workflow can emit a distinct, actionable `::error::` for the credential-rejected case,
 * leaving every other push failure (network blip, non-fast-forward, etc.) with its own message.
 *
 * Patterns (git's own wording for a rejected credential over HTTPS):
 *   - "could not read Username" -- the extraheader auth value was empty/malformed.
 *   - a bare "403" -- GitHub's HTTP status for an authenticated-but-forbidden push (expired
 *     PAT, App installation missing contents:write, App uninstalled).
 *   - "Authentication failed" -- the generic credential-rejected message on some git/http
 *     backends.
 * Deliberately NOT credential-specific (no PAT vs. App-token branching) -- this matches
 * whichever credential heal uses today, so it does not need to change when the App/PAT switch
 * (t/4137 items 1/2/4) eventually lands.
 */
const CREDENTIAL_REJECTED_RE = /could not read Username|(?:^|[^0-9])403(?:[^0-9]|$)|Authentication failed/i;

/** PURE. Classifies a failed `git push`'s captured stderr/combined output. */
export function classifyHealPushFailure(pushOutput) {
  return CREDENTIAL_REJECTED_RE.test(String(pushOutput ?? '')) ? 'credential_rejected' : 'other';
}

// CLI: reads all of stdin, prints the classification word (no trailing newline) to stdout, so
// the workflow step can capture it with `$(... | node classify-heal-push-failure.mjs)`.
import { fileURLToPath } from 'node:url';
const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => { process.stdout.write(classifyHealPushFailure(input)); });
}
