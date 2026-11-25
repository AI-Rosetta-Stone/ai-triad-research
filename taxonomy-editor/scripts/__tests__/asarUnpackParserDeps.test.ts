// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/662 (TL p/10#309): the isolated document parser runs in a forked child under Node's permission model,
// which can't read inside app.asar (t/631). Every package the parser loads at run time, and everything
// those packages depend on, must therefore be in electron-builder.yml asarUnpack. If one is missing, the
// t/634 probe answers false and the desktop Document source is hidden with no error. This test derives the
// dependency closure from the parser's own imports, so a new dependency fails here instead.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const teDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const parserDir = resolve(teDir, '..', 'lib', 'extraction', 'isolated');

/** Package names the parser's .mjs files import (static `from '…'` and dynamic `import('…')`), skipping relative and node: specifiers. */
export function bareImports(source: string): string[] {
  const specs = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return specs
    .filter((s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:'))
    .map((s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]));
}

/** The real directory of package `name` as Node would find it from `fromDir` (climbing node_modules). */
function findPackageDir(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/** The runtime dependency closure (dependencies, plus optionalDependencies that are installed). */
function dependencyClosure(roots: string[]): { names: Set<string>; unresolved: string[] } {
  const names = new Set<string>();
  const unresolved: string[] = [];
  const queue = roots.map((name) => ({ name, from: teDir, optional: false }));
  while (queue.length) {
    const { name, from, optional } = queue.shift()!;
    if (names.has(name)) continue;
    const dir = findPackageDir(name, from);
    if (!dir) {
      if (!optional) unresolved.push(name);
      continue;
    }
    names.add(name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, from: dir, optional: true });
  }
  return { names, unresolved };
}

/** asarUnpack `node_modules/<pattern>/**` entries from electron-builder.yml, as regexes over a package name (a scope entry covers its packages). */
export function unpackedPackagePatterns(yml: string): RegExp[] {
  const block = yml.split(/^asarUnpack:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  return [...block.matchAll(/^\s*-\s*["']?node_modules\/(.+?)\/\*\*["']?\s*$/gm)].map(
    (m) => new RegExp(`^${m[1].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}(/.*)?$`),
  );
}

describe('asarUnpack covers the isolated parser (t/662)', () => {
  const sources = readdirSync(parserDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => readFileSync(join(parserDir, f), 'utf8'));
  const roots = [...new Set(sources.flatMap(bareImports))];
  const { names, unresolved } = dependencyClosure(roots);
  const patterns = unpackedPackagePatterns(readFileSync(join(teDir, 'electron-builder.yml'), 'utf8'));

  it('finds the parser packages and resolves every dependency', () => {
    expect(roots).toEqual(expect.arrayContaining(['pdfjs-dist', 'mammoth']));
    expect(unresolved).toEqual([]);
    expect(names.size).toBeGreaterThan(roots.length);
  });

  it('every package in the closure is in asarUnpack', () => {
    const missing = [...names].filter((n) => !patterns.some((p) => p.test(n))).sort();
    expect(missing, `add "node_modules/<name>/**" to electron-builder.yml asarUnpack for: ${missing.join(', ')}`).toEqual([]);
  });

  // Both arms: the check must fail when a dependency is missing, so it can't pass vacuously.
  it('reports a package that is not unpacked', () => {
    expect(names.has('lop')).toBe(true);
    const without = patterns.filter((p) => !p.test('lop'));
    expect([...names].filter((n) => !without.some((p) => p.test(n)))).toContain('lop');
  });

  it('parses imports and glob entries', () => {
    expect(bareImports(`import a from './x.mjs';\nconst m = await import('mammoth');\nimport('pdfjs-dist/legacy/build/pdf.mjs');\nimport fs from 'node:fs';\nimport { y } from '@xmldom/xmldom';`))
      .toEqual(['mammoth', 'pdfjs-dist', '@xmldom/xmldom']);
    const ps = unpackedPackagePatterns('asarUnpack:\n  - "node_modules/onnxruntime-*/**"\n  - "dist/main/lib/**"\n  - "node_modules/@xmldom/**"\nextraResources:\n  - "node_modules/nope/**"\n');
    expect(['onnxruntime-common', '@xmldom/xmldom', 'nope', 'onnxruntime'].map((n) => ps.some((p) => p.test(n)))).toEqual([true, true, false, false]);
  });
});
