// @vitest-environment node

// t/1990: proves the CVE-2026-58040 mitigation's config survives the undici 6→8 bump —
// maxCachedSessions:0 (disables TLS session caching) and allowH2:false (pins the tested
// HTTP/1.1-only behavior; undici 8 defaults allowH2:true, see githubRestClient.ts) are both
// still passed to the Agent construction. Mocks undici's Agent rather than touching
// production code, so this never depends on the local Node/undici major matching —
// module-level `new Agent(...)` runs at import time regardless of runtime version.

import { describe, it, expect, vi } from 'vitest';

const AgentCtor = vi.fn();
vi.mock('undici', () => ({ Agent: AgentCtor }));

describe('githubRestClient.ts module-level Agent construction (t/1990 CVE-2026-58040 re-proof)', () => {
  it('constructs the Agent with TLS session caching disabled and HTTP/2 pinned off', async () => {
    await import('../storage/githubRestClient.js');
    expect(AgentCtor).toHaveBeenCalledTimes(1);
    const opts = AgentCtor.mock.calls[0][0];
    expect(opts.connect.maxCachedSessions).toBe(0);
    expect(opts.allowH2).toBe(false);
  });
});
