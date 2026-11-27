// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/809 (spec §12, human decision 2026-11-27): the synthesis panel sits at the top of the debate
// page, under the header and toolbar, only once a synthesis exists (nothing reserved before). The
// concluding entry stays in the transcript as a one-line pointer row. Behind the short-lived
// `synthesisV2` switch (default OFF), removed one train after the human signs off.

import { useCallback, useMemo, useState } from 'react';
import type { TranscriptEntry } from '../../types/debate';
import { buildSynthesisView, type SynthesisView } from './synthesisView';
import { synthesisFindOffsets } from './synthesisFind';
import { isSynthesisV2On, readCollapsed, writeCollapsed } from './synthesisStorage';
import { SynthesisPanelView, type PanelFind } from './SynthesisPanel';

const TOP_ID = 'synthesis-v2-top';

interface DebateLike {
  id: string;
  active_povers?: readonly string[];
  topic?: { final?: string };
  transcript: readonly TranscriptEntry[];
}

export interface SynthesisTopData { entry: TranscriptEntry; view: SynthesisView }

/** The structured synthesis of a debate that has concluded, when the switch is on. Null otherwise
 *  (a running or failed synthesis reserves nothing). */
export function useSynthesisTop(debate: DebateLike | null | undefined): SynthesisTopData | null {
  const entry = debate && isSynthesisV2On() ? findSynthesisEntry(debate.transcript) : null;
  const synthesis = entry?.metadata?.synthesis;
  const povers = debate?.active_povers?.join('|') ?? '';
  const topic = debate?.topic?.final;
  return useMemo(
    () => (entry && synthesis
      ? { entry, view: buildSynthesisView({ synthesis, debaters: povers ? povers.split('|') : [], topic }) }
      : null),
    // `entry` changes identity only when the transcript entry does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [synthesis, povers, topic],
  );
}

export function findSynthesisEntry(transcript: readonly TranscriptEntry[]): TranscriptEntry | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.type === 'concluding' && e.metadata && typeof e.metadata.synthesis === 'object' && e.metadata.synthesis !== null) return e;
  }
  return null;
}

/** Find matches in the panel come first (it sits above the transcript). */
export function panelFindOffsets(top: SynthesisTopData | null, query: string): { total: number; offsets: Map<string, number> } {
  return top ? synthesisFindOffsets(top.view, query) : { total: 0, offsets: new Map() };
}

function skipToTranscript(): void {
  const first = document.querySelector<HTMLElement>('.debate-transcript-column [id^="debate-entry-"]');
  if (!first) return;
  first.tabIndex = -1;
  first.scrollIntoView({ block: 'start' });
  first.focus({ preventScroll: true });
}

export function SynthesisTop({ top, debateId, findQuery, findCurrentIndex, onExport }: {
  top: SynthesisTopData; debateId: string; findQuery: string; findCurrentIndex: number;
  /** The page's export handler; "Export brief" exports the Markdown brief and is hidden without it. */
  onExport?: (format: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(debateId));
  const toggle = useCallback(() => {
    setCollapsed(c => { writeCollapsed(debateId, !c); return !c; });
  }, [debateId]);
  const { offsets } = useMemo(() => synthesisFindOffsets(top.view, findQuery), [top.view, findQuery]);
  const find: PanelFind | null = findQuery ? { query: findQuery, current: findCurrentIndex, offsets } : null;
  return (
    <div id={TOP_ID} tabIndex={-1} className="syn-top">
      <SynthesisPanelView
        view={top.view}
        debateId={debateId}
        find={find}
        collapsed={collapsed}
        onToggleCollapsed={toggle}
        onSkip={skipToTranscript}
        onExportBrief={onExport ? () => onExport('markdown') : undefined}
      />
    </div>
  );
}

/** The concluding entry's place in the transcript: one line, no repeated content (spec §12). */
export function SynthesisPointerRow() {
  const back = (e: React.MouseEvent): void => {
    e.preventDefault();
    const el = document.getElementById(TOP_ID);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
  };
  return (
    <div className="syn-pointer">
      <span>Synthesis · shown at the top of this page</span>
      <a href={`#${TOP_ID}`} className="syn-nav-link" onClick={back}>Back to top</a>
    </div>
  );
}
