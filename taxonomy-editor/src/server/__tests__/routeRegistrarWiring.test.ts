// @vitest-environment node
//
// t/4925: #4545 shipped routes/chatShare.ts with a passing route test, but nothing called
// registerChatShareRoutes, so the endpoints 404'd in production. Route tests register on a
// bare router and can't see that gap. This guard closes it: every registrar exported from
// routes/ must be called from registerAllRoutes.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'routes');
const AGGREGATOR = 'registerAllRoutes';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function exportedRegistrars(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of fs.readdirSync(routesDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const src = stripComments(fs.readFileSync(path.join(routesDir, file), 'utf8'));
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(register\w*Routes)\s*\(/g)) {
      if (m[1] !== AGGREGATOR) found.set(m[1], file);
    }
  }
  return found;
}

function aggregatorBody(): string {
  const src = stripComments(fs.readFileSync(path.join(routesDir, 'all.ts'), 'utf8'));
  const start = src.indexOf(`function ${AGGREGATOR}`);
  expect(start, `routes/all.ts must define ${AGGREGATOR}`).toBeGreaterThanOrEqual(0);
  return src.slice(start);
}

describe('route registrar wiring (t/4925)', () => {
  const registrars = exportedRegistrars();

  it('finds the registrars it is meant to guard', () => {
    expect(registrars.size).toBeGreaterThan(30);
    expect(registrars.get('registerChatShareRoutes')).toBe('chatShare.ts');
  });

  it('every exported register*Routes in routes/ is called from registerAllRoutes', () => {
    const body = aggregatorBody();
    const unwired = [...registrars]
      .filter(([name]) => !new RegExp(`\\b${name}\\s*\\(`).test(body))
      .map(([name, file]) => `${name} (routes/${file})`);
    expect(unwired, 'exported but never registered, so these routes 404 in production').toEqual([]);
  });
});
