#!/usr/bin/env node

/**
 * Stray-file guard: CI check for code/test files placed outside allowlisted package roots.
 * Arm 1: enforces top-level root constraints.
 * Arm 2: enforces vitest include glob matching for test files (fail-open on config parse errors).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// Allowlist derived from main's current top-level dirs (as of 2026-10-31).
// Generated from: git ls-tree -d --name-only origin/main | sort
// New legitimate top-level roots require an allowlist update in the same PR that introduces them.
const ALLOWLIST = [
  'analyses/',
  'build/',
  'calibration/',
  'citeonly-logs/',
  'deploy/',
  'docs/',
  'engineering/',
  'evals/',
  'lib/',
  'management/',
  'operations/',
  'poviewer/',
  'research/',
  'scripts/',
  'summary-viewer/',
  'taxonomy/',
  'taxonomy-editor/',
  'taxonomy-snapshot/',
  'test-baselines/',
  'tests/',
  'tools/',
  'workflow-app/',
  '.github/',
];

// Code and test file extensions to check
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.py', '.ps1', '.psm1'];
const TEST_EXTENSIONS = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

// Vitest projects with their config paths and include patterns
const VITEST_PROJECTS = [
  { name: 'taxonomy-editor', configPath: 'taxonomy-editor/vite.config.ts' },
  { name: 'poviewer', configPath: 'poviewer/vite.config.ts' },
  { name: 'summary-viewer', configPath: 'summary-viewer/vite.config.ts' },
  { name: 'lib/debate', configPath: 'lib/debate/vitest.config.ts' },
];

class StrayFileGuard {
  constructor(changedFiles = []) {
    this.changedFiles = changedFiles;
    this.violations = [];
    this.warnings = [];
  }

  run() {
    console.log(`[stray-file-guard] Checking ${this.changedFiles.length} changed files`);

    // Arm 1: Top-level root enforcement
    this.armOneTopLevelRoots();

    // Arm 2: Vitest include glob matching
    this.armTwoVitestIncludeGlobs();

    return {
      violations: this.violations,
      warnings: this.warnings,
      hasViolations: this.violations.length > 0,
    };
  }

  armOneTopLevelRoots() {
    const codeFiles = this.changedFiles.filter(file => {
      const ext = CODE_EXTENSIONS.find(e => file.endsWith(e));
      return ext && !this.isUnderAllowlist(file);
    });

    codeFiles.forEach(file => {
      const topLevel = file.split('/')[0];
      this.violations.push({
        file,
        arm: 1,
        message: `Code/test file outside allowlisted roots: ${file} (top-level: ${topLevel}/)`,
      });
    });
  }

  armTwoVitestIncludeGlobs() {
    const testFiles = this.changedFiles.filter(file => {
      const isTest = TEST_EXTENSIONS.some(e => file.endsWith(e));
      return isTest && this.isUnderAllowlist(file);
    });

    if (testFiles.length === 0) return;

    const includesByProject = this.loadVitestIncludePatterns();

    testFiles.forEach(file => {
      let matched = false;

      for (const [project, includes] of Object.entries(includesByProject)) {
        if (includes === null) {
          // Fail open: skip this project due to parse error
          this.warnings.push({
            file,
            project,
            message: `Skipping Arm 2 check for ${project}: vitest config parse error (file still allowed)`,
          });
          continue;
        }

        // Check if file matches any include glob in this project
        if (this.fileMatchesGlobs(file, includes, project)) {
          matched = true;
          break;
        }
      }

      if (!matched && Object.values(includesByProject).some(i => i !== null)) {
        this.violations.push({
          file,
          arm: 2,
          message: `Test file does not match any vitest project's include glob: ${file}`,
        });
      }
    });
  }

  isUnderAllowlist(file) {
    return ALLOWLIST.some(root => file.startsWith(root));
  }

  loadVitestIncludePatterns() {
    const byProject = {};

    VITEST_PROJECTS.forEach(proj => {
      const configPath = path.join(repoRoot, proj.configPath);
      try {
        if (!fs.existsSync(configPath)) {
          byProject[proj.name] = null;
          return;
        }

        const configContent = fs.readFileSync(configPath, 'utf8');
        const includes = this.extractVitestIncludes(configContent);
        byProject[proj.name] = includes;
      } catch (err) {
        // Fail open: emit warning and skip this project
        this.warnings.push({
          project: proj.name,
          message: `Failed to parse vitest config for ${proj.name}: ${err.message} (Arm 2 skipped for this project)`,
        });
        byProject[proj.name] = null;
      }
    });

    return byProject;
  }

  extractVitestIncludes(configContent) {
    // Simple regex to find include patterns in vitest config
    // Looks for: include: ["pattern1", "pattern2", ...] or similar
    // Handles both static strings and does NOT handle dynamic expressions
    const match = configContent.match(/include\s*:\s*\[\s*([^\]]+)\s*\]/);
    if (!match) return [];

    const itemsStr = match[1];
    // Extract quoted strings
    const items = [];
    const stringMatches = itemsStr.matchAll(/["']([^"']+)["']/g);
    for (const m of stringMatches) {
      items.push(m[1]);
    }

    return items;
  }

  fileMatchesGlobs(file, globPatterns, projectName) {
    // Simple glob matching - handles * wildcards
    // For full glob support, a real library would be used
    return globPatterns.some(pattern => {
      // Convert glob pattern to regex
      const regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regex = new RegExp(`^${regexPattern}$`);
      return regex.test(file);
    });
  }
}

// Main entry point
async function main() {
  // Get changed files from stdin or command line argument
  let changedFiles = [];

  if (process.argv[2] === '--from-stdin') {
    const input = fs.readFileSync(0, 'utf-8');
    changedFiles = input.trim().split('\n').filter(f => f);
  } else if (process.argv[2]) {
    changedFiles = process.argv.slice(2);
  } else {
    console.log('Usage: stray-file-guard.mjs <file1> [file2...] OR --from-stdin');
    process.exit(0);
  }

  const guard = new StrayFileGuard(changedFiles);
  const result = guard.run();

  // Output violations and warnings
  if (result.violations.length > 0) {
    console.log(`\n::error::Stray file violations found (${result.violations.length}):`);
    result.violations.forEach(v => {
      console.log(`  ::error file=${v.file}::${v.message}`);
    });
  }

  if (result.warnings.length > 0) {
    console.log(`\n::warning::Stray file warnings (${result.warnings.length}):`);
    result.warnings.forEach(w => {
      console.log(`  ::warning::${w.message}`);
    });
  }

  if (result.hasViolations) {
    console.log('\n::notice::Violations require fixing before merge.');
    process.exit(0); // Warn-only for now (T0 phase)
  } else {
    console.log('\n[stray-file-guard] All checks passed.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

export { StrayFileGuard };
