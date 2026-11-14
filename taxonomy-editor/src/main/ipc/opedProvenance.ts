// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Source provenance for the handler-built temp and partial OpEdSet literals, extracted from
// opedHandlers so the file stays within its complexity budget (t/275). Pure, unit-testable.

export interface SourceProvenanceInput {
  isUrlMode: boolean;
  isDocumentMode: boolean;
  url?: string;
  sourceName?: string;
  keyClaimsCount?: number;
}

/**
 * t/2898 contract: topic mode omits url, source_name and the count entirely (absent, not 0).
 * t/275 adds document mode, which records source_name instead of source_url.
 */
export function sourceProvenance(p: SourceProvenanceInput): {
  source_mode: 'topic' | 'url' | 'document'; source_url?: string; source_name?: string; source_key_claims_count?: number;
} {
  const source_mode = p.isUrlMode ? 'url' : p.isDocumentMode ? 'document' : 'topic';
  return {
    source_mode,
    ...(p.isUrlMode ? { source_url: p.url } : {}),
    ...(p.isDocumentMode ? { source_name: p.sourceName } : {}),
    ...(p.isUrlMode ? { source_key_claims_count: p.keyClaimsCount } : {}),
  };
}
