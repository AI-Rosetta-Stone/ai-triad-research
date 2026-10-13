// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { POV_META } from '@lib/electron-shared/povMeta';
import {
  INTRO_EYEBROW, INTRO_TITLE, TOUR_TAGLINE_LINES, INTRO_QUESTION, INTRO_VOICES,
} from '@lib/electron-shared/introCopy';
import { SettingsDialog } from './settings/SettingsDialog';
import './OnboardingTour.css';

const STORAGE_KEY = 'taxonomy-editor-onboarding-dismissed';

interface OnboardingTourProps {
  onDismiss: () => void;
}

interface ImageStep {
  kind?: 'image';
  heading: string;
  image: string;
  alt: string;
  body: string[];
  badge?: string;
}

/** t/4183: the AI Rosetta Stone hero, rendered as markup from the copy shared with the login page. */
interface HeroStep {
  kind: 'hero';
  heading: string;
}

type StepDef = ImageStep | HeroStep;

const STEPS: StepDef[] = [
  { kind: 'hero', heading: INTRO_TITLE },
  {
    heading: 'Explore the Taxonomy',
    image: '/onboarding/onboarding-taxonomy.png',
    alt: 'Taxonomy editor showing the Safetyist perspective with Desires category expanded',
    body: [
      'Browse three distinct perspectives on AI policy — Accelerationist, Safetyist, and Skeptic. Each perspective is organized into Beliefs, Desires, and Intentions.',
      'Select any item to see its full description, related nodes, graph attributes, and source evidence.',
    ],
  },
  {
    heading: 'Run AI Debates',
    image: '/onboarding/onboarding-debate.png',
    alt: 'Debate view showing a three-agent debate in progress with speaker cards',
    body: [
      'Stage structured debates between AI-powered characters who argue from each perspective. Choose a topic, select debaters, and watch them engage in real-time.',
      'After a debate, the reflection tool analyzes results and proposes taxonomy edits based on what emerged.',
    ],
  },
  {
    heading: 'Chat with Perspectives',
    image: '/onboarding/onboarding-chat.png',
    alt: 'Chat interface showing a conversation with a POV character and mode selector',
    body: [
      "Have one-on-one conversations with any perspective. Use Brainstorm mode to explore ideas, Inform mode to learn a position's reasoning, or Decide mode to work through a specific policy question.",
    ],
  },
  {
    heading: 'Bring Your Own AI Key',
    image: '/onboarding/onboarding-settings.png',
    alt: 'Settings dialog showing the AI Backend section with Gemini selected and API key input',
    body: [
      'AI features work out of the box — debates, chat, enrichment, and analysis all run on a built-in key with Gemini Flash Lite. The model and rate limits are fixed to keep things fair for everyone.',
      'Want more flexibility? Add your own API key in Settings to choose your model, switch backends, and remove rate limits.',
    ],
  },
];

function IntroHero({ heading }: { heading: string }) {
  return (
    <div className="onboarding-hero">
      <div className="onboarding-hero-eyebrow">{INTRO_EYEBROW}</div>
      <h2 className="onboarding-heading onboarding-hero-title">{heading}</h2>
      <p className="onboarding-hero-tagline">
        {TOUR_TAGLINE_LINES.map((line, i) => <span key={i}>{line}</span>)}
      </p>
      <div className="onboarding-hero-specimen">
        <p className="onboarding-hero-question">&ldquo;{INTRO_QUESTION}&rdquo;</p>
        <ul className="onboarding-hero-voices">
          {INTRO_VOICES.map(({ pov, line }) => {
            const meta = POV_META[pov];
            const color = `var(${meta.cssVar}, ${meta.color})`;
            return (
              <li key={pov} className="onboarding-hero-voice">
                <span className="onboarding-hero-dot" style={{ background: color }} aria-hidden="true" />
                <span className="onboarding-hero-name" style={{ color }}>{meta.label}</span>
                <span className="onboarding-hero-line">{line}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export function OnboardingTour({ onDismiss }: OnboardingTourProps) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<'next' | 'back'>('next');
  const [animating, setAnimating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(() => {
    try { localStorage.setItem(STORAGE_KEY, 'true'); } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'onboarding-tour', level: 'warn',
        message: 'Failed to persist onboarding dismissed flag',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
    }
    onDismiss();
  }, [onDismiss]);

  const goNext = useCallback(() => {
    if (animating) return;
    if (step >= STEPS.length - 1) { dismiss(); return; }
    setDirection('next');
    setAnimating(true);
    setTimeout(() => { setStep(s => s + 1); setAnimating(false); }, 200);
  }, [step, animating, dismiss]);

  const goBack = useCallback(() => {
    if (animating || step <= 0) return;
    setDirection('back');
    setAnimating(true);
    setTimeout(() => { setStep(s => s - 1); setAnimating(false); }, 200);
  }, [step, animating]);

  const goTo = useCallback((target: number) => {
    if (animating || target === step) return;
    setDirection(target > step ? 'next' : 'back');
    setAnimating(true);
    setTimeout(() => { setStep(target); setAnimating(false); }, 200);
  }, [step, animating]);

  // Escape key dismisses
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dismiss]);

  // Focus trap
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const focusable = card.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length > 0) focusable[0].focus();

    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !card) return;
      const els = card.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    window.addEventListener('keydown', trap);
    return () => window.removeEventListener('keydown', trap);
  }, [step, animating]);

  const handleOpenSettings = () => {
    try { localStorage.setItem(STORAGE_KEY, 'true'); } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'onboarding-tour', level: 'warn',
        message: 'Failed to persist onboarding dismissed flag',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
    }
    setShowSettings(true);
  };

  if (showSettings) {
    return <SettingsDialog onClose={onDismiss} />;
  }

  const current = STEPS[step];
  const isLastStep = step === STEPS.length - 1;

  return (
    <div className="dialog-overlay onboarding-overlay" role="dialog" aria-modal="true" aria-label="Welcome tour">
      <div className="onboarding-card" ref={cardRef}>
        <div
          className={`onboarding-step ${animating ? `onboarding-step-exit-${direction}` : 'onboarding-step-enter'}`}
          key={step}
        >
          {current.kind === 'hero' ? (
            <IntroHero heading={current.heading} />
          ) : (
            <>
              <div className="onboarding-image-frame">
                <img
                  src={current.image}
                  alt={current.alt}
                  className="onboarding-image"
                  onError={(e) => {
                    getGlobalRecorder()?.record({
                      type: 'embed.load-failure',
                      component: 'onboarding-tour',
                      level: 'warn',
                      message: 'Onboarding image failed to load',
                      data: { src: current.image },
                    });
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
              <h2 className="onboarding-heading">{current.heading}</h2>
              <div className="onboarding-body">
                {current.body.map((p, i) => <p key={i}>{p}</p>)}
                {isLastStep && (
                  <p>
                    <strong>Get a free API key:</strong>{' '}
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
                      Google AI Studio
                    </a>
                    {' '}— then open <strong>Settings</strong> to add it.
                  </p>
                )}
              </div>
              {current.badge && (
                <span className="onboarding-badge">{'🔑'} {current.badge}</span>
              )}
            </>
          )}
        </div>
        <div className="onboarding-footer">
          <div className="onboarding-dots">
            {STEPS.map((s, i) => (
              <button
                key={i}
                className={`onboarding-dot${i === step ? ' active' : ''}`}
                onClick={() => goTo(i)}
                aria-label={`Step ${i + 1} of ${STEPS.length}: ${s.heading}`}
              />
            ))}
          </div>
          <div className="onboarding-nav">
            {step > 0 && (
              <button className="btn btn-secondary onboarding-btn-back" onClick={goBack}>Back</button>
            )}
            {isLastStep ? (
              <>
                <button className="btn onboarding-btn-done" onClick={dismiss}>Done</button>
                <button className="btn btn-primary onboarding-btn-settings" onClick={handleOpenSettings}>
                  Open Settings
                </button>
              </>
            ) : (
              <button className="btn btn-primary onboarding-btn-next" onClick={goNext}>Next</button>
            )}
          </div>
        </div>
        <button className="onboarding-skip" onClick={dismiss}>Skip tour &rarr;</button>
      </div>
    </div>
  );
}
