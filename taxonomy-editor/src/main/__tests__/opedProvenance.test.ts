// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { sourceProvenance } from '../ipc/opedProvenance.js';

describe('sourceProvenance (t/2898 contract, t/275 document mode)', () => {
  it('topic mode omits url, source_name and count entirely (absent, not 0)', () => {
    const p = sourceProvenance({ isUrlMode: false, isDocumentMode: false });
    expect(p).toEqual({ source_mode: 'topic' });
    expect('source_url' in p).toBe(false);
    expect('source_key_claims_count' in p).toBe(false);
  });

  it('url mode records source_url and the key-claims count', () => {
    expect(sourceProvenance({ isUrlMode: true, isDocumentMode: false, url: 'https://x.test/a', keyClaimsCount: 3 }))
      .toEqual({ source_mode: 'url', source_url: 'https://x.test/a', source_key_claims_count: 3 });
  });

  it('url mode with no count yet records 0, not an absent field', () => {
    expect(sourceProvenance({ isUrlMode: true, isDocumentMode: false, url: 'https://x.test/a', keyClaimsCount: 0 }).source_key_claims_count).toBe(0);
  });

  it('document mode records source_name and no url or count', () => {
    const p = sourceProvenance({ isUrlMode: false, isDocumentMode: true, sourceName: 'brief.pdf' });
    expect(p).toEqual({ source_mode: 'document', source_name: 'brief.pdf' });
    expect('source_url' in p).toBe(false);
    expect('source_key_claims_count' in p).toBe(false);
  });
});
