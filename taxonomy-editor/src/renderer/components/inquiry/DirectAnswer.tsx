// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/286 (Design rulings, t/286#14): the direct answer and the debated-topic line, shared by the Ask a Question
// answer panel and the public share page so the two cannot drift. Plain text only. Scope (TL, t/285#53): only
// directAnswer and questionDrift.debatedTopic are shown; never the drift warning, the score, the per-camp
// answered flags or answerNote, so this file takes neither.

import './DirectAnswer.css';

/** Design ruling 2: 'Camps agree' / 'Camps disagree', text not colour. The schema's `split` is the engine's word. */
export function agreementLabel(agreement: string | undefined): string | undefined {
  if (agreement === 'consensus') return 'Camps agree';
  if (agreement === 'split') return 'Camps disagree';
  return undefined;
}

/** Design ruling 3: the debated topic, only when it is present and differs from the question after trim and lower-casing. */
export function shownDebatedTopic(question: string, debatedTopic: string | undefined): string | undefined {
  const topic = debatedTopic?.trim();
  if (!topic) return undefined;
  return topic.toLowerCase() === question.trim().toLowerCase() ? undefined : topic;
}

/** The tag (its own line above the answer, for screen-reader order) and the answer paragraph. Empty or
 *  whitespace text renders nothing at all, tag included. */
export function DirectAnswerBlock({ directAnswer, className = '' }: {
  directAnswer: { text: string; agreement?: string } | undefined;
  className?: string;
}) {
  const text = directAnswer?.text?.trim();
  if (!directAnswer || !text) return null;
  const label = agreementLabel(directAnswer.agreement);
  return (
    <div className={`inquiry-direct-answer ${className}`.trim()}>
      {label && <span className="inquiry-direct-tag">{label}</span>}
      <p className="inquiry-direct-text">{text}</p>
    </div>
  );
}

export function DebatedTopicLine({ question, debatedTopic, className = '' }: {
  question: string;
  debatedTopic: string | undefined;
  className?: string;
}) {
  const topic = shownDebatedTopic(question, debatedTopic);
  if (!topic) return null;
  return <p className={`inquiry-debated-topic ${className}`.trim()}>The debate addressed: {topic}</p>;
}
