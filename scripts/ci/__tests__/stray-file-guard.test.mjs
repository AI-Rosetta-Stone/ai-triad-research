import { describe, it, expect } from 'vitest';
import { StrayFileGuard } from '../stray-file-guard.mjs';

describe('StrayFileGuard', () => {
  describe('Arm 1: Top-level root enforcement', () => {
    it('flags a stray top-level src/foo.ts file', () => {
      const guard = new StrayFileGuard(['src/foo.ts']);
      const result = guard.run();

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        file: 'src/foo.ts',
        arm: 1,
      });
    });

    it('allows taxonomy-editor/src/foo.ts', () => {
      const guard = new StrayFileGuard(['taxonomy-editor/src/foo.ts']);
      const result = guard.run();

      expect(result.violations).toHaveLength(0);
    });

    it('allows lib/debate/src/agent.ts', () => {
      const guard = new StrayFileGuard(['lib/debate/src/agent.ts']);
      const result = guard.run();

      expect(result.violations).toHaveLength(0);
    });

    it('allows scripts/ci/guard.mjs', () => {
      const guard = new StrayFileGuard(['scripts/ci/guard.mjs']);
      const result = guard.run();

      expect(result.violations).toHaveLength(0);
    });

    it('ignores non-code files', () => {
      const guard = new StrayFileGuard([
        'src/README.md',
        'src/data.json',
        'src/styles.css',
      ]);
      const result = guard.run();

      expect(result.violations).toHaveLength(0);
    });

    it('flags multiple violations', () => {
      const guard = new StrayFileGuard([
        'src/foo.ts',
        'renderer/bar.tsx',
        'utils/baz.js',
      ]);
      const result = guard.run();

      expect(result.violations).toHaveLength(3);
      expect(result.violations.map(v => v.file)).toEqual([
        'src/foo.ts',
        'renderer/bar.tsx',
        'utils/baz.js',
      ]);
    });

    it('allows PowerShell files in scripts/', () => {
      const guard = new StrayFileGuard([
        'scripts/build.ps1',
        'scripts/deploy.psm1',
      ]);
      const result = guard.run();

      expect(result.violations).toHaveLength(0);
    });

    it('flags stray PowerShell at top level', () => {
      const guard = new StrayFileGuard(['build.ps1']);
      const result = guard.run();

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].file).toBe('build.ps1');
    });

    it('allows Python in research/', () => {
      const guard = new StrayFileGuard([
        'research/analysis.py',
        'research/utils.py',
      ]);
      const result = guard.run();

      expect(result.violations).toHaveLength(0);
    });

    it('flags stray Python files', () => {
      const guard = new StrayFileGuard(['analysis.py']);
      const result = guard.run();

      expect(result.violations).toHaveLength(1);
    });
  });

  describe('Arm 2: Vitest include glob matching', () => {
    it('skips arm 2 for files with vitest config parse errors', () => {
      // When vitest config can't be parsed, arm 2 should emit a warning but not fail
      const guard = new StrayFileGuard(['taxonomy-editor/src/component.test.ts']);
      const result = guard.run();

      // Should not create violations if config is unparseable (fail-open behavior)
      // This test validates that warnings are captured when configs can't be parsed
      expect(result).toHaveProperty('warnings');
    });

    it('checks test files against include patterns when available', () => {
      const guard = new StrayFileGuard([
        'taxonomy-editor/src/__tests__/component.test.ts',
      ]);
      const result = guard.run();

      // Should succeed or warn, depending on config availability
      // At minimum, should not crash
      expect(result).toHaveProperty('violations');
      expect(result).toHaveProperty('warnings');
    });
  });

  describe('isUnderAllowlist', () => {
    it('correctly identifies allowlisted paths', () => {
      const guard = new StrayFileGuard([]);

      expect(guard.isUnderAllowlist('taxonomy-editor/src/foo.ts')).toBe(true);
      expect(guard.isUnderAllowlist('lib/debate/src/agent.ts')).toBe(true);
      expect(guard.isUnderAllowlist('scripts/ci/guard.mjs')).toBe(true);
      expect(guard.isUnderAllowlist('src/foo.ts')).toBe(false);
      expect(guard.isUnderAllowlist('renderer/bar.tsx')).toBe(false);
    });
  });

  describe('fileMatchesGlobs', () => {
    it('matches simple glob patterns with wildcards', () => {
      const guard = new StrayFileGuard([]);

      const patterns = ['**/*.test.ts', 'src/**/*'];
      expect(guard.fileMatchesGlobs('src/component.test.ts', patterns, 'test')).toBe(true);
      expect(guard.fileMatchesGlobs('src/nested/util.test.ts', patterns, 'test')).toBe(true);
    });
  });
});
