import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DescriptionToggle, resolveDescription, type DescriptionMode } from './DescriptionToggle';

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

describe('DescriptionToggle', () => {
  let onToggle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onToggle = vi.fn();
  });

  it('renders Formal and Plain buttons', () => {
    render(<DescriptionToggle mode="plain" onToggle={onToggle} hasPlainDescription={true} />);
    expect(screen.getByText('Formal')).toBeDefined();
    expect(screen.getByText('Plain')).toBeDefined();
  });

  it('highlights the active mode', () => {
    render(<DescriptionToggle mode="formal" onToggle={onToggle} hasPlainDescription={true} />);
    const formal = screen.getByText('Formal');
    expect(formal.className).toContain('active');
    const plain = screen.getByText('Plain');
    expect(plain.className).not.toContain('active');
  });

  it('calls onToggle when clicking the other mode', () => {
    render(<DescriptionToggle mode="formal" onToggle={onToggle} hasPlainDescription={true} />);
    fireEvent.click(screen.getByText('Plain'));
    expect(onToggle).toHaveBeenCalledWith('plain');
  });

  it('explains the formal fallback in the Plain title when no plain text exists', () => {
    render(<DescriptionToggle mode="plain" onToggle={onToggle} hasPlainDescription={false} />);
    const plain = screen.getByRole('radio', { name: /plain/i });
    expect(plain.getAttribute('title')).toBe('No plain version for this node; showing the formal text.');
    expect(plain.textContent).toBe('Plain');
  });

  it('shows no generating indicator, even when plain is active without plain text', () => {
    render(<DescriptionToggle mode="plain" onToggle={onToggle} hasPlainDescription={false} />);
    expect(document.querySelector('.description-toggle-generating')).toBeNull();
  });

  it('keeps the plain title when plain text exists', () => {
    render(<DescriptionToggle mode="plain" onToggle={onToggle} hasPlainDescription={true} />);
    const plain = screen.getByRole('radio', { name: /plain/i });
    expect(plain.getAttribute('title')).toBe('Show plain-language description (Alt+P)');
  });

  it('toggles on Alt+P when globalShortcut is true (default)', () => {
    render(<DescriptionToggle mode="formal" onToggle={onToggle} hasPlainDescription={true} globalShortcut={true} />);
    fireEvent.keyDown(document, { key: 'p', altKey: true });
    expect(onToggle).toHaveBeenCalledWith('plain');
  });

  it('does not toggle on Alt+P when globalShortcut is false', () => {
    render(<DescriptionToggle mode="formal" onToggle={onToggle} hasPlainDescription={true} globalShortcut={false} />);
    fireEvent.keyDown(document, { key: 'p', altKey: true });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('uses radiogroup role for accessibility', () => {
    render(<DescriptionToggle mode="plain" onToggle={onToggle} hasPlainDescription={true} />);
    expect(screen.getByRole('radiogroup')).toBeDefined();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0].getAttribute('aria-checked')).toBe('false');
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
  });
});

describe('resolveDescription', () => {
  it('returns formal description in formal mode', () => {
    const result = resolveDescription({ description: 'formal text', plain_description: 'plain text' }, 'formal');
    expect(result.text).toBe('formal text');
    expect(result.isGenerating).toBe(false);
  });

  it('returns plain description in plain mode', () => {
    const result = resolveDescription({ description: 'formal text', plain_description: 'plain text' }, 'plain');
    expect(result.text).toBe('plain text');
    expect(result.isGenerating).toBe(false);
  });

  it('falls back to formal when plain is null', () => {
    const result = resolveDescription({ description: 'formal text', plain_description: null }, 'plain');
    expect(result.text).toBe('formal text');
    expect(result.isGenerating).toBe(false);
  });

  it('handles null node', () => {
    const result = resolveDescription(null, 'plain');
    expect(result.text).toBe('');
    expect(result.isGenerating).toBe(false);
  });
});
