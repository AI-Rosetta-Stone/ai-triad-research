// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3917: one run per debate. The 09-30 dump (debate 78232a8a, TIGHT, cap 8) had two
// `runOpeningStatements` running concurrently in the pop-out, plus a third in the main
// window. Each fell into its own adaptive loop: 12 interleaved rounds and two syntheses.
// These tests drive the real store actions. Only the turn body (`_crossRespondLeased`) and
// synthesis are stubbed, so the lease wrapper on `crossRespond` and on
// `runOpeningStatements` is the code under test.
//
// The recorder is captured (not mocked away) because the AC is stated in dump terms:
// exactly one "Adaptive loop started", and a WARN naming both callers on a refused entry.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { recorded } = vi.hoisted(() => ({ recorded: [] as Array<Record<string, unknown>> }));

vi.mock('@lib/flight-recorder/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/flight-recorder/index')>();
  return {
    ...actual,
    getGlobalRecorder: () => ({ record: (e: Record<string, unknown>) => { recorded.push(e); }, setEventContext: () => {} }),
  };
});

// Harness FIRST so its hoisted vi.mock registrations run before the store imports.
import { makeSession, mockApi } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import { loadProvisionalWeights } from '@lib/debate/phaseTransitions';
import { runOpeningPipelineWithRepair, assembleOpeningPipelineResult } from '@lib/debate/turnPipeline';
import {
  __deliverRunLeaseMessageForTests,
  __setRunLeaseTimingForTests,
  isRunLeaseHeldLocally,
} from '../shared/debateRunLease';

type Store = ReturnType<typeof useDebateStore.getState>;

function entry(id: string, type: string, speaker: string) {
  return {
    id,
    timestamp: '2026-05-01T00:00:00.000Z',
    type,
    speaker,
    content: `${speaker} ${type} — a sufficiently long body of prose to clear the delivery-length guard.`,
    taxonomy_refs: [] as string[],
  };
}

/** A watch-only adaptive debate whose openings are already delivered, so a run goes
 *  straight from the (idempotent) openings pass into the adaptive loop. */
function seedAdaptiveDebate(maxTotalRounds: number): string {
  vi.mocked(loadProvisionalWeights).mockReturnValue({
    pacing_presets: { tight: { maxTotalRounds, argumentationExit: 0.62, concludingExit: 0.6 } },
  } as unknown as ReturnType<typeof loadProvisionalWeights>);
  const session = makeSession({
    phase: 'opening',
    active_povers: ['accelerationist', 'safetyist', 'skeptic'],
    adaptive_staging: { enabled: true, pacing: 'tight' },
    transcript: [
      entry('o1', 'opening', 'accelerationist'),
      entry('o2', 'opening', 'safetyist'),
      entry('o3', 'opening', 'skeptic'),
    ],
  });
  useDebateStore.setState({
    activeDebate: session as unknown as Store['activeDebate'],
    activeDebateId: session.id,
  });
  return session.id;
}

let turnCounter = 0;
/** One debater statement per turn, so the loop sees transcript growth. */
function appendStatement(): void {
  const d = useDebateStore.getState().activeDebate!;
  turnCounter++;
  useDebateStore.setState({ activeDebate: { ...d, transcript: [...d.transcript, entry(`s${turnCounter}`, 'statement', 'skeptic')] } as Store['activeDebate'] });
}

const messages = (m: string) => recorded.filter(e => e.message === m);
const loopEnds = () => recorded.filter(e => typeof e.message === 'string' && (e.message as string).startsWith('Adaptive loop ended'));
const floorOpenCount = () => (useDebateStore.getState().activeDebate?.transcript ?? [])
  .filter(e => e.type === 'system' && e.content.includes('floor is open')).length;

describe('debate run lease — single flight per debate (t/3917)', () => {
  beforeEach(() => {
    recorded.length = 0;
    turnCounter = 0;
  });

  it('two concurrent runOpeningStatements at entry → one openings pass, one loop, one synthesis (the dump shape)', async () => {
    seedAdaptiveDebate(3);
    let openGate!: () => void;
    const gate = new Promise<void>(r => { openGate = r; });
    const turn = vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => {
      await gate;
      appendStatement();
    });
    const synth = vi.spyOn(useDebateStore.getState(), 'requestSynthesis').mockResolvedValue(undefined);

    // Both started in the same tick, like the two presses 2.1 s apart that both got in
    // before `debateGenerating` was set.
    const first = useDebateStore.getState().runOpeningStatements('first');
    const second = useDebateStore.getState().runOpeningStatements('second');
    await second; // refused at entry, so it resolves without waiting on the gate
    openGate();
    await first;

    expect(messages('Adaptive loop started')).toHaveLength(1);
    expect(floorOpenCount()).toBe(1); // one openings pass completed, not two
    expect(turn).toHaveBeenCalledTimes(3); // the cap, not 2× the cap
    expect(synth).toHaveBeenCalledTimes(1);

    const blocked = messages('Adaptive loop re-entry blocked');
    expect(blocked).toHaveLength(1);
    const data = blocked[0].data as { holder: { caller: string; remote: boolean }; rejected: { caller: string } };
    expect(data.holder.caller).toBe('runOpeningStatements:first');
    expect(data.holder.remote).toBe(false);
    expect(data.rejected.caller).toBe('runOpeningStatements:second');
    expect(blocked[0].level).toBe('warn');

    // Condition 6: ownership is logged positively, once.
    const acquired = messages('Adaptive loop lease acquired');
    expect(acquired).toHaveLength(1);
    expect((acquired[0].data as { caller: string }).caller).toBe('runOpeningStatements:first');
  });

  it('control: a single run proceeds as before and releases the lease, so a later run starts normally', async () => {
    const debateId = seedAdaptiveDebate(2);
    vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => { appendStatement(); });
    vi.spyOn(useDebateStore.getState(), 'requestSynthesis').mockResolvedValue(undefined);

    await useDebateStore.getState().runOpeningStatements('only');

    expect(messages('Adaptive loop started')).toHaveLength(1);
    expect(messages('Adaptive loop re-entry blocked')).toHaveLength(0);
    expect(useDebateStore.getState().debateError ?? '').not.toContain('already running');
    expect(isRunLeaseHeldLocally(debateId)).toBe(false);

    await useDebateStore.getState().runOpeningStatements('again');
    expect(messages('Adaptive loop started')).toHaveLength(2);
    expect(messages('Adaptive loop re-entry blocked')).toHaveLength(0);
  });

  it('the lease is released even when a turn throws', async () => {
    const debateId = seedAdaptiveDebate(3);
    vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockRejectedValue(new Error('boom'));

    await useDebateStore.getState().runOpeningStatements('throws');

    expect(loopEnds().map(e => e.message)).toEqual(['Adaptive loop ended: crossRespond_error']);
    expect(isRunLeaseHeldLocally(debateId)).toBe(false);
  });

  it('condition 3: a manual Cross-respond between the loop\'s rounds is refused, not interleaved', async () => {
    seedAdaptiveDebate(2);
    let openGate!: () => void;
    const gate = new Promise<void>(r => { openGate = r; });
    const turn = vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => {
      await gate;
      appendStatement();
    });
    vi.spyOn(useDebateStore.getState(), 'requestSynthesis').mockResolvedValue(undefined);

    const run = useDebateStore.getState().runOpeningStatements('loop-owner');
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1)); // parked inside round 1

    await useDebateStore.getState().crossRespond({ caller: 'manual-click' });
    expect(turn).toHaveBeenCalledTimes(1); // the click ran no turn of its own
    const blocked = messages('Adaptive loop re-entry blocked');
    expect(blocked).toHaveLength(1);
    expect((blocked[0].data as { rejected: { caller: string } }).rejected.caller).toBe('crossRespond:manual-click');
    expect(useDebateStore.getState().debateError).toBe('This debate is already running.');

    openGate();
    await run;
    expect(turn).toHaveBeenCalledTimes(2); // exactly the loop's cap
  });

  it('a superseding run (model-switch retry) invalidates the old run, whose loop exits lease_lost', async () => {
    seedAdaptiveDebate(2);
    let openFirstGate!: () => void;
    const firstGate = new Promise<void>(r => { openFirstGate = r; });
    let calls = 0;
    const turn = vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => {
      calls++;
      if (calls === 1) await firstGate; // the old run parks in its first round
      appendStatement();
    });
    vi.spyOn(useDebateStore.getState(), 'requestSynthesis').mockResolvedValue(undefined);

    const oldRun = useDebateStore.getState().runOpeningStatements('old');
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1));
    await useDebateStore.getState().runOpeningStatements('briefTimeout.retryWithModel', { supersedeLocal: true });
    openFirstGate();
    await oldRun;

    expect(messages('Adaptive loop lease superseded by this window')).toHaveLength(1);
    expect(messages('Adaptive loop re-entry blocked')).toHaveLength(0);
    // New run: 2 turns (its cap). Old run: its parked turn, then lease_lost before a second.
    expect(turn).toHaveBeenCalledTimes(3);
    expect(loopEnds().map(e => e.message)).toContain('Adaptive loop ended: lease_lost');
  });
});

describe('debate run lease — the run owns compression (t/3917 live run 2)', () => {
  beforeEach(() => {
    recorded.length = 0;
    turnCounter = 0;
  });

  it('the lease holder compresses between rounds once compression is due, without any UI mounted', async () => {
    seedAdaptiveDebate(2);
    // 3 openings + 12 earlier statements = 15; the first turn makes it 16, which is due.
    const d = useDebateStore.getState().activeDebate!;
    useDebateStore.setState({ activeDebate: { ...d, transcript: [...d.transcript, ...Array.from({ length: 12 }, (_, i) => entry(`old${i}`, 'statement', 'safetyist'))] } as Store['activeDebate'] });
    vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => { appendStatement(); });
    vi.spyOn(useDebateStore.getState(), 'requestSynthesis').mockResolvedValue(undefined);
    const compress = vi.spyOn(useDebateStore.getState(), 'compressOldTranscript').mockResolvedValue(undefined);

    await useDebateStore.getState().runOpeningStatements('compress-due');

    expect(compress).toHaveBeenCalled();
  });

  it('control: not yet due, so no compression', async () => {
    seedAdaptiveDebate(2); // 3 openings + 2 turns = 5 entries
    vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => { appendStatement(); });
    vi.spyOn(useDebateStore.getState(), 'requestSynthesis').mockResolvedValue(undefined);
    const compress = vi.spyOn(useDebateStore.getState(), 'compressOldTranscript').mockResolvedValue(undefined);

    await useDebateStore.getState().runOpeningStatements('compress-not-due');

    expect(compress).not.toHaveBeenCalled();
  });
});

describe('debate run lease — superseded openings run (t/3917#4 code condition)', () => {
  beforeEach(() => {
    recorded.length = 0;
  });

  it('a run superseded mid-openings delivers nothing more: each opening lands exactly once', async () => {
    const LONG = 'This is a sufficiently long opening statement that clears the 50-character minimum guard.';
    const session = makeSession({ phase: 'opening', active_povers: ['accelerationist', 'safetyist'] });
    useDebateStore.setState({
      activeDebate: session as unknown as Store['activeDebate'],
      activeDebateId: session.id,
      initialCrossRespondRounds: 0, // openings only; the loop is covered above
      openingOrder: ['accelerationist', 'safetyist'],
    } as unknown as Partial<Store>);
    vi.mocked(assembleOpeningPipelineResult).mockReturnValue({ statement: LONG, taxonomyRefs: [], meta: { policy_refs: [] } } as never);

    // Call 1 is the OLD run's first speaker: it parks until the replacement has finished.
    let openOldGate!: () => void;
    const oldGate = new Promise<void>(r => { openOldGate = r; });
    let pipelineCalls = 0;
    vi.mocked(runOpeningPipelineWithRepair).mockImplementation(async () => {
      pipelineCalls++;
      if (pipelineCalls === 1) await oldGate;
      return { stage_diagnostics: [], total_time_ms: 1, draft: {}, topicAlignmentResult: null, qualityGateResult: null } as never;
    });

    const oldRun = useDebateStore.getState().runOpeningStatements('old');
    await vi.waitFor(() => expect(pipelineCalls).toBe(1));

    // Supersede the way retryWithModel does (it clears debateGenerating, which the old run
    // set), but WITHOUT aborting the old controller, so only the lease can stop the old run.
    // retryWithModel also aborts; this isolates the lease check.
    useDebateStore.setState({ debateGenerating: null });
    await useDebateStore.getState().runOpeningStatements('briefTimeout.retryWithModel', { supersedeLocal: true });
    openOldGate();
    await oldRun;

    const delivered = (useDebateStore.getState().activeDebate?.transcript ?? [])
      .filter(e => e.type === 'opening' && !!e.content && e.content.trim().length > 0);
    // The dump-shaped signals, asserted first. Without the lease check the old run re-delivers
    // into the SAME slot (slot-first reuses it, so the transcript alone shows one entry), then
    // completes the openings phase a second time and enters a second loop.
    expect(messages('Opening delivered for Accelerationist')).toHaveLength(1);
    expect(messages('Opening delivered for Safetyist')).toHaveLength(1);
    expect(floorOpenCount()).toBe(1);
    expect(messages('Resolved adaptive config at debate start')).toHaveLength(1);

    expect(delivered.filter(e => e.speaker === 'accelerationist')).toHaveLength(1);
    expect(delivered.filter(e => e.speaker === 'safetyist')).toHaveLength(1);
    expect(pipelineCalls).toBe(3); // old: acc (parked, then bails); new: acc + saf
    expect(messages('runOpeningStatements aborted post-pipeline')).toHaveLength(1);
  });
});

describe('debate run lease — another window owns the debate (t/3917)', () => {
  beforeEach(() => {
    recorded.length = 0;
    turnCounter = 0;
  });

  it('refuses a local run while a remote window holds the lease, and allows it after the remote release', async () => {
    const debateId = seedAdaptiveDebate(1);
    const turn = vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => { appendStatement(); });
    vi.spyOn(useDebateStore.getState(), 'requestSynthesis').mockResolvedValue(undefined);

    __deliverRunLeaseMessageForTests({ type: 'beat', debateId, windowId: 'main-window', caller: 'runOpeningStatements:enterClarificationOrBegin', startedAt: 1 });

    await useDebateStore.getState().runOpeningStatements('OpeningPanel.resume');
    expect(turn).not.toHaveBeenCalled();
    expect(messages('Adaptive loop started')).toHaveLength(0);
    expect(useDebateStore.getState().debateError).toBe('This debate is already running in another window.');
    const blocked = messages('Adaptive loop re-entry blocked');
    expect(blocked).toHaveLength(1);
    const data = blocked[0].data as { holder: { window: string; caller: string; remote: boolean }; rejected: { caller: string } };
    expect(data.holder).toMatchObject({ window: 'main-window', caller: 'runOpeningStatements:enterClarificationOrBegin', remote: true });
    expect(data.rejected.caller).toBe('runOpeningStatements:OpeningPanel.resume');

    __deliverRunLeaseMessageForTests({ type: 'release', debateId, windowId: 'main-window' });
    await useDebateStore.getState().runOpeningStatements('OpeningPanel.resume');
    expect(messages('Adaptive loop started')).toHaveLength(1);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it('condition 2: a holder that stops heartbeating expires, and the takeover WARN names it', async () => {
    const debateId = seedAdaptiveDebate(1);
    vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => { appendStatement(); });
    vi.spyOn(useDebateStore.getState(), 'requestSynthesis').mockResolvedValue(undefined);
    __setRunLeaseTimingForTests({ ttlMs: 20 });

    // Pin the clock and advance it explicitly rather than sleeping a real 40ms (t/4460): a real
    // sleep only advances Date.now() when the ambient clock is unpinned, and the weekly
    // future-clock run (t/4279) already fakes Date here with no real-time ticking, so the sleep
    // elapsed nothing and the expiry never fired at +365 days.
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(start);
      __deliverRunLeaseMessageForTests({ type: 'beat', debateId, windowId: 'crashed-window', caller: 'runOpeningStatements:x', startedAt: 1 });
      vi.setSystemTime(start + 40); // no further beats: the holder is gone

      await useDebateStore.getState().runOpeningStatements('after-crash');

      expect(messages('Adaptive loop lease expired — holder stopped heartbeating')).toHaveLength(1);
      const takeover = messages('Adaptive loop lease taken over from unresponsive holder');
      expect(takeover).toHaveLength(1);
      expect(takeover[0].level).toBe('warn');
      expect((takeover[0].data as { dead_holder: { window: string } }).dead_holder.window).toBe('crashed-window');
      expect(messages('Adaptive loop started')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a live holder (beat inside the TTL) is NOT expired', async () => {
    const debateId = seedAdaptiveDebate(1);
    const turn = vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => { appendStatement(); });
    __setRunLeaseTimingForTests({ ttlMs: 1_000 });

    __deliverRunLeaseMessageForTests({ type: 'beat', debateId, windowId: 'busy-window', caller: 'runOpeningStatements:x', startedAt: 1 });
    await useDebateStore.getState().runOpeningStatements('impatient');

    expect(turn).not.toHaveBeenCalled();
    expect(messages('Adaptive loop lease expired — holder stopped heartbeating')).toHaveLength(0);
  });

  it('a viewer window does not save over the holder\'s file (logged once)', async () => {
    const debateId = seedAdaptiveDebate(1);
    __deliverRunLeaseMessageForTests({ type: 'beat', debateId, windowId: 'main-window', caller: 'runOpeningStatements:x', startedAt: 1 });

    await useDebateStore.getState().saveDebate('auto-save');
    await useDebateStore.getState().saveDebate('DebateWorkspace:autoSave');
    await useDebateStore.getState().saveDebate('compressOldTranscript'); // background: the live run's false-notice case

    expect(mockApi.saveDebateSession).not.toHaveBeenCalled();
    expect(messages('Save skipped — another window holds this debate\'s run lease (viewer)')).toHaveLength(1);
    expect(useDebateStore.getState().debateError ?? null).toBeNull(); // background saves skip quietly

    // A user edit in the viewer is not silently dropped: the user is told (TL t/3917#4 q.3).
    await useDebateStore.getState().saveDebate('togglePover');
    expect(mockApi.saveDebateSession).not.toHaveBeenCalled();
    expect(useDebateStore.getState().debateError).toContain('running in another window');
    const skips = messages('Save skipped — another window holds this debate\'s run lease (viewer)');
    expect(skips).toHaveLength(2);
    expect((skips[1].data as { user_edit: boolean }).user_edit).toBe(true);
    useDebateStore.setState({ debateError: null });

    __deliverRunLeaseMessageForTests({ type: 'release', debateId, windowId: 'main-window' });
    await useDebateStore.getState().saveDebate('auto-save');
    expect(mockApi.saveDebateSession).toHaveBeenCalledTimes(1);
  });
});
