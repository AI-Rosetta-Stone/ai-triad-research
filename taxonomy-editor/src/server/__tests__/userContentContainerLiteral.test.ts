// @vitest-environment node

/**
 * t/4733 / t/4738 — staging isolation depends on every blob store resolving the user-content
 * container through ONE env-aware helper (`storage/userContentContainer.ts`). The free-pool
 * budget hard-coded the prod container name instead, so staging traffic drained prod's daily
 * budget (t/4733). t/4756 adds communityContainer() and briefExportsContainer() helpers
 * with the same pattern. Failure class: "a new blob store skips staging isolation"
 * (docs/CodeReview/failure-classes.md).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { userContentContainer, isUserContentContainerConfigured, DEFAULT_USER_CONTENT_CONTAINER } from '../storage/userContentContainer.js';
import { communityContainer, isCommunityContainerConfigured, DEFAULT_COMMUNITY_CONTAINER } from '../storage/communityContainer.js';
import { briefExportsContainer, isBriefExportsContainerConfigured, DEFAULT_BRIEF_EXPORTS_CONTAINER } from '../storage/briefExportsContainer.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_CONTENT_HELPER = path.join(serverRoot, 'storage', 'userContentContainer.ts');
const COMMUNITY_HELPER = path.join(serverRoot, 'storage', 'communityContainer.ts');
const BRIEF_EXPORTS_HELPER = path.join(serverRoot, 'storage', 'briefExportsContainer.ts');
const USER_CONTENT_LITERAL = /(['"`])user-content\1/;
const COMMUNITY_LITERAL = /(['"`])community\1/;
const BRIEF_EXPORTS_LITERAL = /(['"`])brief-exports\1/;

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
function literalHits(file: string, literal: RegExp): string[] {
  return fs.readFileSync(file, 'utf-8').split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && literal.test(line))
    .map(({ n }) => `${path.relative(serverRoot, file)}:${n}`);
}

describe('blob container names: single env-aware sources (t/4733, t/4756)', () => {
  it('userContentContainer() reads AZURE_USER_CONTENT_CONTAINER, else the prod default', () => {
    expect(userContentContainer({ AZURE_USER_CONTENT_CONTAINER: 'staging-user-content' })).toBe('staging-user-content');
    expect(userContentContainer({})).toBe(DEFAULT_USER_CONTENT_CONTAINER);
    expect(isUserContentContainerConfigured({ AZURE_USER_CONTENT_CONTAINER: 'staging-user-content' })).toBe(true);
    expect(isUserContentContainerConfigured({})).toBe(false);
  });

  it('communityContainer() reads AZURE_COMMUNITY_CONTAINER, else the prod default (t/4756)', () => {
    expect(communityContainer({ AZURE_COMMUNITY_CONTAINER: 'staging-community' })).toBe('staging-community');
    expect(communityContainer({})).toBe(DEFAULT_COMMUNITY_CONTAINER);
    expect(isCommunityContainerConfigured({ AZURE_COMMUNITY_CONTAINER: 'staging-community' })).toBe(true);
    expect(isCommunityContainerConfigured({})).toBe(false);
  });

  it('briefExportsContainer() reads AZURE_BRIEF_EXPORTS_CONTAINER, else the prod default (t/4756)', () => {
    expect(briefExportsContainer({ AZURE_BRIEF_EXPORTS_CONTAINER: 'staging-brief-exports' })).toBe('staging-brief-exports');
    expect(briefExportsContainer({})).toBe(DEFAULT_BRIEF_EXPORTS_CONTAINER);
    expect(isBriefExportsContainerConfigured({ AZURE_BRIEF_EXPORTS_CONTAINER: 'staging-brief-exports' })).toBe(true);
    expect(isBriefExportsContainerConfigured({})).toBe(false);
  });

  it('no server module except the user-content helper spells out the prod container name', () => {
    const otherFiles = serverSourceFiles(serverRoot).filter(f => f !== USER_CONTENT_HELPER);
    const hits = otherFiles.flatMap(f => literalHits(f, USER_CONTENT_LITERAL));
    expect(hits).toEqual([]);
  });

  it('the scan itself detects literals (guard against a scan that matches nothing)', () => {
    expect(USER_CONTENT_LITERAL.test(`const c = 'user-content';`)).toBe(true);
    expect(COMMUNITY_LITERAL.test(`const c = 'community';`)).toBe(true);
    expect(BRIEF_EXPORTS_LITERAL.test(`const c = 'brief-exports';`)).toBe(true);
    expect(literalHits(USER_CONTENT_HELPER, USER_CONTENT_LITERAL).length).toBeGreaterThan(0);
    expect(literalHits(COMMUNITY_HELPER, COMMUNITY_LITERAL).length).toBeGreaterThan(0);
    expect(literalHits(BRIEF_EXPORTS_HELPER, BRIEF_EXPORTS_LITERAL).length).toBeGreaterThan(0);
  });
});
