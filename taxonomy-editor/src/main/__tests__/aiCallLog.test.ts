// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4088 — main-process AI Call Log writer. Verifies the SCHEMA CONTRACT
// (tests/fixtures/ai-call-log/README.md): 10 named fields in fixed order, the closed KeySource
// vocabulary (an unmappable value is written as '' with a WARN, never free text), the conformance
// fixture's 9 writer lines round-tripping unchanged, plus the pre-existing 7-field behaviors
// (flag-off no-op, advisory monotonic ID, atomic single-line append, fail-safe IO).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../fileIO.js', () => ({
  getDataRootPath: vi.fn(() => '/fake/data-root'),
}));

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: mockRecord }),
}));

import { writeAICallLogEntry, isAICallLogEnabled, type AICallLogEntry } from '../aiCallLog.js';

const SCHEMA_FIELDS = ['ID', 'Datetime', 'Scenario', 'PromptID', 'PromptStart', 'RetryCount', 'Status', 'Model', 'Backend', 'KeySource'];

const sample: AICallLogEntry = {
  scenario: 'Debate', promptId: 'usage.debate.turn', promptStart: 'Argue the accelerationist case',
  retryCount: 0, status: '200', model: 'gemini-3.7-flash', backend: 'gemini', keySource: 'store',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'ai-call-log', 'conformance.jsonl');

// The 9 WRITER cases (line 10 is a reader-only legacy case — new writers always emit all 10 fields).
type FixtureLine = Record<string, unknown>;
function loadWriterFixtureLines(): FixtureLine[] {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8').split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as FixtureLine);
  return raw.filter(l => 'Model' in l);
}

let tmpDir: string;
let logPath: string;
const priorFlag = process.env.AI_CALL_LOG_ENABLED;

function readLines(): string[] {
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.length > 0);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicalllog-main-'));
  logPath = path.join(tmpDir, 'ai-call-log.jsonl');
  mockRecord.mockReset();
  process.env.AI_CALL_LOG_ENABLED = '1';
});

afterEach(() => {
  if (priorFlag === undefined) delete process.env.AI_CALL_LOG_ENABLED;
  else process.env.AI_CALL_LOG_ENABLED = priorFlag;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isAICallLogEnabled', () => {
  it('is true only for truthy tokens (1|true|yes|on, case-insensitive), default off', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'On']) {
      process.env.AI_CALL_LOG_ENABLED = v;
      expect(isAICallLogEnabled(), `"${v}" should enable`).toBe(true);
    }
    for (const v of ['0', 'false', 'no', 'off', '', '  ', 'enabled']) {
      process.env.AI_CALL_LOG_ENABLED = v;
      expect(isAICallLogEnabled(), `"${v}" should NOT enable`).toBe(false);
    }
    delete process.env.AI_CALL_LOG_ENABLED;
    expect(isAICallLogEnabled(), 'unset → off').toBe(false);
  });
});

describe('writeAICallLogEntry', () => {
  it('flag off → no-op, writes nothing', () => {
    delete process.env.AI_CALL_LOG_ENABLED;
    writeAICallLogEntry(sample, logPath);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('flag on → one JSONL record with the 10 schema fields in order and correct types', () => {
    writeAICallLogEntry(sample, logPath);
    const lines = readLines();
    expect(lines).toHaveLength(1);

    const rec = JSON.parse(lines[0]);
    expect(Object.keys(rec)).toEqual(SCHEMA_FIELDS); // insertion order == schema order
    expect(typeof rec.ID).toBe('number');
    expect(typeof rec.Datetime).toBe('string');
    expect(typeof rec.Model).toBe('string');
    expect(typeof rec.Backend).toBe('string');
    expect(typeof rec.KeySource).toBe('string');
    expect(rec.Model).toBe('gemini-3.7-flash');
    expect(rec.Backend).toBe('gemini');
    expect(rec.KeySource).toBe('store');
  });

  it('Model/Backend/KeySource default to \'\' when the caller omits them (back-compat with pre-t/4088 callers)', () => {
    const { scenario, promptId, promptStart, retryCount, status } = sample;
    writeAICallLogEntry({ scenario, promptId, promptStart, retryCount, status }, logPath);
    const rec = JSON.parse(readLines()[0]);
    expect(rec.Model).toBe('');
    expect(rec.Backend).toBe('');
    expect(rec.KeySource).toBe('');
  });

  it('Datetime is ISO-8601 UTC and round-trip parseable', () => {
    writeAICallLogEntry(sample, logPath);
    const { Datetime } = JSON.parse(readLines()[0]);
    expect(Datetime).toMatch(/Z$/);
    expect(Number.isNaN(Date.parse(Datetime))).toBe(false);
  });

  it('PromptStart is truncated to 160 chars', () => {
    writeAICallLogEntry({ ...sample, promptStart: 'x'.repeat(300) }, logPath);
    const { PromptStart } = JSON.parse(readLines()[0]);
    expect(PromptStart).toHaveLength(160);
  });

  it('ID is advisory-monotonic within the file (1,2,3), restarting at 1 on a fresh file', () => {
    writeAICallLogEntry(sample, logPath);
    writeAICallLogEntry(sample, logPath);
    writeAICallLogEntry(sample, logPath);
    expect(readLines().map(l => JSON.parse(l).ID)).toEqual([1, 2, 3]);
  });

  it('each line is an atomic-append candidate: sub-PIPE_BUF and newline-terminated', () => {
    writeAICallLogEntry({ ...sample, promptStart: 'y'.repeat(300) }, logPath); // largest realistic record
    writeAICallLogEntry(sample, logPath);
    const raw = fs.readFileSync(logPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    for (const line of raw.split('\n').filter(l => l.length > 0)) {
      expect(Buffer.byteLength(line + '\n', 'utf8')).toBeLessThan(4096); // PIPE_BUF floor
    }
  });

  it('an IO error is swallowed (fail-safe) — never throws', () => {
    const filePath = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    const badPath = path.join(filePath, 'nested', 'ai-call-log.jsonl');
    expect(() => writeAICallLogEntry(sample, badPath)).not.toThrow();
  });

  describe('KeySource: closed vocabulary (t/4088, TL t/4088#3)', () => {
    it.each([
      'explicit', 'fallback:AI_API_KEY', 'store', 'keyvault', 'none', '',
      'env:GEMINI_API_KEY', 'env:ANTHROPIC_API_KEY', 'env:GROQ_API_KEY',
    ])('%s is a valid KeySource — written through unchanged, no WARN', (keySource) => {
      writeAICallLogEntry({ ...sample, keySource }, logPath);
      expect(JSON.parse(readLines()[0]).KeySource).toBe(keySource);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it.each([
      'Explicit', // wrong case — vocabulary is case-sensitive
      'env:NOT_A_KEY_VAR', // not a known backend variable
      'x3Pa-explct-Nd6g', // a free-form value — exactly what the rule forbids
      'unknown-source',
    ])('an out-of-vocabulary value (%s) is written as \'\' with a WARN, never as free text', (keySource) => {
      writeAICallLogEntry({ ...sample, keySource }, logPath);
      const rec = JSON.parse(readLines()[0]);
      expect(rec.KeySource).toBe('');
      expect(mockRecord).toHaveBeenCalledTimes(1);
      expect(mockRecord.mock.calls[0][0]).toMatchObject({ level: 'warn' });
      // The invalid value itself must never reach the WARN payload either (t/4088#3: never free text).
      const warnPayload = JSON.stringify(mockRecord.mock.calls[0][0]);
      expect(warnPayload).not.toContain(keySource);
      // ...and it must never reach the file.
      expect(fs.readFileSync(logPath, 'utf8')).not.toContain(keySource);
    });
  });

  describe('conformance: tests/fixtures/ai-call-log/conformance.jsonl (t/4088)', () => {
    it('every writer fixture line parses and round-trips unchanged (same fields, same order, same values)', () => {
      const fixtures = loadWriterFixtureLines();
      expect(fixtures.length).toBe(9);

      for (const f of fixtures) {
        const fresh = path.join(tmpDir, `conf-${f.ID}.jsonl`);
        writeAICallLogEntry({
          scenario: f.Scenario as string,
          promptId: f.PromptID as string,
          promptStart: f.PromptStart as string,
          retryCount: f.RetryCount as number,
          status: f.Status as string,
          model: f.Model as string,
          backend: f.Backend as string,
          keySource: f.KeySource as string,
        }, fresh);
        const rec = JSON.parse(fs.readFileSync(fresh, 'utf8').trim());
        // ID and Datetime are minted (per the contract); every other field matches exactly.
        const { ID: _ignoredId, Datetime: _ignoredDt, ...expected } = f;
        const { ID: _mintedId, Datetime: _mintedDt, ...actual } = rec;
        expect(actual).toEqual(expected);
      }
    });
  });
});
