// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NewOpEdDialog } from './NewOpEdDialog';
import outletsData from '@lib/oped/outlets.json';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';

// ── Bridge / hook mocks ───────────────────────────────────────────────────────

type ProgressEvent = { set_id: string; voice: string; stage: string; error?: string };

const h = vi.hoisted(() => {
  const state: { cb: ((e: ProgressEvent) => void) | null } = { cb: null };
  return {
    state,
    hasApiKey: vi.fn().mockResolvedValue(true),
    createOpEdSet: vi.fn(),
    cancelOpEdSet: vi.fn(),
    refreshAIModels: vi.fn().mockResolvedValue(undefined),
    onOpEdProgress: vi.fn((cb: (e: ProgressEvent) => void) => {
      state.cb = cb;
      return () => { state.cb = null; };
    }),
  };
});

const { hasApiKey, createOpEdSet, cancelOpEdSet, onOpEdProgress } = h;
const fireProgress = (e: ProgressEvent) => h.state.cb?.(e);

vi.mock('@bridge', () => ({
  api: {
    hasApiKey: h.hasApiKey,
    createOpEdSet: h.createOpEdSet,
    cancelOpEdSet: h.cancelOpEdSet,
    refreshAIModels: h.refreshAIModels,
    onOpEdProgress: h.onOpEdProgress,
  },
  isElectronMode: () => true,
}));

vi.mock('../../hooks/useAuthStatus', () => ({
  useAuthStatus: () => ({ user: 'u', anonymous: false, idp: 'github' }),
}));

function open(props: Partial<Parameters<typeof NewOpEdDialog>[0]> = {}) {
  return render(
    <NewOpEdDialog open onClose={vi.fn()} onCreated={vi.fn()} {...props} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hasApiKey.mockResolvedValue(true);
  h.state.cb = null;
});

describe('NewOpEdDialog — visibility', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<NewOpEdDialog open={false} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the create dialog when open', () => {
    open();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('New op-ed')).toBeTruthy();
  });
});

describe('NewOpEdDialog — refresh models (t/4317)', () => {
  it('asks for a dry run explicitly, so the server never has to coerce it', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /More options/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Model\b/ })); // the settings dialog's Model section
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh models' }));
    await waitFor(() => expect(h.refreshAIModels).toHaveBeenCalledTimes(1));
    expect(h.refreshAIModels).toHaveBeenCalledWith({ dryRun: true });
  });
});

describe('NewOpEdDialog — outlet dropdown (t/3818)', () => {
  it('includes Tech Policy Press as an option', () => {
    open();
    const select = screen.getByLabelText('Outlet') as HTMLSelectElement;
    const values = Array.from(select.options).map(o => o.value);
    expect(values).toContain('TechPolicyPress');
    expect(screen.getByRole('option', { name: 'Tech Policy Press' })).toBeTruthy();
  });

  it('defaults the selection to TechPolicyPress, matching the backend default', () => {
    open();
    const select = screen.getByLabelText('Outlet') as HTMLSelectElement;
    expect(select.value).toBe('TechPolicyPress');
  });

  // t/3864: the exact failure t/3796 caused — the dropdown rendered fine but offered a
  // DIFFERENT set from the backend. Assert against the real SSOT, not a mirrored literal,
  // so a future outlet added to outlets.json without a presentation-map entry still fails
  // loudly here if the option set ever drifts.
  it('offers exactly the SSOT outlet key set, and defaults to the SSOT default', () => {
    open();
    const select = screen.getByLabelText('Outlet') as HTMLSelectElement;
    const values = Array.from(select.options).map(o => o.value);
    const ssotKeys = Object.keys(outletsData.outlets);
    expect(values.sort()).toEqual(ssotKeys.sort());
    expect(values).toHaveLength(9);
    expect(select.value).toBe(outletsData.defaultOutlet);
  });
});

describe('NewOpEdDialog — voices + live count', () => {
  it('defaults to all three voices and updates the live count on toggle', () => {
    open();
    // t/2849: all three camps selected by default
    expect(screen.getByText(/Will create 3 op-eds on the same topic/)).toBeTruthy();
    // deselect two → the 1-op-ed line
    fireEvent.click(screen.getByRole('button', { name: 'Accelerationist' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skeptic' }));
    expect(screen.getByText('Will create 1 op-ed — Safetyist.')).toBeTruthy();
    // deselect the last → the empty prompt
    fireEvent.click(screen.getByRole('button', { name: 'Safetyist' }));
    expect(screen.getByText('Select at least one voice.')).toBeTruthy();
  });

  it('shows the multi-voice line and relabels the submit button', () => {
    open();
    // default: all three selected
    expect(screen.getByText(/Will create 3 op-eds on the same topic/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Draft 3 op-eds' })).toBeTruthy();
    // deselect one → two
    fireEvent.click(screen.getByRole('button', { name: 'Accelerationist' }));
    expect(screen.getByText(/Will create 2 op-eds on the same topic/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Draft 2 op-eds' })).toBeTruthy();
  });

  it('toggles a chip aria-pressed (selected by default)', () => {
    open();
    const chip = screen.getByRole('button', { name: 'Skeptic' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('NewOpEdDialog — Draft enablement', () => {
  it('disables Draft without a topic or voice, enables it with both', () => {
    open();
    const draft = () => screen.getByRole('button', { name: /Draft/ });
    // voices default-selected, but no topic yet → disabled
    expect((draft() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'Mandatory audits' } });
    // topic + default voices → enabled
    expect((draft() as HTMLButtonElement).disabled).toBe(false);
    // deselect every voice → disabled again (needs a voice)
    ['Accelerationist', 'Safetyist', 'Skeptic'].forEach(name =>
      fireEvent.click(screen.getByRole('button', { name })));
    expect((draft() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('NewOpEdDialog — topic / URL toggle', () => {
  it('swaps the topic textarea for a URL input and back', () => {
    open();
    expect(screen.getByLabelText(/Topic/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /From a web page instead/ }));
    expect(screen.getByLabelText(/Web page URL/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Use a topic instead/ }));
    expect(screen.getByLabelText(/Topic/)).toBeTruthy();
  });
});

describe('NewOpEdDialog — URL-in-topic steer (t/2899)', () => {
  const STEER = /This looks like a web page/;

  it('shows the steer hint when the topic box holds a URL (desktop)', () => {
    open();
    expect(screen.queryByText(STEER)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'https://example.com/post' } });
    expect(screen.getByText(STEER)).toBeTruthy();
  });

  it('is absent for a plain-text topic', () => {
    open();
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'Mandatory pre-deployment audits' } });
    expect(screen.queryByText(STEER)).toBeNull();
  });

  it('migrates the URL into the web-page field and switches modes on click', () => {
    open();
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'https://example.com/post' } });
    fireEvent.click(screen.getByRole('button', { name: /Use as web page/ }));
    // now in URL mode: the URL input carries the value, the topic box is gone
    const urlInput = screen.getByLabelText(/Web page URL/) as HTMLInputElement;
    expect(urlInput.value).toBe('https://example.com/post');
    expect(screen.queryByLabelText(/^Topic/)).toBeNull();
    // the steer hint no longer applies in URL mode
    expect(screen.queryByText(STEER)).toBeNull();
  });

  it('is absent in URL mode even if the topic previously looked like a URL', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /From a web page instead/ }));
    fireEvent.change(screen.getByLabelText(/Web page URL/), { target: { value: 'https://example.com/post' } });
    expect(screen.queryByText(STEER)).toBeNull();
  });

  it('is absent on web (allowUrlSource=false), where there is no URL path to steer to', () => {
    open({ allowUrlSource: false });
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'https://example.com/post' } });
    expect(screen.queryByText(STEER)).toBeNull();
  });
});

describe('NewOpEdDialog — settings drawer', () => {
  it('opens the More options drawer and applies changes', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /More options/ }));
    expect(screen.getByRole('dialog', { name: 'More options' })).toBeTruthy();
    // Angle section is reachable
    fireEvent.click(screen.getByRole('button', { name: 'Angle' }));
    fireEvent.change(screen.getByLabelText('Thesis'), { target: { value: 'Audits are the floor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    // Back on Screen A the modified badge reflects one changed section
    expect(screen.getByLabelText(/1 setting changed/)).toBeTruthy();
  });

  it('word count clamps on blur, not on keystroke — intermediate values are typeable (t/2685)', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /More options/ }));
    // 'Length & outlet' is the default section, so the override input is visible.
    const input = screen.getByLabelText('Word count override') as HTMLInputElement;

    // Regression: the old clamp ran on every change, so a below-min keystroke was collapsed to
    // 300 immediately — making only 300/2000 reachable. Now typing is preserved; clamp is on blur.
    fireEvent.change(input, { target: { value: '50' } });
    expect(input.value).toBe('50');
    fireEvent.blur(input);
    expect(input.value).toBe('300');

    // Above-max: typeable while editing, clamped to 2000 on blur.
    fireEvent.change(input, { target: { value: '9000' } });
    expect(input.value).toBe('9000');
    fireEvent.blur(input);
    expect(input.value).toBe('2000');

    // A mid-band value survives untouched.
    fireEvent.change(input, { target: { value: '800' } });
    fireEvent.blur(input);
    expect(input.value).toBe('800');

    // Empty ⇒ null ⇒ use the outlet band (no override sent).
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input.value).toBe('');
  });
});

describe('NewOpEdDialog — draft + progress + cancel', () => {
  it('creates, subscribes to progress, and reports the new set id', async () => {
    let resolveCreate!: (v: { set_id: string }) => void;
    createOpEdSet.mockReturnValue(new Promise<{ set_id: string }>(res => { resolveCreate = res; }));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    open({ onCreated, onClose });

    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'Mandatory audits' } });
    // default selects all three (t/2849); narrow to a single Safetyist op-ed
    fireEvent.click(screen.getByRole('button', { name: 'Accelerationist' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skeptic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft op-ed' }));

    // Progress panel appears and the subscription is active.
    expect(screen.getByText('Drafting your op-ed…')).toBeTruthy();
    expect(onOpEdProgress).toHaveBeenCalledTimes(1);

    // A progress tick renders the voice's stage.
    act(() => { fireProgress({ set_id: 'set-9', voice: 'safetyist', stage: 'generating' }); });
    expect(screen.getByText('Writing the Safetyist op-ed')).toBeTruthy();

    await act(async () => { resolveCreate({ set_id: 'set-9' }); });

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('set-9'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Cancel aborts the run with the id from the first progress event', async () => {
    createOpEdSet.mockReturnValue(new Promise<{ set_id: string }>(() => { /* never resolves */ }));
    open();

    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'Mandatory audits' } });
    // default selects all three (t/2849); narrow to a single Safetyist op-ed
    fireEvent.click(screen.getByRole('button', { name: 'Accelerationist' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skeptic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft op-ed' }));

    act(() => { fireProgress({ set_id: 'set-42', voice: 'safetyist', stage: 'queued' }); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelOpEdSet).toHaveBeenCalledWith('set-42');
  });

  it('surfaces an ActionableError Next Steps list on failure', async () => {
    createOpEdSet.mockRejectedValue(Object.assign(new Error('boom'), {
      problem: 'The generator could not be reached.',
      nextSteps: ['Check that PowerShell is installed', 'Retry in a moment'],
    }));
    open();

    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'Mandatory audits' } });
    // default selects all three (t/2849); narrow to a single Safetyist op-ed
    fireEvent.click(screen.getByRole('button', { name: 'Accelerationist' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skeptic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft op-ed' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('The generator could not be reached.')).toBeTruthy();
    expect(screen.getByText('Check that PowerShell is installed')).toBeTruthy();
  });
});

// t/3992: one optional POV tag for one member, carried as params.tagSelection; refused at setup when
// the tag is too thin (TL t/3957#7 B(a)). Uses the committed registry (skeptic "critical", t/3956).
describe('NewOpEdDialog — POV tag (t/3992)', () => {
  const setSkepticNodes = (n: number) => useTaxonomyStore.setState({
    skeptic: { nodes: Array.from({ length: n }, (_, i) => ({ id: `skp-beliefs-${i}`, pov_tags: ['critical'] })) },
  } as never);
  const pickCritical = (mode: 'Scope' | 'Prioritize' = 'Scope') => {
    fireEvent.change(screen.getByLabelText('POV wing (optional)'), { target: { value: 'skeptic' } });
    fireEvent.change(screen.getByLabelText('Tag for skeptic'), { target: { value: 'critical' } });
    if (mode === 'Prioritize') fireEvent.click(screen.getByLabelText('Prioritize'));
  };

  it('sends params.tagSelection for the tagged voice', async () => {
    setSkepticNodes(6);
    createOpEdSet.mockReturnValue(new Promise(() => { /* never resolves */ }));
    open();
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'Licensing' } });
    pickCritical();
    fireEvent.click(screen.getByRole('button', { name: /Draft/ }));
    await waitFor(() => expect(createOpEdSet).toHaveBeenCalledTimes(1));
    expect(createOpEdSet.mock.calls[0][0].params.tagSelection).toEqual({ pov: 'skeptic', tag: 'critical', mode: 'scope' });
  });

  it('an untagged set sends no tagSelection', async () => {
    createOpEdSet.mockReturnValue(new Promise(() => { /* never resolves */ }));
    open();
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'Licensing' } });
    fireEvent.click(screen.getByRole('button', { name: /Draft/ }));
    await waitFor(() => expect(createOpEdSet).toHaveBeenCalledTimes(1));
    expect(createOpEdSet.mock.calls[0][0].params).not.toHaveProperty('tagSelection');
  });

  it('Draft is disabled while a Scope tag is below the minimum', () => {
    setSkepticNodes(3);
    open();
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'Licensing' } });
    pickCritical();
    expect((screen.getByRole('button', { name: /Draft/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/minimum 5/);
  });

  it('deselecting the tagged voice drops the tag from the request', async () => {
    setSkepticNodes(6);
    createOpEdSet.mockReturnValue(new Promise(() => { /* never resolves */ }));
    open();
    fireEvent.change(screen.getByLabelText(/Topic/), { target: { value: 'Licensing' } });
    pickCritical();
    fireEvent.click(screen.getByRole('button', { name: 'Skeptic' }));
    fireEvent.click(screen.getByRole('button', { name: /Draft/ }));
    await waitFor(() => expect(createOpEdSet).toHaveBeenCalledTimes(1));
    expect(createOpEdSet.mock.calls[0][0].params).not.toHaveProperty('tagSelection');
  });
});
