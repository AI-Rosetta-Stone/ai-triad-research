// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LineageTermsView, VocabTermCard, VocabTermsView } from './VocabularyPanel';
import type { VocabResolution } from '../../utils/vocabularyAnnotations';

// ── Mocks ────────────────────────────────────────────────────

const mockExtractLineageNames = vi.fn<[string], string[]>();
vi.mock('../../utils/lineageMatcher', () => ({
  extractLineageNames: (text: string) => mockExtractLineageNames(text),
}));

const mockGetLineageInfo = vi.fn<[string], { summary?: string } | undefined>();
const mockGetAllLineages = vi.fn<[], Record<string, { summary?: string }>>().mockReturnValue({});
vi.mock('../../data/lineageLookup', () => ({
  getLineageInfo: (name: string) => mockGetLineageInfo(name),
  getAllLineages: () => mockGetAllLineages(),
}));

const mockNavigateToLineage = vi.fn();
let mockVocabTerms: unknown[] | undefined = undefined;
let mockStdTerms: unknown[] | undefined = undefined;

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: (selector: (s: { vocabularyTerms?: { colloquial?: unknown[]; standardized?: unknown[] } }) => unknown) =>
    selector({ vocabularyTerms: { colloquial: mockVocabTerms, standardized: mockStdTerms } }),
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: { navigateToLineage: typeof mockNavigateToLineage }) => unknown) =>
    selector({ navigateToLineage: mockNavigateToLineage }),
}));

vi.mock('./utils', () => ({
  POV_COLOR_VAR: {
    accelerationist: 'var(--color-acc)',
    safetyist: 'var(--color-saf)',
    skeptic: 'var(--color-skp)',
    situations: 'var(--color-sit)',
  },
}));

// ── LineageTermsView ─────────────────────────────────────────

describe('LineageTermsView', () => {
  beforeEach(() => {
    mockExtractLineageNames.mockReset();
    mockGetLineageInfo.mockReset();
  });

  it('renders "No lineage references found" when no names are extracted', () => {
    mockExtractLineageNames.mockReturnValue([]);
    render(<LineageTermsView content="Some neutral text" />);
    expect(screen.getByText('No lineage references found')).toBeInTheDocument();
  });

  it('renders singular reference count for one name', () => {
    mockExtractLineageNames.mockReturnValue(['Kantian Ethics']);
    mockGetLineageInfo.mockReturnValue(undefined);
    render(<LineageTermsView content="Kantian Ethics text" />);
    expect(screen.getByText('1 lineage reference')).toBeInTheDocument();
  });

  it('renders plural reference count for multiple names', () => {
    mockExtractLineageNames.mockReturnValue(['Utilitarianism', 'Kantian Ethics']);
    mockGetLineageInfo.mockReturnValue(undefined);
    render(<LineageTermsView content="Some philosophical text" />);
    expect(screen.getByText('2 lineage references')).toBeInTheDocument();
  });

  it('renders each lineage name', () => {
    mockExtractLineageNames.mockReturnValue(['Utilitarianism', 'Kantian Ethics']);
    mockGetLineageInfo.mockReturnValue(undefined);
    render(<LineageTermsView content="Some text" />);
    expect(screen.getByText('Utilitarianism')).toBeInTheDocument();
    expect(screen.getByText('Kantian Ethics')).toBeInTheDocument();
  });

  it('renders the summary when getLineageInfo returns one', () => {
    mockExtractLineageNames.mockReturnValue(['Utilitarianism']);
    mockGetLineageInfo.mockReturnValue({ summary: 'Greatest happiness principle.' });
    render(<LineageTermsView content="Utilitarian text" />);
    expect(screen.getByText('Greatest happiness principle.')).toBeInTheDocument();
  });

  it('does not render summary when getLineageInfo returns undefined', () => {
    mockExtractLineageNames.mockReturnValue(['Kantianism']);
    mockGetLineageInfo.mockReturnValue(undefined);
    const { container } = render(<LineageTermsView content="Kantian text" />);
    // Only the name div should be present, no summary paragraph
    expect(container.querySelectorAll('div > div > div').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Greatest happiness principle.')).not.toBeInTheDocument();
  });

  it('upgrades content-less term to content-rich alternative sharing the same stem', () => {
    mockExtractLineageNames.mockReturnValue(['regulatory sandboxes']);
    mockGetLineageInfo.mockImplementation((name: string) =>
      name === 'regulatory sandbox concept' ? { summary: 'A controlled environment...' } : undefined,
    );
    mockGetAllLineages.mockReturnValue({
      'regulatory sandbox concept': { summary: 'A controlled environment...' },
      'regulatory sandbox framework': { summary: 'A framework for...' },
    });
    render(<LineageTermsView content="regulatory sandboxes text" />);
    expect(screen.getByText('regulatory sandbox concept')).toBeInTheDocument();
    expect(screen.getByText('A controlled environment...')).toBeInTheDocument();
    expect(screen.queryByText('regulatory sandboxes')).not.toBeInTheDocument();
  });
});

// ── VocabTermCard ─────────────────────────────────────────────

describe('VocabTermCard', () => {
  beforeEach(() => {
    mockNavigateToLineage.mockReset();
  });

  it('renders the colloquial term', () => {
    render(
      <VocabTermCard
        bare="AGI"
        navigateToLineage={mockNavigateToLineage}
      />,
    );
    expect(screen.getByText('AGI')).toBeInTheDocument();
  });

  it('renders resolution links when dict is provided', () => {
    const dict = {
      resolves_to: [
        { standardized_term: 'artificial_general_intelligence', when: 'in technical contexts', default_for_camp: undefined },
      ],
    };
    render(
      <VocabTermCard
        bare="AGI"
        dict={dict}
        navigateToLineage={mockNavigateToLineage}
      />,
    );
    expect(screen.getByText('artificial_general_intelligence')).toBeInTheDocument();
    expect(screen.getByText('in technical contexts')).toBeInTheDocument();
  });

  it('renders display form from defLookup when available', () => {
    const dict = {
      resolves_to: [
        { standardized_term: 'agi', when: 'broadly', default_for_camp: undefined },
      ],
    };
    const defLookup = new Map([['agi', { display: 'Artificial General Intelligence', definition: 'A hypothetical AI...' }]]);
    render(
      <VocabTermCard
        bare="AGI"
        dict={dict}
        defLookup={defLookup}
        navigateToLineage={mockNavigateToLineage}
      />,
    );
    expect(screen.getByText('Artificial General Intelligence')).toBeInTheDocument();
  });

  it('renders definition from defLookup when available', () => {
    const dict = {
      resolves_to: [
        { standardized_term: 'agi', when: 'broadly', default_for_camp: undefined },
      ],
    };
    const defLookup = new Map([['agi', { display: 'AGI', definition: 'A hypothetical AI system.' }]]);
    render(
      <VocabTermCard
        bare="AGI"
        dict={dict}
        defLookup={defLookup}
        navigateToLineage={mockNavigateToLineage}
      />,
    );
    expect(screen.getByText('A hypothetical AI system.')).toBeInTheDocument();
  });

  it('renders default_for_camp label when provided', () => {
    const dict = {
      resolves_to: [
        { standardized_term: 'agi', when: 'broadly', default_for_camp: 'accelerationist' },
      ],
    };
    render(
      <VocabTermCard
        bare="AGI"
        dict={dict}
        navigateToLineage={mockNavigateToLineage}
      />,
    );
    expect(screen.getByText('Accelerationist')).toBeInTheDocument();
  });

  it('calls navigateToLineage when a resolution link is clicked', async () => {
    const dict = {
      resolves_to: [
        { standardized_term: 'agi', when: 'broadly', default_for_camp: undefined },
      ],
    };
    render(
      <VocabTermCard
        bare="AGI"
        dict={dict}
        navigateToLineage={mockNavigateToLineage}
      />,
    );
    await userEvent.click(screen.getByText('agi'));
    expect(mockNavigateToLineage).toHaveBeenCalledWith('agi');
  });

  it('renders fallback resolution link when dict is absent but resolved is provided', () => {
    render(
      <VocabTermCard
        bare="alignment"
        resolved="ai_alignment"
        navigateToLineage={mockNavigateToLineage}
      />,
    );
    expect(screen.getByText('ai_alignment')).toBeInTheDocument();
  });

  it('calls navigateToLineage with the resolved term when fallback link is clicked', async () => {
    render(
      <VocabTermCard
        bare="alignment"
        resolved="ai_alignment"
        navigateToLineage={mockNavigateToLineage}
      />,
    );
    await userEvent.click(screen.getByText('ai_alignment'));
    expect(mockNavigateToLineage).toHaveBeenCalledWith('ai_alignment');
  });

  it('renders ambiguous_when text when provided', () => {
    const dict = {
      resolves_to: [{ standardized_term: 'safety', when: 'broadly', default_for_camp: undefined }],
      ambiguous_when: ['discussing different risk models'],
    };
    render(
      <VocabTermCard
        bare="safety"
        dict={dict}
        navigateToLineage={mockNavigateToLineage}
      />,
    );
    expect(screen.getByText(/discussing different risk models/)).toBeInTheDocument();
  });

  // t/38: quote -> this POV's view -> other POVs' views
  describe('own-POV and other-POV sections', () => {
    const dict = {
      resolves_to: [
        { standardized_term: 'deployment_competitive', when: 'market context', default_for_camp: 'accelerationist' },
        { standardized_term: 'deployment_staged', when: 'risk context', default_for_camp: 'safetyist' },
        { standardized_term: 'deployment_harm', when: 'impact context', default_for_camp: 'skeptic' },
        { standardized_term: 'deployment_generic', when: 'any context' },
      ],
    };
    const defLookup = new Map([
      ['deployment_competitive', { display: 'Competitive deployment', definition: 'Shipping to win the market.' }],
      ['deployment_staged', { display: 'Staged deployment', definition: 'Release in gated phases.' }],
      ['deployment_harm', { display: 'Harmful deployment', definition: 'Rollout that shifts costs onto the public.' }],
      ['deployment_generic', { display: 'Deployment', definition: 'Putting a system into use.' }],
    ]);

    function renderCard() {
      return render(
        <VocabTermCard
          bare="deployment"
          dict={dict}
          resolved="deployment_competitive"
          defLookup={defLookup}
          navigateToLineage={mockNavigateToLineage}
          sourceSentence="Silence counts as non-deployment."
          speakerPov="accelerationist"
        />,
      );
    }

    it('puts the resolved sense under the speaker POV view with its definition', () => {
      const { container } = renderCard();
      const own = container.querySelector('.vocab-section-own') as HTMLElement;
      expect(own).not.toBeNull();
      expect(own.querySelector('.vocab-section-label')?.textContent).toBe('Accelerationist view');
      expect(within(own).getByText('Competitive deployment')).toBeInTheDocument();
      expect(within(own).getByText('Shipping to win the market.')).toBeInTheDocument();
      expect(within(own).queryByText('Staged deployment')).not.toBeInTheDocument();
    });

    it('lists every other sense under other POVs, labelled by POV, with definitions', () => {
      const { container } = renderCard();
      const other = container.querySelector('.vocab-section-other') as HTMLElement;
      expect(other.querySelector('.vocab-section-label')?.textContent).toBe('Other POVs\u2019 views');
      const groups = [...other.querySelectorAll('.vocab-pov-group')] as HTMLElement[];
      expect(groups.map(g => g.querySelector('.vocab-pov-group-label')?.textContent)).toEqual(['Safetyist', 'Skeptic', 'Other sense']);
      expect(within(groups[0]).getByText('Staged deployment')).toBeInTheDocument();
      expect(within(groups[0]).getByText('Release in gated phases.')).toBeInTheDocument();
      expect(within(groups[1]).getByText('Rollout that shifts costs onto the public.')).toBeInTheDocument();
      expect(within(groups[2]).getByText('Putting a system into use.')).toBeInTheDocument();
      expect(within(other).queryByText('Competitive deployment')).not.toBeInTheDocument();
    });

    it('renders the quote before the two sections', () => {
      const { container } = renderCard();
      const card = container.querySelector('.vocab-term-card') as HTMLElement;
      expect([...card.children].map(c => c.className)).toEqual([
        'vocab-term-name',
        'vocab-source-sentence',
        'vocab-section vocab-section-own',
        'vocab-section vocab-section-other',
      ]);
    });

    it('shows a missing definition visibly instead of collapsing to a raw ID', () => {
      render(
        <VocabTermCard
          bare="risk"
          dict={{ resolves_to: [
            { standardized_term: 'risk_innovation', when: 'growth context', default_for_camp: 'accelerationist' },
            { standardized_term: 'risk_catastrophic', when: 'x-risk context', default_for_camp: 'safetyist' },
          ] }}
          resolved="risk_innovation"
          defLookup={new Map([['risk_catastrophic', { display: 'Catastrophic risk', definition: '' }]])}
          navigateToLineage={mockNavigateToLineage}
          speakerPov="accelerationist"
        />,
      );
      expect(screen.getByText('risk_innovation')).toBeInTheDocument();
      expect(screen.getByText('Catastrophic risk')).toBeInTheDocument();
      expect(screen.getAllByText('No definition in the dictionary')).toHaveLength(2);
    });

    it('falls back to the resolved sense camp when no speaker POV is given', () => {
      const { container } = render(
        <VocabTermCard bare="deployment" dict={dict} resolved="deployment_staged" defLookup={defLookup} navigateToLineage={mockNavigateToLineage} />,
      );
      const own = container.querySelector('.vocab-section-own') as HTMLElement;
      expect(own.querySelector('.vocab-section-label')?.textContent).toBe('Safetyist view');
    });
  });
});

// ── VocabTermsView ────────────────────────────────────────────

describe('VocabTermsView', () => {
  beforeEach(() => {
    mockVocabTerms = undefined;
    mockStdTerms = undefined;
    mockNavigateToLineage.mockReset();
  });

  it('renders singular "1 term resolved" for a single resolution', () => {
    const resolutions: VocabResolution[] = [
      { colloquial: 'AGI', canonical: 'artificial_general_intelligence', offset: 0 },
    ];
    render(<VocabTermsView resolutions={resolutions} />);
    expect(screen.getByText(/1 term resolved/)).toBeInTheDocument();
  });

  it('renders plural term count for multiple resolutions', () => {
    const resolutions: VocabResolution[] = [
      { colloquial: 'AGI', canonical: 'agi', offset: 0 },
      { colloquial: 'alignment', canonical: 'ai_alignment', offset: 10 },
    ];
    render(<VocabTermsView resolutions={resolutions} />);
    expect(screen.getByText(/2 terms resolved/)).toBeInTheDocument();
  });

  it('deduplicates resolutions with the same colloquial term', () => {
    const resolutions: VocabResolution[] = [
      { colloquial: 'AGI', canonical: 'agi', offset: 0 },
      { colloquial: 'AGI', canonical: 'agi', offset: 20 },
    ];
    render(<VocabTermsView resolutions={resolutions} />);
    expect(screen.getByText(/1 term resolved/)).toBeInTheDocument();
  });

  it('renders each unique term card', () => {
    const resolutions: VocabResolution[] = [
      { colloquial: 'AGI', canonical: 'agi', offset: 0 },
      { colloquial: 'alignment', canonical: 'ai_alignment', offset: 10 },
    ];
    render(<VocabTermsView resolutions={resolutions} />);
    expect(screen.getByText('AGI')).toBeInTheDocument();
    expect(screen.getByText('alignment')).toBeInTheDocument();
  });

  it('shows ambiguity count when ambiguities are provided', () => {
    const resolutions: VocabResolution[] = [
      { colloquial: 'safety', canonical: 'ai_safety', offset: 0 },
    ];
    const ambiguities = [{ colloquial: 'control', offset: 5 }];
    render(<VocabTermsView resolutions={resolutions} ambiguities={ambiguities} />);
    expect(screen.getByText(/1 ambiguous/)).toBeInTheDocument();
  });

  it('renders ambiguous term cards in the ambiguity section', () => {
    const resolutions: VocabResolution[] = [];
    const ambiguities = [
      { colloquial: 'control', offset: 5 },
      { colloquial: 'alignment', offset: 20 },
    ];
    render(<VocabTermsView resolutions={resolutions} ambiguities={ambiguities} />);
    expect(screen.getByText('control')).toBeInTheDocument();
    expect(screen.getByText('alignment')).toBeInTheDocument();
  });

  it('enriches terms from vocabTerms store when available', () => {
    mockVocabTerms = [
      {
        colloquial_term: 'AGI',
        resolves_to: [{ standardized_term: 'agi', when: 'broadly', default_for_camp: undefined }],
        translation_ambiguous_when: [],
      },
    ];
    const resolutions: VocabResolution[] = [
      { colloquial: 'AGI', canonical: 'agi', offset: 0 },
    ];
    render(<VocabTermsView resolutions={resolutions} />);
    // The dict data from vocabTerms should appear (standardized term link)
    expect(screen.getByText('agi')).toBeInTheDocument();
  });

  it('renders the quote and candidate senses for an ambiguous term (t/38)', () => {
    mockVocabTerms = [
      {
        colloquial_term: 'harm',
        resolves_to: [
          { standardized_term: 'harm_physical', when: 'injury', default_for_camp: 'safetyist' },
          { standardized_term: 'harm_economic', when: 'loss', default_for_camp: 'skeptic' },
        ],
      },
    ];
    mockStdTerms = [
      { canonical_form: 'harm_physical', display_form: 'Physical harm', definition: 'Bodily injury.' },
      { canonical_form: 'harm_economic', display_form: 'Economic harm', definition: 'Financial loss.' },
    ];
    const text = 'Courts enforce harm claims. A lasting harm slips past the audit stack. Care beats risk.';
    const { container } = render(
      <VocabTermsView
        resolutions={[]}
        ambiguities={[{ colloquial: 'harm', offset: text.indexOf('lasting harm') + 8 }]}
        statementText={text}
        speakerPov="accelerationist"
      />,
    );
    const block = container.querySelector('.vocab-ambiguous-block') as HTMLElement;
    // offset picks the second sentence, not the first that also contains "harm"
    expect(block.querySelector('.vocab-source-sentence')?.textContent).toContain('A lasting harm slips past the audit stack.');
    expect(within(block).getByText('Candidate senses')).toBeInTheDocument();
    expect(within(block).getByText('Physical harm')).toBeInTheDocument();
    expect(within(block).getByText('Bodily injury.')).toBeInTheDocument();
    expect(within(block).getByText('Economic harm')).toBeInTheDocument();
    expect(block.querySelector('.vocab-section-own')).toBeNull();
  });

  it('shows a readable no-senses line for an ambiguous term missing from the dictionary', () => {
    const text = 'A lasting harm slips past the audit stack.';
    const { container } = render(
      <VocabTermsView resolutions={[]} ambiguities={[{ colloquial: 'harm', offset: 10 }]} statementText={text} />,
    );
    const block = container.querySelector('.vocab-ambiguous-block') as HTMLElement;
    expect(block.querySelector('.vocab-source-sentence')?.textContent).toContain('A lasting harm');
    expect(within(block).getByText('No senses in the dictionary for this term')).toBeInTheDocument();
  });

  it('exposes each section as a labelled group', () => {
    mockVocabTerms = [
      { colloquial_term: 'AGI', resolves_to: [
        { standardized_term: 'agi', when: 'broadly', default_for_camp: 'safetyist' },
        { standardized_term: 'agi_market', when: 'products', default_for_camp: 'accelerationist' },
      ] },
    ];
    render(<VocabTermsView resolutions={[{ colloquial: 'AGI', canonical: 'agi', offset: 0 }]} speakerPov="safetyist" />);
    expect(screen.getByRole('group', { name: 'Safetyist view' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Other POVs’ views' })).toBeInTheDocument();
    expect(screen.queryByText('No senses in the dictionary for this term')).not.toBeInTheDocument();
  });

  it('quotes the sentence at the offset after many paragraph breaks (t/46)', () => {
    // 15 paragraph breaks before an end-of-sentence term used to drift the offset into the next sentence.
    const text = Array.from({ length: 15 }, (_, i) => `Point ${i} stands.`).join('\n\n')
      + '\n\nWe fear rapid deployment.\n\nRegulators lag behind.';
    const { container } = render(
      <VocabTermsView
        resolutions={[{ colloquial: 'deployment', canonical: 'deployment_competitive', offset: text.indexOf('deployment') + 'deployment'.length - 1 }]}
        statementText={text}
      />,
    );
    expect(container.querySelector('.vocab-source-sentence')?.textContent).toBe('\u201cWe fear rapid deployment.\u201d');
  });

  it('picks the occurrence at the offset when an earlier sentence also uses the term (t/46)', () => {
    const text = 'Harm is real.\n\nPoint one stands.\n\nPoint two stands.\n\nA lasting harm slips past.';
    const { container } = render(
      <VocabTermsView resolutions={[]} ambiguities={[{ colloquial: 'harm', offset: text.lastIndexOf('harm') }]} statementText={text} />,
    );
    expect(container.querySelector('.vocab-ambiguous-block .vocab-source-sentence')?.textContent).toContain('A lasting harm slips past.');
  });

  it('passes the speaker POV to resolved term cards', () => {
    mockVocabTerms = [
      { colloquial_term: 'AGI', resolves_to: [{ standardized_term: 'agi', when: 'broadly', default_for_camp: 'safetyist' }] },
    ];
    const { container } = render(
      <VocabTermsView resolutions={[{ colloquial: 'AGI', canonical: 'agi', offset: 0 }]} speakerPov="skeptic" />,
    );
    expect(container.querySelector('.vocab-section-own .vocab-section-label')?.textContent).toBe('Skeptic view');
  });
});
