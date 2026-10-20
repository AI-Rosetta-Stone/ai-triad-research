// @vitest-environment node
//
// t/4300 (TL ruling, p/538#101/p/522#436) — logRequestMetrics is the measurement the SO's C2
// needs: outbound GitHub requests by route class + rateLimitRemaining, not cache misses
// (getColdCacheMissCount() instruments only 1 of 4 fetch paths and misses session-branch reads
// entirely — Server Storage, t/4300#18). This is a priority fix: the next prod deploy carries
// #3457's cache move and waits on this line.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { warnMock, infoMock, recordMock } = vi.hoisted(() => ({
  warnMock: vi.fn(), infoMock: vi.fn(), recordMock: vi.fn(),
}));
vi.mock('../logger.js', () => ({ log: { server: { info: infoMock, warn: warnMock, error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

import { logRequestMetrics, REQUEST_METRICS_LOG_DELAY_MS } from '../requestMetricsLog.js';

beforeEach(() => { infoMock.mockClear(); recordMock.mockClear(); });

describe('t/4300 — logRequestMetrics', () => {
  it('logs totalRequests/byRouteClass/rateLimitRemaining tagged with the given context, to both the logger and the flight recorder', () => {
    const metrics = { totalRequests: 112, byRouteClass: { contents: 80, tree: 20, blob: 10, refs: 2 }, rateLimitRemaining: 4888 };
    const backend = { getRequestMetrics: () => metrics } as any;
    logRequestMetrics(backend, '10min-post-boot');
    expect(infoMock).toHaveBeenCalledWith(
      expect.objectContaining({ context: '10min-post-boot', ...metrics }),
      expect.stringContaining('112 total'),
    );
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info', data: expect.objectContaining({ context: '10min-post-boot', ...metrics }),
    }));
  });

  it('tags the shutdown call site distinctly from the post-boot one', () => {
    const metrics = { totalRequests: 7, byRouteClass: { contents: 7 }, rateLimitRemaining: 4993 };
    const backend = { getRequestMetrics: () => metrics } as any;
    logRequestMetrics(backend, 'shutdown');
    expect(infoMock).toHaveBeenCalledWith(expect.objectContaining({ context: 'shutdown', totalRequests: 7 }), expect.anything());
  });

  it('no-ops when backend is null (filesystem/Electron mode — nothing to measure)', () => {
    logRequestMetrics(null, '10min-post-boot');
    expect(infoMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('exports a ~10-minute delay constant for the boot-side setTimeout', () => {
    expect(REQUEST_METRICS_LOG_DELAY_MS).toBe(10 * 60_000);
  });
});

describe('t/4300 — wiring: server.ts calls logRequestMetrics from both the ~10min-post-boot timer and shutdown()', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = fs.readFileSync(path.join(here, '..', 'server.ts'), 'utf-8');

  it('imports logRequestMetrics from requestMetricsLog.js', () => {
    expect(serverSrc).toMatch(/import \{ logRequestMetrics, REQUEST_METRICS_LOG_DELAY_MS \} from '\.\/requestMetricsLog\.js'/);
  });

  it('schedules the post-boot call inside server.listen, unref\'d, with the 10min delay constant', () => {
    const listenIdx = serverSrc.indexOf('server.listen(PORT, BIND_HOST');
    const bootCallIdx = serverSrc.indexOf("logRequestMetrics(githubBackend, '10min-post-boot')");
    expect(listenIdx).toBeGreaterThan(-1);
    expect(bootCallIdx).toBeGreaterThan(listenIdx);
    expect(serverSrc).toMatch(/setTimeout\(\(\) => logRequestMetrics\(githubBackend, '10min-post-boot'\), REQUEST_METRICS_LOG_DELAY_MS\)\.unref\(\)/);
  });

  it('calls it again inside shutdown(), after githubBackend.shutdown()', () => {
    const shutdownFnIdx = serverSrc.indexOf('function shutdown(signal: string)');
    const backendShutdownIdx = serverSrc.indexOf('githubBackend.shutdown();');
    const shutdownCallIdx = serverSrc.indexOf("logRequestMetrics(githubBackend, 'shutdown')");
    expect(shutdownFnIdx).toBeGreaterThan(-1);
    expect(backendShutdownIdx).toBeGreaterThan(shutdownFnIdx);
    expect(shutdownCallIdx).toBeGreaterThan(backendShutdownIdx);
  });
});
