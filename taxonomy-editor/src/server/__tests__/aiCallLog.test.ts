// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3245 — TS-originated AI Call Log writer. Verifies the SCHEMA CONTRACT (t/3245#3) the PS reader
// (Get-AICallLog) parses: 7 named fields, correct types, ISO-8601 Datetime, PromptStart≤160, plus the
// flag-off no-op, advisory monotonic ID, and the atomic single-line append (sub-PIPE_BUF, newline-terminated).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeAICallLogEntry, isAICallLogEnabled, classifyKeySource, getAICallLogPath, type AICallLogEntry } from '../ai/aiCallLog.js';

const SCHEMA_FIELDS = ['ID', 'Datetime', 'Scenario', 'PromptID', 'PromptStart', 'RetryCount', 'Status', 'Model', 'Backend', 'KeySource'];

const sample: AICallLogEntry = {
  scenario: 'Debate', promptId: 'usage.debate.turn', promptStart: 'Argue the accelerationist case',
  retryCount: 0, status: '200',
  model: 'gemini-3.7-flash', backend: 'gemini', keySource: 'env:GEMINI_API_KEY',
};

let tmpDir: string;
let logPath: string;
const priorFlag = process.env.AI_CALL_LOG_ENABLED;

function readLines(): string[] {
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.length > 0);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicalllog-'));
  logPath = path.join(tmpDir, 'ai-call-log.jsonl');
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

describe('t/4372 (t/4264) — getAICallLogPath arm-B: routes through getStateRoot(), not getDataRoot()', () => {
  const SAVED: Record<string, string | undefined> = {};
  const KEYS = ['AI_TRIAD_DATA_ROOT', 'AI_TRIAD_STATE_ROOT'];
  beforeEach(() => { for (const k of KEYS) SAVED[k] = process.env[k]; });
  afterEach(() => { for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

  it('defaults to getDataRoot() when AI_TRIAD_STATE_ROOT is unset (prod/local unchanged)', () => {
    process.env.AI_TRIAD_DATA_ROOT = tmpDir;
    delete process.env.AI_TRIAD_STATE_ROOT;
    expect(getAICallLogPath()).toBe(path.join(tmpDir, 'ai-call-log.jsonl'));
  });

  it('isolates to AI_TRIAD_STATE_ROOT when set — a staging deployment never appends to the data root (prod\'s share)', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicalllog-state-'));
    try {
      process.env.AI_TRIAD_DATA_ROOT = tmpDir;
      process.env.AI_TRIAD_STATE_ROOT = stateDir;
      const resolved = getAICallLogPath();
      expect(resolved).toBe(path.join(stateDir, 'ai-call-log.jsonl'));
      expect(resolved).not.toBe(path.join(tmpDir, 'ai-call-log.jsonl'));
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('writeAICallLogEntry', () => {
  it('flag off → no-op, writes nothing', () => {
    delete process.env.AI_CALL_LOG_ENABLED;
    writeAICallLogEntry(sample, logPath);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('flag on → one JSONL record with the 10 schema fields in order and correct types', () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    writeAICallLogEntry(sample, logPath);
    const lines = readLines();
    expect(lines).toHaveLength(1);

    const rec = JSON.parse(lines[0]);
    expect(Object.keys(rec)).toEqual(SCHEMA_FIELDS); // insertion order == schema order
    expect(typeof rec.ID).toBe('number');
    expect(typeof rec.Datetime).toBe('string');
    expect(typeof rec.Scenario).toBe('string');
    expect(typeof rec.PromptID).toBe('string');
    expect(typeof rec.PromptStart).toBe('string');
    expect(typeof rec.RetryCount).toBe('number');
    expect(typeof rec.Status).toBe('string');
    expect(typeof rec.Model).toBe('string');
    expect(typeof rec.Backend).toBe('string');
    expect(typeof rec.KeySource).toBe('string');
    expect(rec.Scenario).toBe('Debate');
    expect(rec.PromptID).toBe('usage.debate.turn');
    expect(rec.Status).toBe('200');
    expect(rec.Model).toBe('gemini-3.7-flash');
    expect(rec.Backend).toBe('gemini');
  });

  it('Datetime is ISO-8601 UTC and round-trip parseable (PS TryParse(RoundtripKind))', () => {
    process.env.AI_CALL_LOG_ENABLED = 'true';
    writeAICallLogEntry(sample, logPath);
    const { Datetime } = JSON.parse(readLines()[0]);
    expect(Datetime).toMatch(/Z$/);
    expect(Number.isNaN(Date.parse(Datetime))).toBe(false);
  });

  it('PromptStart is truncated to 160 chars', () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    writeAICallLogEntry({ ...sample, promptStart: 'x'.repeat(300) }, logPath);
    const { PromptStart } = JSON.parse(readLines()[0]);
    expect(PromptStart).toHaveLength(160);
  });

  it('ID is advisory-monotonic within the file (1,2,3), restarting at 1 on a fresh file', () => {
    process.env.AI_CALL_LOG_ENABLED = 'on';
    writeAICallLogEntry(sample, logPath);
    writeAICallLogEntry(sample, logPath);
    writeAICallLogEntry(sample, logPath);
    expect(readLines().map(l => JSON.parse(l).ID)).toEqual([1, 2, 3]);
  });

  it('each line is an atomic-append candidate: sub-PIPE_BUF and newline-terminated', () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    writeAICallLogEntry({ ...sample, promptStart: 'y'.repeat(300) }, logPath); // largest realistic record
    writeAICallLogEntry(sample, logPath);
    const raw = fs.readFileSync(logPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    for (const line of raw.split('\n').filter(l => l.length > 0)) {
      expect(Buffer.byteLength(line + '\n', 'utf8')).toBeLessThan(4096); // PIPE_BUF floor
    }
  });

  // t/3516 (CodeQL js/http-to-file-access #5741): the write IS request-derived (PromptStart), which is
  // the by-design audit feature — but it must be injection-safe. A crafted prompt carrying embedded
  // newlines + a forged JSON record must NOT forge a second JSONL line: JSON.stringify escapes the
  // control chars, so the whole record stays exactly one physical line. This is the regression proof
  // behind the alert dismissal.
  it('a prompt with embedded newlines/JSON cannot forge a second JSONL line (injection-safe)', () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    const malicious = 'safe\n{"ID":999,"Scenario":"FORGED","Status":"200"}\nmore';
    writeAICallLogEntry({ ...sample, promptStart: malicious }, logPath);
    // Exactly one physical line was written — the embedded newlines did not split the record.
    const lines = readLines();
    expect(lines).toHaveLength(1);
    // ...and it parses as a single record whose PromptStart round-trips the raw (escaped) string,
    // never a second record with the forged ID/Scenario.
    const rec = JSON.parse(lines[0]);
    expect(rec.PromptStart).toContain('\n'); // the newline survived as escaped data inside the field
    expect(rec.ID).toBe(1);
    expect(rec.Scenario).toBe(sample.scenario); // NOT 'FORGED'
  });

  it('an IO error is swallowed (fail-safe) — never throws', () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    // Point at a path whose parent is a FILE, so mkdir/open fails; the write must not throw.
    const filePath = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    const badPath = path.join(filePath, 'nested', 'ai-call-log.jsonl');
    expect(() => writeAICallLogEntry(sample, badPath)).not.toThrow();
  });
});

describe('t/4088 — Model/Backend/KeySource fields', () => {
  it('1. no key material in log — sentinel values do not appear in any written line', () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    const sentinels: Record<string, string> = {
      GEMINI_API_KEY: 'gSENTINEL_gemini_k7x9',
      ANTHROPIC_API_KEY: 'aSENTINEL_claude_m3z1',
      GROQ_API_KEY: 'rSENTINEL_groq_p5q8',
      AI_API_KEY: 'fSENTINEL_fallback_n2w4',
    };
    for (const [k, v] of Object.entries(sentinels)) process.env[k] = v;

    writeAICallLogEntry({ ...sample, keySource: 'env:GEMINI_API_KEY' }, logPath);
    writeAICallLogEntry({ ...sample, keySource: 'explicit', status: 'error' }, logPath);
    writeAICallLogEntry({ ...sample, model: 'gemini-3.7-flash', backend: 'gemini', keySource: 'fallback:AI_API_KEY', status: '200' }, logPath);

    const raw = fs.readFileSync(logPath, 'utf8');
    for (const sentinel of Object.values(sentinels)) {
      expect(raw).not.toContain(sentinel);
      expect(raw).not.toContain(sentinel.slice(0, 4));
      expect(raw).not.toContain(sentinel.slice(-4));
    }

    for (const k of Object.keys(sentinels)) delete process.env[k];
  });

  it('2. Backend comes from registry — a model whose id prefix suggests another backend logs the registry backend', () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    writeAICallLogEntry({ ...sample, model: 'openai-compatible-on-groq', backend: 'groq', keySource: 'env:GROQ_API_KEY', status: '200' }, logPath);
    const { Backend } = JSON.parse(readLines()[0]);
    expect(Backend).toBe('groq'); // registry value, not 'openai' prefix guess
  });

  it('3. Failover — 2 entries with different Model/Backend/KeySource', () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    writeAICallLogEntry({ ...sample, model: 'claude-opus-5', backend: 'claude', keySource: 'env:ANTHROPIC_API_KEY', status: '429' }, logPath);
    writeAICallLogEntry({ ...sample, model: 'groq-qwen-qwen3.6-27b', backend: 'groq', keySource: 'env:GROQ_API_KEY', retryCount: 0, status: '200' }, logPath);
    const lines = readLines();
    expect(lines).toHaveLength(2);
    const [link1, link2] = lines.map(l => JSON.parse(l));
    expect(link1.Model).toBe('claude-opus-5');
    expect(link1.Backend).toBe('claude');
    expect(link2.Model).toBe('groq-qwen-qwen3.6-27b');
    expect(link2.Backend).toBe('groq');
    expect(link1.KeySource).toBe('env:ANTHROPIC_API_KEY');
    expect(link2.KeySource).toBe('env:GROQ_API_KEY');
  });

  it('4. Vocabulary — out-of-vocabulary value (wrong case) is written as empty string', () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    writeAICallLogEntry({ ...sample, keySource: 'Explicit' }, logPath); // wrong case
    const { KeySource } = JSON.parse(readLines()[0]);
    expect(KeySource).toBe(''); // 'Explicit' ≠ 'explicit', normalized to ''
  });

  it('classifyKeySource — explicit key matching a backend env var → env:<VAR>', () => {
    const orig = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'my-gemini-key-xyz';
    expect(classifyKeySource('my-gemini-key-xyz', 'gemini')).toBe('env:GEMINI_API_KEY');
    if (orig === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = orig;
  });

  it('classifyKeySource — key matching AI_API_KEY for gemini → fallback:AI_API_KEY', () => {
    const origFallback = process.env.AI_API_KEY;
    const origGemini = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.AI_API_KEY = 'my-fallback-key-abc';
    expect(classifyKeySource('my-fallback-key-abc', 'gemini')).toBe('fallback:AI_API_KEY');
    if (origFallback === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = origFallback;
    if (origGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = origGemini;
  });

  it('classifyKeySource — unknown key → explicit', () => {
    expect(classifyKeySource('some-random-key-not-in-env', 'groq')).toBe('explicit');
  });

  it('classifyKeySource — empty key → empty string', () => {
    expect(classifyKeySource('', 'gemini')).toBe('');
  });
});

describe('t/4088 — conformance.jsonl round-trip', () => {
  it('all 9 writer lines parse and match the fixture (field order = 10-field contract)', () => {
    process.env.AI_CALL_LOG_ENABLED = '1';
    const fixturePath = path.join(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'ai-call-log', 'conformance.jsonl');
    const lines = fs.readFileSync(fixturePath, 'utf8').split('\n').filter(l => l.length > 0);
    const writerCases = lines.slice(0, 9).map(l => JSON.parse(l) as Record<string, unknown>);
    for (const fixture of writerCases) {
      const entry: AICallLogEntry = {
        scenario: fixture.Scenario as string,
        promptId: fixture.PromptID as string,
        promptStart: fixture.PromptStart as string,
        retryCount: fixture.RetryCount as number,
        status: fixture.Status as string,
        model: fixture.Model as string,
        backend: fixture.Backend as string,
        keySource: fixture.KeySource as string,
      };
      writeAICallLogEntry(entry, logPath);
    }
    const written = readLines();
    expect(written).toHaveLength(9);
    for (let i = 0; i < 9; i++) {
      const rec = JSON.parse(written[i]);
      const fix = writerCases[i];
      expect(Object.keys(rec)).toEqual(SCHEMA_FIELDS); // 10-field order
      expect(rec.Scenario).toBe(fix.Scenario);
      expect(rec.PromptID).toBe(fix.PromptID);
      expect(rec.Status).toBe(fix.Status);
      expect(rec.Model).toBe(fix.Model);
      expect(rec.Backend).toBe(fix.Backend);
      expect(rec.KeySource).toBe(fix.KeySource);
    }
  });

  it('legacy 7-field line (line 10) — absent new fields read as undefined, coerce to empty string', () => {
    const fixturePath = path.join(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'ai-call-log', 'conformance.jsonl');
    const lines = fs.readFileSync(fixturePath, 'utf8').split('\n').filter(l => l.length > 0);
    const legacy = JSON.parse(lines[9]);
    expect(legacy.Model).toBeUndefined();
    expect(legacy.Backend).toBeUndefined();
    expect(legacy.KeySource).toBeUndefined();
    expect(legacy.Model ?? '').toBe('');
    expect(legacy.Backend ?? '').toBe('');
    expect(legacy.KeySource ?? '').toBe('');
  });
});
