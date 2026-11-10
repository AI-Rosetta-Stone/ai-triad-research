// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Op-ed create/cancel/export IPC handlers (t/2575, t/2588, t/2611).
// Stage A: Get-OpEdSource PS shim hoisted once per create call (FromUrl path).
// Stage B: lib/oped generate.ts in-process core — parallel voice fan-out via AIAdapter.
// Partial-set contract: failed/cancelled members persisted; whole-set Markdown export.

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ActionableError, errorMessage } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { assertSafeId } from '../../../../lib/electron-shared/safeId.js';
import { fetchUrlForPromptBinary } from '../../../../lib/url-fetch/fetchUrlForPrompt.js';
import { PROJECT_ROOT, getDataRootPath } from '../fileIO.js';
import { saveOpEdSetTemp, finalizeOpEdSet, loadOpEdSet, deleteOpEdSet, listOpEdSets, saveOpEdSet } from '../opedIO.js';
import type { OpEdSet, OpEdMember, OpEdParams } from '../../../../lib/oped/types.js';
import type { PovKey } from '../../../../lib/oped/types.js';
import { generateOpEdSet } from '../../../../lib/oped/generate.js';
import type { GenerateOpEdRequest, OpEdGeneratorDeps } from '../../../../lib/oped/generate.js';
import { parseOpEdRequest } from '../../../../lib/oped/schemas.js';
import { makeElectronAIAdapter } from '../electronAIAdapter.js';
import { validateCreateOpEdPayload } from './opedValidation.js';
import { parseShimLine, decodeB64Fields, buildConvertStdin, parseShimError } from './opedShimTransport.js';

// Shared prompts dir: op-ed-*.prompt artifacts (relocated to lib/oped/prompts by t/2609).
const PROMPTS_DIR = path.join(PROJECT_ROOT, 'lib', 'oped', 'prompts');

// Stage-A: Node fetches bytes (bypasses PS/WAF fingerprint block — t/3306), PS converts only.
const PREP_SHIM_PATH = path.join(PROJECT_ROOT, 'taxonomy-editor', 'src', 'main', 'ps', 'invoke-get-oped-source.ps1');

// Read generation.opedVoiceTimeoutMs from {dataRoot}/admin/runtime-config.json on each run.
// Falls back to 360s — in-process generation matches the PS wall-clock for grounding + LLM.
function getVoiceTimeoutMs(): number {
  try {
    const cfgPath = path.join(getDataRootPath(), 'admin', 'runtime-config.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
    const g = raw.generation as Record<string, unknown> | undefined;
    const val = Number(g?.opedVoiceTimeoutMs);
    if (Number.isFinite(val) && val >= 60_000 && val <= 3_600_000) return val;
  } catch { /* telemetry — silent by design */ }
  return 360_000;
}

// ── Active run registry ───────────────────────────────────────────────────────

const activeOpEdRuns = new Map<string, AbortController>();

// ── IPC progress event shape ──────────────────────────────────────────────────

type OpEdStage = 'queued' | 'preparing-source' | 'fetching' | 'grounding' | 'generating' | 'finalizing' | 'complete' | 'failed' | 'cancelled';

interface OpEdProgressEvent {
  set_id: string;
  voice?: PovKey;  // absent for set-phase events (e.g. preparing-source, grounding)
  stage: OpEdStage;
  error?: string;
}

// Shim stdout line shapes + parse/decode transport live in ./opedShimTransport (pure, unit-tested).

// ── Stage-A: fetch bytes via Node (bypasses WAF fingerprint block — t/3306) ──

async function fetchOpEdSourceBytes(
  url: string,
  timeoutMs: number,
): Promise<{ tempPath: string; contentType: string }> {
  const result = await fetchUrlForPromptBinary(url, { timeoutMs });
  if (!result.ok) {
    const statusPart = result.status != null ? ` (HTTP ${result.status})` : '';
    let problem: string;
    let nextSteps: string[];
    if (result.reason === 'http-error' && result.status === 403) {
      problem = `Could not fetch "${url}": server returned HTTP 403 Forbidden`;
      nextSteps = [
        'The server blocked the request — the URL may restrict automated access',
        'Try a different publicly accessible URL for the same source',
        'Use the topic-based op-ed mode if the URL is behind a paywall or access control',
      ];
    } else if (result.reason === 'http-error') {
      problem = `Could not fetch "${url}": HTTP error${statusPart}`;
      nextSteps = [`The server returned an error — check the URL is correct and publicly accessible`];
    } else if (result.reason === 'timeout') {
      problem = `Could not fetch "${url}": request timed out`;
      nextSteps = ['The server did not respond in time — check the URL is accessible and try again'];
    } else if (result.reason === 'ssrf-blocked') {
      problem = `Could not fetch "${url}": the URL resolves to a private or restricted network address`;
      nextSteps = ['Use a publicly accessible URL'];
    } else if (result.reason === 'too-large') {
      problem = `Could not fetch "${url}": the response body exceeds the size limit`;
      nextSteps = ['Use a URL that points to a smaller document'];
    } else {
      problem = `Could not fetch "${url}": ${result.reason}`;
      nextSteps = ['Check the URL is correct and the page is publicly accessible'];
    }
    throw new ActionableError({
      goal: 'Fetch op-ed source material',
      problem,
      location: 'opedHandlers → fetchOpEdSourceBytes',
      nextSteps,
    });
  }
  // Write bytes to temp file for PS converter. Extension is advisory — PS dispatches on ContentType.
  const ext = result.contentType.includes('pdf') ? '.pdf' : result.contentType.includes('html') ? '.html' : '.bin';
  const tempPath = path.join(os.tmpdir(), `oped-source-${crypto.randomUUID()}${ext}`);
  fs.writeFileSync(tempPath, result.bytes);
  return { tempPath, contentType: result.contentType };
}

// ── Stage-A: convert-only PS runner (accepts pre-fetched content — t/3306/t/3307) ──

function runGetOpEdConvert(
  tempPath: string,
  contentType: string,
  signal: AbortSignal,
  sourceUrl?: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', PREP_SHIM_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let stderrBuf = '';

    function onAbort(): void {
      settle(() => { child.kill('SIGTERM'); reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); });
    }

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
      fn();
    }

    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });

    timeoutHandle = setTimeout(() => {
      settle(() => { child.kill('SIGTERM'); reject(new Error('Get-OpEdSource convert timed out')); });
    }, getVoiceTimeoutMs());

    // Contract: { ContentPath, ContentType, SourceUrl? } (t/3306/t/3307 locked interface).
    child.stdin.write(buildConvertStdin(tempPath, contentType, sourceUrl), 'utf-8');
    child.stdin.end();

    let stdoutBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = parseShimLine(trimmed);
        } catch (err) {
          // A result-looking line that fails to parse is a hard serialization failure — record it
          // and surface it, never swallow into the opaque close-handler (t/2928).
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'opedHandlers', level: 'error',
            message: 'Get-OpEdSource emitted an unparseable result line',
            error: { name: (err as Error).name ?? 'Error', message: String((err as Error).message ?? err), stack: (err as Error).stack },
          });
          settle(() => reject(err));
          return;
        }
        if (msg && msg.type === 'result') {
          settle(() => resolve(decodeB64Fields(msg.data ?? {})));
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderrBuf += text;
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'opedHandlers', level: 'warn',
        message: `Get-OpEdSource stderr: ${text.slice(0, 500)}`,
      });
    });

    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code) => settle(() => {
      if (code !== 0) {
        // Parse structured ActionableError from stderr (t/3307 shim emits JSON on failure).
        const parsed = parseShimError(stderrBuf.trim().split('\n').pop() ?? '');
        if (parsed?.Problem) {
          reject(new ActionableError({
            goal: parsed.Goal ?? 'Convert op-ed source',
            problem: parsed.Problem,
            location: 'Get-OpEdSource.ps1',
            nextSteps: Array.isArray(parsed.NextSteps) ? parsed.NextSteps as string[] : [],
          }));
        } else {
          reject(new ActionableError({
            goal: 'Convert op-ed source',
            problem: `Get-OpEdSource exited with code ${code}${stderrBuf.trim() ? `: ${stderrBuf.trim().slice(0, 300)}` : ''}`,
            location: 'opedHandlers → runGetOpEdConvert',
            nextSteps: ['Check the server logs for Get-OpEdSource stderr output'],
          }));
        }
      } else {
        reject(new ActionableError({
          goal: 'Convert op-ed source',
          problem: 'No result received from Get-OpEdSource',
          location: 'opedHandlers → runGetOpEdConvert',
          nextSteps: ['Check the server logs for unexpected Get-OpEdSource output'],
        }));
      }
    }));
  });
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function renderOpEdSetMarkdown(set: OpEdSet): string {
  const lines: string[] = [
    `# Op-Ed Studies Set: ${set.topic}`,
    '',
    `*Generated: ${set.created_at}*`,
    '',
  ];
  for (const member of set.opeds) {
    if (member.status !== 'complete') {
      lines.push(`## ${member.pov} — ${member.status}`, '');
      continue;
    }
    lines.push(`## ${member.pov}`, '', `### ${member.headline}`);
    if (member.subtitle) lines.push('', `*${member.subtitle}*`);
    if (member.byline) lines.push('', `_${member.byline}_`);
    if (member.disclosure) lines.push('', `> ${member.disclosure}`);
    lines.push('', member.body);
    if (member.rhetorical_meta) lines.push('', '### What this op-ed did', '', member.rhetorical_meta);
    if (member.grounding?.length) {
      lines.push('', '**Grounding:**', '');
      for (const g of member.grounding) {
        lines.push(`- ${g.label} (${g.pov}): ${g.how_reflected}`);
      }
    }
    lines.push('', '---', '');
  }
  return lines.join('\n');
}

// ── Handler registration ──────────────────────────────────────────────────────

export function registerOpEdHandlers(): void {
  ipcMain.handle('create-oped-set', async (event, payload: {
    topic: string;
    url?: string;   // if provided, Get-OpEdSource is hoisted once (Stage A) before generation
    documentSource?: { text: string; name: string };  // t/275: desktop document upload path
    params: OpEdParams;
    voices: PovKey[];
  }) => {
    const { topic, url, documentSource, params, voices } = payload;

    // A create needs a source (topic OR url OR documentSource — FromUrl sends an empty topic) plus a voice.
    // Guard extracted to a pure, unit-tested validator (t/2910; regression fixed in t/2908; t/275 extended).
    const validationError = validateCreateOpEdPayload({ topic, url, documentSource, voices });
    if (validationError) throw validationError;
    // t/3994: reject an unknown/unregistered tag before Stage A fetch work starts, rather than
    // failing partway through generation (parseOpEdRequest throws ActionableError on its own).
    parseOpEdRequest({ povs: voices, params });

    const setId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const controller = new AbortController();
    activeOpEdRuns.set(setId, controller);

    const send = (data: OpEdProgressEvent): void => {
      if (!event.sender.isDestroyed()) event.sender.send('oped-progress', data);
    };

    // Stage A: Node fetches bytes → temp file → PS convert-only (t/3306), OR document source (t/275).
    // Fail fast if source prep fails — don't fan out to draft on garbage.
    let sourceBrief: string | undefined;
    let sourceName: string | undefined;
    if (documentSource) {
      // t/275: Document source path — skip PS conversion, use extracted text directly
      send({ set_id: setId, stage: 'preparing-source' });
      sourceBrief = documentSource.text;
      sourceName = documentSource.name;
    } else if (url) {
      send({ set_id: setId, stage: 'preparing-source' });
      let tempPath: string | undefined;
      try {
        const fetched = await fetchOpEdSourceBytes(url, getVoiceTimeoutMs());
        tempPath = fetched.tempPath;
        try {
          const sourcePrep = await runGetOpEdConvert(fetched.tempPath, fetched.contentType, controller.signal, url);
          // Extract markdown text for the lib/oped sourceMaterial slot ({{SOURCE_MATERIAL}}).
          sourceBrief = sourcePrep.SourceMarkdown != null ? String(sourcePrep.SourceMarkdown) : undefined;
        } finally {
          if (tempPath) fs.rmSync(tempPath, { force: true });
        }
      } catch (err) {
        activeOpEdRuns.delete(setId);
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'opedHandlers', level: 'error',
          message: `Stage A source prep failed for set ${setId}: ${(err as Error).message}`,
          error: { name: (err as Error).name ?? 'Error', message: String((err as Error).message ?? err), stack: (err as Error).stack },
        });
        // Surface the ActionableError directly — fetch/convert already set correct goal/problem/nextSteps.
        if (err instanceof ActionableError) throw err;
        throw new ActionableError({
          goal: 'Prepare source material for op-ed set',
          problem: err instanceof ActionableError ? err.problem : errorMessage(err),
          location: 'opedHandlers create-oped-set Stage A',
          nextSteps: ['Check that the URL is publicly accessible'],
          innerError: err,
        });
      }
    }

    // Source provenance (t/2897/t/2899 + t/275): source mode can be topic, url, or document.
    // Mirror the lib's own `request.sourceMaterial ? 'url'/'document':'topic'` test so the
    // handler-built temp/partial literals below never disagree with the lib's authoritative
    // `complete` set.
    const isUrlMode = Boolean(sourceBrief && url);
    const isDocumentMode = Boolean(sourceBrief && documentSource);
    // key_claims count from the comprehension pass, captured in-stream (url mode only).
    let sourceKeyClaimsCount: number | undefined;
    // Provenance for the handler-built literals (temp-save + abort partial-finalize). The
    // lib writes these itself on the `complete` set; these two paths bypass the lib, so they
    // carry provenance explicitly. Read at call time — the count is captured mid-stream.
    // Topic mode omits url/source_name + count entirely (absent, not 0) per the t/2898 contract.
    const provenanceFields = (): {
      source_mode: 'topic' | 'url' | 'document'; source_url?: string; source_name?: string; source_key_claims_count?: number;
    } => ({
      source_mode: isUrlMode ? 'url' : isDocumentMode ? 'document' : 'topic',
      ...(isUrlMode && url ? { source_url: url } : {}),
      ...(isDocumentMode && sourceName ? { source_name: sourceName } : {}),
      ...(isUrlMode ? { source_key_claims_count: sourceKeyClaimsCount ?? 0 } : {}),
    });

    // Fire queued for each voice — renderer stores set_id for cancellation
    for (const voice of voices) {
      send({ set_id: setId, voice, stage: 'queued' });
    }

    const request: GenerateOpEdRequest = {
      set_id: setId,
      topic,
      params,
      povs: voices,
      sourceMaterial: sourceBrief,
      sourceUrl: url,   // persisted as OpEdSet.source_url by the lib on the `complete` set (url mode)
      ...(sourceName ? { sourceName } : {}),  // t/275: persisted as OpEdSet.source_name (document mode)
      signal: controller.signal,
    };

    const deps: OpEdGeneratorDeps = {
      adapter: makeElectronAIAdapter('OpEd Generation', getVoiceTimeoutMs()),
      promptsDir: PROMPTS_DIR,
      repoRoot: PROJECT_ROOT,
    };

    const completedMembers: OpEdMember[] = [];
    let finalized = false;

    try {
      for await (const evt of generateOpEdSet(request, deps)) {
        switch (evt.type) {
          case 'source_brief_done':
            // url mode only — capture for the handler-built temp/partial literals below.
            sourceKeyClaimsCount = evt.keyClaimsCount;
            break;
          case 'grounding_done':
            send({ set_id: setId, stage: 'grounding' });
            break;
          case 'grounding_failed':
            getGlobalRecorder()?.record({
              type: 'system.error', component: 'opedHandlers', level: 'warn',
              message: `Grounding failed for set ${setId}: ${evt.error} — continuing voice-only`,
            });
            break;
          case 'voice_start':
            send({ set_id: setId, voice: evt.pov, stage: 'generating' });
            break;
          case 'voice_complete': {
            completedMembers.push(evt.member);
            try {
              // t/275: type assertion for document mode pending t/273 OpEdSet.source_mode extension
              saveOpEdSetTemp({ schema_version: 1, set_id: setId, topic, params, created_at: createdAt, opeds: [...completedMembers], ...provenanceFields() } as OpEdSet);
            } catch { /* telemetry — silent by design; temp save is best-effort */ }
            send({ set_id: setId, voice: evt.pov, stage: 'complete' });
            getGlobalRecorder()?.record({
              type: 'system.info', component: 'opedHandlers', level: 'info',
              message: `Op-ed voice complete for set ${setId} pov=${evt.pov}: wordCount=${evt.member.wordCount} grounding=${evt.member.grounding.length}`,
            });
            break;
          }
          case 'voice_failed': {
            const failed: OpEdMember = { pov: evt.pov, status: 'failed', headline: '', subtitle: '', body: '', wordCount: 0, grounding: [], byline: '', disclosure: '', rhetorical_meta: '' };
            completedMembers.push(failed);
            getGlobalRecorder()?.record({
              type: 'system.error', component: 'opedHandlers', level: 'error',
              message: `Op-ed voice failed for set ${setId} pov=${evt.pov}: ${evt.error}`,
            });
            send({ set_id: setId, voice: evt.pov, stage: 'failed', error: evt.error });
            break;
          }
          case 'voice_cancelled': {
            const cancelled: OpEdMember = { pov: evt.pov, status: 'cancelled', headline: '', subtitle: '', body: '', wordCount: 0, grounding: [], byline: '', disclosure: '', rhetorical_meta: '' };
            completedMembers.push(cancelled);
            send({ set_id: setId, voice: evt.pov, stage: 'cancelled' });
            break;
          }
          case 'complete':
            finalizeOpEdSet(evt.set);
            finalized = true;
            break;
        }
      }
    } finally {
      activeOpEdRuns.delete(setId);
      // Abort before complete: persist partial set so completed voices aren't lost.
      if (!finalized && completedMembers.length > 0) {
        try {
          // t/275: type assertion for document mode pending t/273 OpEdSet.source_mode extension
          finalizeOpEdSet({ schema_version: 1, set_id: setId, topic, params, created_at: createdAt, opeds: completedMembers, ...provenanceFields() } as OpEdSet);
        } catch { /* telemetry — silent by design */ }
      }
    }

    return { set_id: setId };
  });

  ipcMain.handle('cancel-oped-set', (_event, setId: string) => {
    activeOpEdRuns.get(setId)?.abort();
  });

  ipcMain.handle('list-oped-sets', () => listOpEdSets());

  ipcMain.handle('load-oped-set', (_event, setId: string) => {
    assertSafeId(setId, 'oped set id');
    return loadOpEdSet(setId);
  });

  ipcMain.handle('delete-oped-set', (_event, setId: string) => {
    assertSafeId(setId, 'oped set id');
    deleteOpEdSet(setId);
  });

  ipcMain.handle('save-oped-set', (_event, set: OpEdSet) => {
    assertSafeId(set.set_id, 'oped set id');
    saveOpEdSet(set);
  });

  ipcMain.handle('export-oped-set', async (event, setId: string) => {
    assertSafeId(setId, 'oped set id');

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { cancelled: true };

    let set: OpEdSet;
    try {
      set = loadOpEdSet(setId);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'opedHandlers', level: 'error',
        message: `export-oped-set: set not found (${setId})`,
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      throw new ActionableError({
        goal: `Export op-ed set ${setId}`,
        problem: 'Op-ed set file not found',
        location: 'opedHandlers export-oped-set',
        nextSteps: ['Verify the set was created successfully before exporting'],
      });
    }

    const slug = set.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Op-Ed Study',
      defaultPath: `oped-${slug}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });

    if (result.canceled || !result.filePath) return { cancelled: true };

    fs.writeFileSync(result.filePath, renderOpEdSetMarkdown(set), 'utf-8');
    return { cancelled: false, filePath: result.filePath };
  });
}
