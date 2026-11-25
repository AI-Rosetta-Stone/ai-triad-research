// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/678 (PI decision 5e, t/574#13; TL p/10#315): a source's full text and file are sign-in only. The server says so
// either with 403 reason `anon_route_blocked` (/api/snapshots/:sourceId, /api/source-documents/:docId/file) or with
// `signInRequired: true` on the /api/source-documents/:docId resolution. The renderer shows a sign-in prompt in
// either case, never the raw 403 or an empty pane.

/** True when a bridge error is the server's sign-in-required refusal for an anonymous caller. */
export function isSignInRequiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { httpStatus?: number; problem?: unknown; message?: unknown };
  if (e.httpStatus !== 403) return false;
  return /anon_route_blocked/.test(`${String(e.problem ?? '')} ${String(e.message ?? '')}`);
}

export type SnapshotResult = { content: string; signInRequired?: boolean } | null;

/** The web snapshot load: a sign-in refusal becomes `{ signInRequired }`; any other failure takes `onOtherError`. */
export function snapshotOrSignIn(request: Promise<unknown>, onOtherError: (err: unknown) => SnapshotResult): Promise<SnapshotResult> {
  return request
    .then((r) => r as SnapshotResult)
    .catch((err: unknown) => (isSignInRequiredError(err) ? { content: '', signInRequired: true } : onOtherError(err)));
}
