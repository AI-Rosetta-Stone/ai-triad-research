// @vitest-environment node
//
// t/4486#4 (TEMPORARY, same arc as t/4406's authPresenceDiag) — shape-only diagnostic feeding
// Azure's prod-log pull (p/793#46/#48) on the IPv6 client share, so the IPv4-only-vs-ship-IPv6
// decision has real evidence instead of a guess. Shape only, never the IP.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({ log: { api: { info: vi.fn(), warn: vi.fn() } } }));

import { classifyIpShape, logIpShapeIfEnabled, FREE_POOL_IP_SHAPE_DIAG_EXPIRES_AT } from '../ai/freePoolIpShapeDiag.js';
import { log } from '../logger.js';

describe('classifyIpShape', () => {
  it('classifies a plain IPv4 address', () => {
    expect(classifyIpShape('8.8.8.8')).toBe('ipv4');
  });
  it('classifies an IPv4-mapped IPv6 address', () => {
    expect(classifyIpShape('::ffff:8.8.8.8')).toBe('ipv4-mapped-ipv6');
  });
  it('classifies a genuine IPv6 address', () => {
    expect(classifyIpShape('2001:db8::1')).toBe('ipv6-genuine');
  });
  it('classifies the "unknown" sentinel as no-public-ip', () => {
    expect(classifyIpShape('unknown')).toBe('no-public-ip');
  });
  it('strips a zone id and bracketed port before classifying', () => {
    expect(classifyIpShape('fe80::1%eth0')).toBe('ipv6-genuine');
    expect(classifyIpShape('[::ffff:8.8.8.8]:443')).toBe('ipv4-mapped-ipv6');
  });
});

describe('logIpShapeIfEnabled', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('logs the shape (never the IP) before the expiry', () => {
    logIpShapeIfEnabled('8.8.8.8', FREE_POOL_IP_SHAPE_DIAG_EXPIRES_AT - 1000);
    expect(log.api.info).toHaveBeenCalledTimes(1);
    const [fields] = (log.api.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fields.shape).toBe('ipv4');
    expect(JSON.stringify(fields)).not.toContain('8.8.8.8');
  });

  it('WARNs once and stops logging past the expiry', () => {
    logIpShapeIfEnabled('8.8.8.8', FREE_POOL_IP_SHAPE_DIAG_EXPIRES_AT + 1000);
    logIpShapeIfEnabled('8.8.8.8', FREE_POOL_IP_SHAPE_DIAG_EXPIRES_AT + 2000);
    expect(log.api.info).not.toHaveBeenCalled();
    expect(log.api.warn).toHaveBeenCalledTimes(1); // once, not twice
  });
});
