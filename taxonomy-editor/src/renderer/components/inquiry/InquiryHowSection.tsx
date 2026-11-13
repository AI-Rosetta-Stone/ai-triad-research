// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/280 (t/278 B): the How section under Why on an Ask answer. It reuses the shared HowPanel, so it
// matches Chat and Op-Ed. The raw prompt and output are not shown here: the debate behind the answer
// is reached from the "Open the debate" button instead.

import { HowPanel, type HowMethodsLink } from '../shared/HowPanel';
import './InquiryHowSection.css';

const INQUIRY_HOW_METHODS_LINKS: HowMethodsLink[] = [
  { label: 'Theory of Success', url: 'https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main/docs/ux/ask-a-question-theory-of-success.md' },
  { label: 'Theory of Operations', url: 'https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main/docs/ux/ask-a-question-theory-of-operations.md' },
];

interface InquiryHowSectionProps {
  /** Debate that produced the answer. Omitted on the public share, where debateId is not visible. */
  debateId?: string;
  onOpenDebate?: (debateId: string) => void;
}

export function InquiryHowSection({ debateId, onOpenDebate }: InquiryHowSectionProps) {
  return (
    <HowPanel methodsLinks={INQUIRY_HOW_METHODS_LINKS}>
      {debateId && onOpenDebate ? (
        <div className="inquiry-how-debate">
          <button type="button" className="inquiry-ghost" onClick={() => onOpenDebate(debateId)}>
            Open the debate that produced this answer
          </button>
          <span className="inquiry-how-debate-id mono">{debateId}</span>
        </div>
      ) : (
        <p className="inquiry-faint">The debate behind this answer is not shown here.</p>
      )}
    </HowPanel>
  );
}
