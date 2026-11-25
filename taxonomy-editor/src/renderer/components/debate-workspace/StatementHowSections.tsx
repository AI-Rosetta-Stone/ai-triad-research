// t/469: the vocabulary and lineage sections of the per-statement HOW. Each hides when empty.
// Convergence is not in the HOW body, and is no longer a per-statement How option (t/643, docs/ux/debate-statement-how.md).

import type { TranscriptEntry } from '../../types/debate';
import type { VocabResolution } from '../../utils/vocabularyAnnotations';
import { extractLineageNames } from '../../utils/lineageMatcher';
import { VocabTermsView, LineageTermsView } from './VocabularyPanel';
import { povToCamp } from '../shared/CampGlyph';

/** Vocabulary and lineage cards. Each part is hidden when it has nothing to show. */
export function HowVocabulary({ entry, vocabResolutions, ambiguities }: {
  entry: TranscriptEntry;
  vocabResolutions: VocabResolution[] | undefined;
  ambiguities?: { colloquial: string; offset?: number }[];
}) {
  const hasVocab = !!vocabResolutions && vocabResolutions.length > 0;
  const hasLineage = extractLineageNames(entry.content).length > 0;
  if (!hasVocab && !hasLineage) return null;
  return (
    <section className="sh-section" aria-label="Vocabulary and lineage">
      {hasVocab && (
        <VocabTermsView resolutions={vocabResolutions!} ambiguities={ambiguities} statementText={entry.content} speakerPov={povToCamp(entry.speaker) ? entry.speaker : undefined} />
      )}
      {hasLineage && <LineageTermsView content={entry.content} />}
    </section>
  );
}

