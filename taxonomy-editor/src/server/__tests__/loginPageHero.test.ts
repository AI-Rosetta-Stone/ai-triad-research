// @vitest-environment jsdom
//
// t/4183: the login page's hero copy now comes from lib/electron-shared/introCopy.ts (shared with the intro tour).
// The expected strings are written out here on purpose, so this test fails if the shared copy changes the login
// page's visible text. The login tagline is unchanged until the PI decides otherwise.

import { describe, it, expect } from 'vitest';
import { buildLoginPage } from '../loginPage.js';

function hero(): Element {
  const html = buildLoginPage(true);
  const m = html.match(/<body>([\s\S]*)<\/body>/);
  if (!m) throw new Error('login page has no body');
  document.body.innerHTML = m[1];
  const jacket = document.querySelector('.jacket-content');
  if (!jacket) throw new Error('login page has no hero');
  return jacket;
}

describe('login page hero (t/4183 shared copy)', () => {
  it('renders title and tagline in hero-row, coda in specimen (t/4638)', () => {
    const h = hero();
    expect(h.querySelector('.eyebrow')).toBeNull();
    expect(h.querySelector('.hero-row')).not.toBeNull();
    expect(h.querySelector('.project-title')?.textContent).toBe('AI Rosetta Stone');
    expect(h.querySelector('.tagline')?.innerHTML).toBe('The goal is NOT to PROVIDE ANSWERS.<br>The goal is to PROVOKE THINKING.');
    expect(h.querySelector('.coda')?.textContent).toBe(`The issue isn’t what was said, but why.`);
  });

  it('renders the question and the three voices, in POV order with their POV colour classes', () => {
    const h = hero();
    expect(h.querySelector('.question')?.textContent).toBe('“Should frontier AI development slow down?”');
    const voices = [...h.querySelectorAll('.voice')].map(v => [
      v.className,
      v.querySelector('.voice-name')?.textContent,
      v.querySelector('.voice-line')?.textContent,
      (v.querySelector('.voice-dot') as HTMLElement | null)?.getAttribute('style'),
    ]);
    expect(voices).toEqual([
      ['voice voice-acc', 'Accelerationist', 'Slowing down surrenders the benefits to whoever doesn’t.', 'background:var(--color-acc);'],
      ['voice voice-saf', 'Safetyist', 'Speed without verification is how we lose control.', 'background:var(--color-saf);'],
      ['voice voice-skp', 'Skeptic', 'First show me evidence the premise holds.', 'background:var(--color-skp);'],
    ]);
  });
});
