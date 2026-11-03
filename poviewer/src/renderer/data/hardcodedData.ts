// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { Point, Source, Notebook } from '../types/types';
import { ActionableError } from '../../../../lib/debate/errors';

// The snapshot.md text (used to compute char offsets against)
// We embed the exact text here so the prototype works without IPC

export const SNAPSHOT_TEXT = `# Fellowship Proposal: Operationalizing the AI Triad
## From Dialog to Durable Policy Frameworks

> **Snapshot captured:** 2026-02-21
> **Source type:** DOCX (local)
> **Shadow file for AI summarization and POViewer display.**
> The original file is in raw/ for fidelity (charts, tables, exact formatting).

---

## I. The Problem: A Systems-Level Failure in Communication

The field of Artificial Intelligence is currently experiencing a systems-level failure in communication.
While the technology accelerates, the public and policy conversation has fractured into three siloed
communities, each with points to make but talking past one another.

- **Accelerationists** view AI as a revolutionary force for solving existential challenges.
- **Safetyists** warn of catastrophic, irreversible, potentially existential risks.
- **Skeptics** argue that future-gazing distracts from immediate dangerous harms.

All three are correct to a degree. However, because they operate from fundamentally different moral
premises, they lack a common language. We are attempting to build the most transformative technology
in history without a shared set of facts or a mechanism to align on its purpose.

## II. The Proposal: Building Conceptual Infrastructure

This project will develop the conceptual infrastructure necessary to sustain productive dialogue.

### Phase 1: Survey the Landscape
### Phase 2: Synthesize the Unified Framework
### Phase 3: Stress Test (Chaos Monkey Approach)
### Phase 4: The Definitive Standard (December 2026)

## III. Intended Outputs and Impact

Primary output: a living whitepaper titled 'Bridging the AI Triad: A Diagnostic Map for Risk,
Opportunity, and Conflict,' published as an open resource.

## IV. Institutional Alignment

This work requires a demilitarized zone for ideas. A neutral academic setting is uniquely positioned
to serve as this trusted forum.

## V. Unique Qualifications

Track record includes: Google SRE Risk Taxonomy, the paper 'Failure Modes in Machine Learning
Systems,' and the PowerShell/Monad Manifesto at Microsoft.`;

// Helper: find char offsets in SNAPSHOT_TEXT for a given substring
// These are pre-computed for deterministic MVP behavior
// (Using indexOf to verify during development, but the offsets are fixed)

function offset(needle: string): { start: number; end: number } {
  const idx = SNAPSHOT_TEXT.indexOf(needle);
  if (idx === -1) throw new ActionableError({
    goal: 'Compute character offset for hardcoded point in snapshot text',
    problem: `Offset not found for substring: "${needle.slice(0, 40)}..."`,
    location: 'hardcodedData.ts:offset',
    nextSteps: [
      'Verify that SNAPSHOT_TEXT has not been modified — the hardcoded points depend on exact text',
      'If the snapshot text changed, update the hardcoded point strings to match',
      'Consider regenerating points from the updated snapshot using the analysis pipeline',
    ],
  });
  return { start: idx, end: idx + needle.length };
}

// === 18 Hardcoded Points ===

const o1 = offset('The field of Artificial Intelligence is currently experiencing a systems-level failure in communication.');
const o2 = offset('**Accelerationists** view AI as a revolutionary force for solving existential challenges.');
const o3 = offset('**Safetyists** warn of catastrophic, irreversible, potentially existential risks.');
const o4 = offset('**Skeptics** argue that future-gazing distracts from immediate dangerous harms.');
const o5 = offset('All three are correct to a degree. However, because they operate from fundamentally different moral\npremises, they lack a common language.');
const o6 = offset('We are attempting to build the most transformative technology\nin history without a shared set of facts or a mechanism to align on its purpose.');
const o7 = offset('This project will develop the conceptual infrastructure necessary to sustain productive dialogue.');
const o8 = offset('Phase 1: Survey the Landscape');
const o9 = offset('Phase 3: Stress Test (Chaos Monkey Approach)');
const o10 = offset('Phase 4: The Definitive Standard (December 2026)');
const o11 = offset("Primary output: a living whitepaper titled 'Bridging the AI Triad: A Diagnostic Map for Risk,\nOpportunity, and Conflict,' published as an open resource.");
const o12 = offset('This work requires a demilitarized zone for ideas.');
const o13 = offset('A neutral academic setting is uniquely positioned\nto serve as this trusted forum.');
const o14 = offset('Google SRE Risk Taxonomy');
const o15 = offset('While the technology accelerates, the public and policy conversation has fractured into three siloed\ncommunities, each with points to make but talking past one another.');
const o16 = offset("the paper 'Failure Modes in Machine Learning\nSystems,'");
const o17 = offset('Phase 2: Synthesize the Unified Framework');
const o18 = offset('PowerShell/Monad Manifesto at Microsoft.');

export const HARDCODED_POINTS: Point[] = [
  // p-001: Systems-level failure claim -> multi-POV (all 3 camps engage)
  {
    id: 'p-001',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o1.start,
    endOffset: o1.end,
    text: SNAPSHOT_TEXT.slice(o1.start, o1.end),
    mappings: [
      {
        camp: 'accelerationist',
        nodeId: 'acc-desires-001',
        nodeLabel: 'Abundance through AI',
        category: 'Desires',
        alignment: 'agrees',
        strength: 'moderate',
        explanation: 'The communication failure is real and hinders progress toward AI-driven abundance.',
      },
      {
        camp: 'safetyist',
        nodeId: 'saf-desires-001',
        nodeLabel: 'Prevent catastrophic and existential AI outcomes',
        category: 'Desires',
        alignment: 'agrees',
        strength: 'strong',
        explanation: 'Fractured communication increases risk of misaligned deployment.',
      },
      {
        camp: 'skeptic',
        nodeId: 'skp-beliefs-003',
        nodeLabel: 'AGI risk framing distracts from present harms',
        category: 'Beliefs',
        alignment: 'agrees',
        strength: 'moderate',
        explanation: 'Skeptics agree communication has failed but see the framing itself as the problem.',
      },
    ],
    isCollision: false,
  },

  // p-002: Accelerationist view -> single-POV agrees
  {
    id: 'p-002',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o2.start,
    endOffset: o2.end,
    text: SNAPSHOT_TEXT.slice(o2.start, o2.end),
    mappings: [
      {
        camp: 'accelerationist',
        nodeId: 'acc-desires-001',
        nodeLabel: 'Abundance through AI',
        category: 'Desires',
        alignment: 'agrees',
        strength: 'strong',
        explanation: 'Directly states the accelerationist core thesis: AI as revolutionary force for existential challenges.',
      },
    ],
    isCollision: false,
  },

  // p-003: Safetyist view -> single-POV agrees
  {
    id: 'p-003',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o3.start,
    endOffset: o3.end,
    text: SNAPSHOT_TEXT.slice(o3.start, o3.end),
    mappings: [
      {
        camp: 'safetyist',
        nodeId: 'saf-desires-001',
        nodeLabel: 'Prevent catastrophic and existential AI outcomes',
        category: 'Desires',
        alignment: 'agrees',
        strength: 'strong',
        explanation: 'Directly characterizes the safetyist position on catastrophic/existential risk.',
      },
    ],
    isCollision: false,
  },

  // p-004: Skeptic view -> single-POV agrees
  {
    id: 'p-004',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o4.start,
    endOffset: o4.end,
    text: SNAPSHOT_TEXT.slice(o4.start, o4.end),
    mappings: [
      {
        camp: 'skeptic',
        nodeId: 'skp-beliefs-003',
        nodeLabel: 'AGI risk framing distracts from present harms',
        category: 'Beliefs',
        alignment: 'agrees',
        strength: 'strong',
        explanation: 'Directly articulates the skeptic position: future-gazing distracts from immediate harms.',
      },
    ],
    isCollision: false,
  },

  // p-005: "All three are correct" -> multi-POV (3 camps)
  {
    id: 'p-005',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o5.start,
    endOffset: o5.end,
    text: SNAPSHOT_TEXT.slice(o5.start, o5.end),
    mappings: [
      {
        camp: 'accelerationist',
        nodeId: 'acc-desires-003',
        nodeLabel: 'Democratize access to AI capability',
        category: 'Desires',
        alignment: 'agrees',
        strength: 'weak',
        explanation: 'Acknowledges accelerationist concerns are partially valid.',
      },
      {
        camp: 'safetyist',
        nodeId: 'saf-desires-003',
        nodeLabel: 'Solve the alignment problem before deployment',
        category: 'Desires',
        alignment: 'agrees',
        strength: 'weak',
        explanation: 'Acknowledges safetyist concerns are partially valid.',
      },
      {
        camp: 'skeptic',
        nodeId: 'skp-intentions-001',
        nodeLabel: 'Regulate based on present harms, not future speculation',
        category: 'Intentions',
        alignment: 'agrees',
        strength: 'weak',
        explanation: 'Acknowledges skeptic concerns are partially valid but frames the problem as lack of common language.',
      },
    ],
    isCollision: false,
  },

  // p-006: "without shared facts" -> multi-POV with contradiction
  {
    id: 'p-006',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o6.start,
    endOffset: o6.end,
    text: SNAPSHOT_TEXT.slice(o6.start, o6.end),
    mappings: [
      {
        camp: 'accelerationist',
        nodeId: 'acc-intentions-001',
        nodeLabel: 'Speed reduces risk (first-mover alignment advantage)',
        category: 'Intentions',
        alignment: 'agrees',
        strength: 'moderate',
        explanation: 'Supports the urgency of building while coordinating — a core accelerationist concern.',
      },
      {
        camp: 'safetyist',
        nodeId: 'saf-beliefs-001',
        nodeLabel: 'The alignment problem is unsolved',
        category: 'Beliefs',
        alignment: 'contradicts',
        strength: 'moderate',
        explanation: 'Implies the problem is communication, not alignment — safetyists disagree this is the bottleneck.',
      },
      {
        camp: 'skeptic',
        nodeId: 'skp-intentions-001',
        nodeLabel: 'Regulate based on present harms, not future speculation',
        category: 'Intentions',
        alignment: 'agrees',
        strength: 'moderate',
        explanation: 'Skeptics agree: shared facts about present harms are what is missing.',
      },
    ],
    isCollision: false,
  },

  // p-007: "conceptual infrastructure" -> single-POV (cross-cutting)
  {
    id: 'p-007',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o7.start,
    endOffset: o7.end,
    text: SNAPSHOT_TEXT.slice(o7.start, o7.end),
    mappings: [
      {
        camp: 'situations',
        nodeId: 'sit-003',
        nodeLabel: 'AI Governance and Regulation',
        category: 'Situations',
        alignment: 'agrees',
        strength: 'strong',
        explanation: 'The proposal itself is governance infrastructure — building shared conceptual ground.',
      },
    ],
    isCollision: false,
  },

  // p-008: "Survey the Landscape" -> single-POV agrees (acc)
  {
    id: 'p-008',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o8.start,
    endOffset: o8.end,
    text: SNAPSHOT_TEXT.slice(o8.start, o8.end),
    mappings: [
      {
        camp: 'accelerationist',
        nodeId: 'acc-beliefs-003',
        nodeLabel: 'AI is already producing measurable economic gains',
        category: 'Beliefs',
        alignment: 'agrees',
        strength: 'weak',
        explanation: 'Surveying the landscape includes documenting where AI is already creating value.',
      },
    ],
    isCollision: false,
  },

  // p-009: "Stress Test / Chaos Monkey" -> cross-cutting COLLISION
  {
    id: 'p-009',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o9.start,
    endOffset: o9.end,
    text: SNAPSHOT_TEXT.slice(o9.start, o9.end),
    mappings: [
      {
        camp: 'safetyist',
        nodeId: 'saf-intentions-003',
        nodeLabel: 'Technical-empiricist safety research program',
        category: 'Intentions',
        alignment: 'agrees',
        strength: 'moderate',
        explanation: 'Chaos monkey / stress testing resonates with the empirical safety research paradigm.',
      },
      {
        camp: 'accelerationist',
        nodeId: 'acc-intentions-001',
        nodeLabel: 'Speed reduces risk (first-mover alignment advantage)',
        category: 'Intentions',
        alignment: 'agrees',
        strength: 'weak',
        explanation: 'Rapid stress testing aligns with "move fast, test fast" methodology.',
      },
    ],
    isCollision: true,
    collisionNote: 'Both camps endorse "stress testing" but mean different things: safetyists mean adversarial robustness evaluation; accelerationists mean rapid iteration. The term creates false agreement.',
  },

  // p-010: "Definitive Standard" -> single-POV agrees (saf)
  {
    id: 'p-010',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o10.start,
    endOffset: o10.end,
    text: SNAPSHOT_TEXT.slice(o10.start, o10.end),
    mappings: [
      {
        camp: 'safetyist',
        nodeId: 'saf-desires-003',
        nodeLabel: 'Solve the alignment problem before deployment',
        category: 'Desires',
        alignment: 'agrees',
        strength: 'moderate',
        explanation: 'Establishing a definitive standard aligns with the call for solved alignment before deployment.',
      },
    ],
    isCollision: false,
  },

  // p-011: Living whitepaper -> single-POV agrees (acc)
  {
    id: 'p-011',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o11.start,
    endOffset: o11.end,
    text: SNAPSHOT_TEXT.slice(o11.start, o11.end),
    mappings: [
      {
        camp: 'accelerationist',
        nodeId: 'acc-desires-004',
        nodeLabel: 'AI as public research infrastructure',
        category: 'Desires',
        alignment: 'agrees',
        strength: 'strong',
        explanation: 'A living, open whitepaper is exactly the kind of public infrastructure accelerationists advocate.',
      },
    ],
    isCollision: false,
  },

  // p-012: "demilitarized zone" -> multi-POV (2 camps)
  {
    id: 'p-012',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o12.start,
    endOffset: o12.end,
    text: SNAPSHOT_TEXT.slice(o12.start, o12.end),
    mappings: [
      {
        camp: 'safetyist',
        nodeId: 'saf-desires-002',
        nodeLabel: 'Maintain meaningful human oversight of AI',
        category: 'Desires',
        alignment: 'agrees',
        strength: 'moderate',
        explanation: 'A neutral forum supports the safetyist goal of deliberative, human-led oversight.',
      },
      {
        camp: 'skeptic',
        nodeId: 'skp-intentions-002',
        nodeLabel: 'Mandate algorithmic audits and impact assessments',
        category: 'Intentions',
        alignment: 'agrees',
        strength: 'moderate',
        explanation: 'A neutral zone for evaluation aligns with the skeptic call for independent auditing.',
      },
    ],
    isCollision: false,
  },

  // p-013: "BKC uniquely positioned" -> cross-cutting COLLISION
  {
    id: 'p-013',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o13.start,
    endOffset: o13.end,
    text: SNAPSHOT_TEXT.slice(o13.start, o13.end),
    mappings: [
      {
        camp: 'accelerationist',
        nodeId: 'acc-intentions-002',
        nodeLabel: 'Open-source model weights enable safety scrutiny',
        category: 'Intentions',
        alignment: 'agrees',
        strength: 'weak',
        explanation: 'Accelerationists see BKC as supporting open, transparent research norms.',
      },
      {
        camp: 'skeptic',
        nodeId: 'skp-intentions-002',
        nodeLabel: 'Mandate algorithmic audits and impact assessments',
        category: 'Intentions',
        alignment: 'agrees',
        strength: 'moderate',
        explanation: 'Skeptics see BKC as an institution that could mandate accountability.',
      },
    ],
    isCollision: true,
    collisionNote: '"Trusted forum" means different things: accelerationists mean a place that validates rapid progress; skeptics mean a place that holds power accountable. The institutional framing conceals divergent expectations.',
  },

  // p-014: "Google SRE Risk Taxonomy" -> multi-POV (2 camps)
  {
    id: 'p-014',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o14.start,
    endOffset: o14.end,
    text: SNAPSHOT_TEXT.slice(o14.start, o14.end),
    mappings: [
      {
        camp: 'accelerationist',
        nodeId: 'acc-intentions-003',
        nodeLabel: 'Accuracy thresholds as sufficient deployment criteria',
        category: 'Intentions',
        alignment: 'agrees',
        strength: 'moderate',
        explanation: 'SRE risk taxonomy is an engineering approach — systems thinking from industry practice.',
      },
      {
        camp: 'safetyist',
        nodeId: 'saf-intentions-003',
        nodeLabel: 'Technical-empiricist safety research program',
        category: 'Intentions',
        alignment: 'agrees',
        strength: 'strong',
        explanation: 'SRE risk taxonomy exemplifies the empirical, technical approach to safety the safetyist camp values.',
      },
    ],
    isCollision: false,
  },

  // p-015: UNMAPPED - "fractured into siloed communities"
  {
    id: 'p-015',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o15.start,
    endOffset: o15.end,
    text: SNAPSHOT_TEXT.slice(o15.start, o15.end),
    mappings: [],
    isCollision: false,
  },

  // p-016: BKC paper reference -> single-POV agrees (saf)
  {
    id: 'p-016',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o16.start,
    endOffset: o16.end,
    text: SNAPSHOT_TEXT.slice(o16.start, o16.end),
    mappings: [
      {
        camp: 'safetyist',
        nodeId: 'saf-beliefs-004',
        nodeLabel: 'Reward misspecification as systematic failure mechanism',
        category: 'Beliefs',
        alignment: 'agrees',
        strength: 'strong',
        explanation: 'The "Failure Modes in ML Systems" paper directly addresses systematic failure mechanisms.',
      },
    ],
    isCollision: false,
  },

  // p-017: UNMAPPED - "Synthesize the Unified Framework"
  {
    id: 'p-017',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o17.start,
    endOffset: o17.end,
    text: SNAPSHOT_TEXT.slice(o17.start, o17.end),
    mappings: [],
    isCollision: false,
  },

  // p-018: PowerShell/Monad -> single-POV agrees (acc)
  {
    id: 'p-018',
    sourceId: 'example-2026-ai-triad-proposal',
    startOffset: o18.start,
    endOffset: o18.end,
    text: SNAPSHOT_TEXT.slice(o18.start, o18.end),
    mappings: [
      {
        camp: 'accelerationist',
        nodeId: 'acc-desires-003',
        nodeLabel: 'Democratize access to AI capability',
        category: 'Desires',
        alignment: 'agrees',
        strength: 'moderate',
        explanation: 'The Monad Manifesto exemplifies democratizing powerful tooling — a core accelerationist value.',
      },
    ],
    isCollision: false,
  },
];

// === Source ===
const exampleSource: Source = {
  id: 'example-2026-ai-triad-proposal',
  title: 'Fellowship Proposal: Operationalizing the AI Triad',
  url: null,
  sourceType: 'docx',
  status: 'analyzed',
  snapshotText: SNAPSHOT_TEXT,
  points: HARDCODED_POINTS,
};

// === Second source (pending, no points) for demo ===
const pendingSource: Source = {
  id: 'concrete-problems-ai-safety',
  title: 'Concrete Problems in AI Safety',
  url: 'https://arxiv.org/abs/1606.06565',
  sourceType: 'pdf',
  status: 'pending',
  snapshotText: '',
  points: [],
};

// === Two Notebooks ===
export const HARDCODED_NOTEBOOKS: Notebook[] = [
  {
    id: 'nb-001',
    name: 'AI Triad Research',
    sources: [exampleSource, pendingSource],
    taxonomyFiles: ['accelerationist', 'safetyist', 'skeptic', 'situations'],
  },
  {
    id: 'nb-002',
    name: 'Empty Notebook',
    sources: [],
    taxonomyFiles: ['accelerationist', 'safetyist', 'skeptic', 'situations'],
  },
];
