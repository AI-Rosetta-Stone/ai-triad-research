// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The Op-Ed reader's "How" panel (t/173): Raw Prompt and Raw Output per pipeline stage (t/171's
// member.stages), plus Methods links to the Op-Ed theory docs (t/174). Built on the shared How
// components so it reads the same as Chat's.

import type { OpEdStage } from '../../../../../lib/oped/types';
import { HowPanel, HowSection, HowRawContent, HowNote, HowMethodsLinks } from '../shared/HowPanel';
import type { HowMethodsLinkSpec } from '../shared/HowPanel';

const DOCS = 'https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main/docs/ux';
export const OPED_HOW_METHODS_LINKS: readonly HowMethodsLinkSpec[] = [
  { label: 'Theory of Success', url: `${DOCS}/oped-tool-theory-of-success.md` },
  { label: 'Theory of Operations', url: `${DOCS}/oped-tool-theory-of-operations.md` },
  { label: 'Theory of Outlets', url: `${DOCS}/oped-tool-theory-of-outlets.md` },
];

const STAGE_LABELS: Record<string, string> = {
  'source-brief': 'Source brief',
  generation: 'Generation',
  'coherence-judge': 'Coherence judge',
  'coherence-rewrite': 'Coherence rewrite',
  'coherence-rejudge': 'Coherence re-judge',
  'readability-edit': 'Readability edit',
  'grounding-reflection': 'Grounding reflection',
};

/** "Readability edit (attempt 2)". An unknown stage name is shown verbatim, never dropped (t/171#4). */
export function stageLabel(s: Pick<OpEdStage, 'stage' | 'attempt'>): string {
  const base = STAGE_LABELS[s.stage] ?? s.stage;
  return s.attempt > 1 ? `${base} (attempt ${s.attempt})` : base;
}

/** Generation first (the call the reader cares about), then the rest in pipeline order (t/173). */
export function orderStages(stages: readonly OpEdStage[]): OpEdStage[] {
  return [...stages.filter(s => s.stage === 'generation'), ...stages.filter(s => s.stage !== 'generation')];
}

function StageList({ stages, kind }: { stages: OpEdStage[]; kind: 'prompt' | 'output' }) {
  return (
    <>
      {stages.map((s, i) => {
        const label = `${stageLabel(s)} · ${s.model}`;
        const what = kind === 'prompt' ? 'Raw prompt' : 'Raw output';
        return (
          <HowSection key={`${s.stage}-${s.attempt}-${i}`} title={label} defaultExpanded={i === 0}>
            {kind === 'output' && s.error && <HowNote>This call failed: {s.error}</HowNote>}
            {!(kind === 'output' && s.error && !s.output) && (
              <HowRawContent
                value={kind === 'prompt' ? s.prompt : s.output}
                label={`${what}: ${stageLabel(s)}`}
                missingText={`${what} is empty for this stage.`}
              />
            )}
          </HowSection>
        );
      })}
    </>
  );
}

/** Collapsed by default, under Why. Op-eds generated before t/171 have no stages: say so. */
export function OpEdHowPanel({ stages }: { stages: readonly OpEdStage[] | undefined }) {
  const ordered = stages && stages.length > 0 ? orderStages(stages) : null;
  return (
    <HowPanel>
      {ordered ? (
        <>
          <HowSection title="Raw Prompt" defaultExpanded>
            <StageList stages={ordered} kind="prompt" />
          </HowSection>
          <HowSection title="Raw Output" defaultExpanded={false}>
            <StageList stages={ordered} kind="output" />
          </HowSection>
        </>
      ) : (
        <HowSection title="Raw Prompts and Outputs" defaultExpanded>
          <HowNote>Raw prompts and outputs are visible only to the op-ed's author.</HowNote>
        </HowSection>
      )}
      <HowSection title="Methods" defaultExpanded={false}>
        <HowMethodsLinks links={OPED_HOW_METHODS_LINKS} component="oped-how-panel" />
      </HowSection>
    </HowPanel>
  );
}
