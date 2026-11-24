// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/418: the renderer's entry point for redacting a dump before it leaves the machine. The redaction
// itself is in lib/flight-recorder (shared with the main process); this supplies the exact USERPROFILE
// that the preload hands over, so redirected profiles are covered too.

import { redactDumpText } from '@lib/flight-recorder/flightRecorderRedact';

function currentUserProfile(): string | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { electronAPI?: { userProfile?: string | null } }).electronAPI?.userProfile ?? null;
}

/** Redacts a dump's text with the current app's exact user profile (null in web builds). */
export function redactDumpForSharing(text: string): string {
  return redactDumpText(text, currentUserProfile());
}
