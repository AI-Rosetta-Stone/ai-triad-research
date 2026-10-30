// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4543: the Rosetta Stone tool — every launch opens here (PI decision, t/4541#1, approved
// mockup t/4542). Replaces the retired OnboardingTour overlay: the same content now persists
// as a landing view instead of interrupting the app once per session.

import { POV_META } from '@lib/electron-shared/povMeta';
import {
  INTRO_TITLE, INTRO_TAGLINE_LINES, INTRO_QUESTION, INTRO_VOICES, INTRO_CODA,
} from '@lib/electron-shared/introCopy';
import { useTaxonomyStore } from '../hooks/useTaxonomyStore';
import { useSettingsDialog } from '../hooks/useSettingsDialog';
import { api } from '@bridge';
import './RosettaStoneTab.css';

interface FeatureCard {
  id: string;
  heading: string;
  body: string;
  cta: string;
  image?: { src: string; alt: string };
  onOpen: () => void;
}

// t/4543: root-absolute '/onboarding/...' strings resolve against the filesystem root under
// Electron's file:// `loadFile` (base: './' per vite.config.ts) — a latent bug in the retired
// OnboardingTour that never surfaced because it was only exercised against the localhost dev
// server. BASE_URL composes correctly for both the web ('/') and Electron ('./') builds.
const publicAsset = (path: string) => `${import.meta.env.BASE_URL}${path}`;

export function RosettaStoneTab() {
  const setActiveTab = useTaxonomyStore(s => s.setActiveTab);
  const openSettings = useSettingsDialog(s => s.open);

  // Order matches the left rail (t/4535, t/4543) — Chat, Op-Ed Studies, Ask a Question,
  // Debate, Taxonomy — with Bring Your Own AI Key kept last even though it has no rail
  // icon of its own (PI note, t/4542#1).
  const cards: FeatureCard[] = [
    {
      id: 'chat',
      heading: 'Chat with Perspectives',
      body: "One-on-one conversation with any perspective. Use Brainstorm mode to explore ideas, Inform mode to learn a position's reasoning, or Decide mode to work through a specific question.",
      cta: 'Open Chat',
      image: { src: publicAsset('onboarding/onboarding-chat.png'), alt: 'Chat interface showing a conversation with a POV character and mode selector' },
      onOpen: () => setActiveTab('chat'),
    },
    {
      id: 'opeds',
      heading: 'Op-Ed Studies',
      body: 'Generate an op-ed from any perspective, styled after a real outlet — The Washington Post, The New York Times, The Wall Street Journal — with that outlet’s length and framing built in. Open, export, or share from your My / Community library.',
      cta: 'Open Op-Ed Studies',
      onOpen: () => setActiveTab('opeds'),
    },
    {
      id: 'inquiry',
      heading: 'Ask a Question',
      body: 'Ask a plain-language research question and get a grounded answer broken out by camp — Accelerationist, Safetyist, Skeptic — with the full debate replay one click away.',
      cta: 'Open Ask a Question',
      onOpen: () => setActiveTab('inquiry'),
    },
    {
      id: 'debate',
      heading: 'Run AI Debates',
      body: 'Stage structured debates between AI-powered characters who argue from each perspective. Choose a topic, select debaters, and watch them engage in real-time.',
      cta: 'Open Debate',
      image: { src: publicAsset('onboarding/onboarding-debate.png'), alt: 'Debate view showing a three-agent debate in progress with speaker cards' },
      onOpen: () => setActiveTab('debate'),
    },
    {
      id: 'taxonomy',
      heading: 'Explore the Taxonomy',
      body: 'Browse three distinct perspectives on AI policy — Accelerationist, Safetyist, and Skeptic. Each perspective is organized into Beliefs, Desires, and Intentions. Select any item for its full description, related nodes, and source evidence.',
      cta: 'Open Taxonomy',
      image: { src: publicAsset('onboarding/onboarding-taxonomy.png'), alt: 'Taxonomy editor showing the Safetyist perspective with Desires category expanded' },
      onOpen: () => setActiveTab('accelerationist'),
    },
    {
      id: 'dataset',
      heading: 'Download Dataset',
      body: 'Everything behind this site, including the taxonomy, source summaries, debates and embeddings, is public on GitHub. Clone or download the dataset to run your own analyses, check our work, or build on it.',
      cta: 'Open GitHub',
      image: { src: publicAsset('onboarding/onboarding-dataset.png'), alt: 'GitHub repository page for AI-Rosetta-Stone / ai-triad-data' },
      onOpen: () => { void api.openExternal('https://github.com/AI-Rosetta-Stone/ai-triad-data'); },
    },
    {
      id: 'settings',
      heading: 'Bring Your Own AI Key',
      body: 'AI features work out of the box on a shared, rate-limited key. Add your own in Settings to choose your model, switch backends, and remove the limits.',
      cta: 'Open Settings',
      image: { src: publicAsset('onboarding/onboarding-settings.png'), alt: 'Settings dialog showing the AI Backend section with Gemini selected and API key input' },
      onOpen: () => openSettings('apiKeys'),
    },
  ];

  return (
    <div className="rosetta-tab">
      <div className="rosetta-tab-inner">
        <div className="rosetta-tab-hero">
          <h1 className="rosetta-tab-title">{INTRO_TITLE}</h1>
          <p className="rosetta-tab-tagline">
            {INTRO_TAGLINE_LINES.map((line, i) => <span key={i}>{line}</span>)}
          </p>
        </div>

        <div className="rosetta-tab-specimen">
          <p className="rosetta-tab-question">&ldquo;{INTRO_QUESTION}&rdquo;</p>
          <ul className="rosetta-tab-voices">
            {INTRO_VOICES.map(({ pov, line }) => {
              const meta = POV_META[pov];
              const color = `var(${meta.cssVar}, ${meta.color})`;
              return (
                <li key={pov} className="rosetta-tab-voice">
                  <span className="rosetta-tab-voice-dot" style={{ background: color }} aria-hidden="true" />
                  <span className="rosetta-tab-voice-name" style={{ color }}>{meta.label}</span>
                  <span className="rosetta-tab-voice-line">{line}</span>
                </li>
              );
            })}
          </ul>
          <p className="rosetta-tab-specimen-coda">{INTRO_CODA}</p>
        </div>

        <h2 className="rosetta-tab-section-heading">Who it&rsquo;s for</h2>
        <p className="rosetta-tab-whofor-intro">
          AI Triad Research is a multi-perspective research tool for AI policy/safety literature, built around a
          three-way debate engine (Accelerationist / Safetyist / Skeptic) plus a taxonomy editor over curated sources.
        </p>
        <div className="rosetta-tab-whofor-grid">
          <div className="rosetta-tab-whofor-item">
            <h3>Policy makers / congressional staff</h3>
            <p>Steelman a draft policy from three adversarial viewpoints before it&rsquo;s introduced, surfacing blind spots a single-perspective brief would miss.</p>
          </div>
          <div className="rosetta-tab-whofor-item">
            <h3>Journalists covering AI policy</h3>
            <p>Generate balanced framing for a story, with citeable sourced claims per POV instead of one-sided quotes.</p>
          </div>
          <div className="rosetta-tab-whofor-item">
            <h3>Academic researchers (AI safety/governance)</h3>
            <p>
              Trace claims across perspectives (accelerationist, safetyist, skeptic) back to source documents using the taxonomy.<br />
              Download raw datasets directly for independent research and analysis.
            </p>
          </div>
          <div className="rosetta-tab-whofor-item">
            <h3>Think tank analysts</h3>
            <p>Stress-test a position paper by running it through the debate engine before publication.</p>
          </div>
          <div className="rosetta-tab-whofor-item">
            <h3>AI lab policy/trust &amp; safety teams</h3>
            <p>Pressure-test an internal governance proposal against external critique patterns before it reaches legal or comms.</p>
          </div>
          <div className="rosetta-tab-whofor-item">
            <h3>Educators / debate coaches</h3>
            <p>Teach structured argumentation using real literature-grounded positions rather than invented pro/con lists.</p>
          </div>
          <div className="rosetta-tab-whofor-item rosetta-tab-whofor-item-wide">
            <h3>Grant-makers / philanthropy program officers</h3>
            <p>Evaluate a funding thesis against the strongest counterarguments in the field.</p>
          </div>
        </div>

        <h2 className="rosetta-tab-section-heading">What you can do here</h2>
        <div className="rosetta-tab-cards">
          {cards.map(card => (
            <div key={card.id} className="rosetta-tab-card">
              {card.image && (
                <img src={card.image.src} alt={card.image.alt} className="rosetta-tab-card-image" />
              )}
              <div className="rosetta-tab-card-body">
                <h3>{card.heading}</h3>
                <p>{card.body}</p>
                <button type="button" className="btn btn-secondary rosetta-tab-card-cta" onClick={card.onOpen}>
                  {card.cta}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
