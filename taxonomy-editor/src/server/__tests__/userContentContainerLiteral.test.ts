// @vitest-environment node

/**
 * t/4733 / t/4738 — staging isolation depends on every blob store resolving the user-content
 * container through ONE env-aware helper (`storage/userContentContainer.ts`). The free-pool
 * budget hard-coded the prod container name instead, so staging traffic drained prod's daily
 * budget (t/4733). Failure class: "a new blob store skips staging isolation"
 * (docs/CodeReview/failure-classes.md).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { userContentContainer, isUserContentContainerConfigured, DEFAULT_USER_CONTENT_CONTAINER } from '../storage/userContentContainer.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(serverRoot, 'storage', 'userContentContainer.ts');
const LITERAL = /(['"`])user-content\1/;

function serverSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...serverSourceFiles(full));
    } else if (/\.(ts|mts|cts)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Code lines only: a doc comment may name the container when explaining the rule. */
function literalHits(file: string): string[] {
  return fs.readFileSync(file, 'utf-8').split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && LITERAL.test(line))
    .map(({ n }) => `${path.relative(serverRoot, file)}:${n}`);
}

describe('user-content container: single env-aware source (t/4733)', () => {
  it('userContentContainer() reads AZURE_USER_CONTENT_CONTAINER, else the prod default', () => {
    expect(userContentContainer({ AZURE_USER_CONTENT_CONTAINER: 'staging-user-content' })).toBe('staging-user-content');
    expect(userContentContainer({})).toBe(DEFAULT_USER_CONTENT_CONTAINER);
    expect(isUserContentContainerConfigured({ AZURE_USER_CONTENT_CONTAINER: 'staging-user-content' })).toBe(true);
    expect(isUserContentContainerConfigured({})).toBe(false);
  });

  it('no server module except the helper spells out the prod container name', () => {
    const hits = serverSourceFiles(serverRoot).filter(f => f !== HELPER).flatMap(literalHits);
    expect(hits).toEqual([]);
  });

  it('the scan itself detects a literal (guard against a scan that matches nothing)', () => {
    expect(LITERAL.test(`const c = 'user-content';`)).toBe(true);
    expect(LITERAL.test(`const c = "user-content";`)).toBe(true);
    expect(LITERAL.test(`const c = 'staging-user-content';`)).toBe(false);
    expect(literalHits(HELPER).length).toBeGreaterThan(0); // the helper itself does contain it
  });
});
