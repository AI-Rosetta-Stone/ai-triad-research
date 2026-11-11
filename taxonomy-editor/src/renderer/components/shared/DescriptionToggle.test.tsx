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

  it('shows generating indicator when plain is active but unavailable', () => {
    render(<DescriptionToggle mode="plain" onToggle={onToggle} hasPlainDescription={false} />);
    const indicator = document.querySelector('.description-toggle-generating');
    expect(indicator).not.toBeNull();
  });

  it('hides generating indicator when plain description exists', () => {
    render(<DescriptionToggle mode="plain" onToggle={onToggle} hasPlainDescription={true} />);
    const indicator = document.querySelector('.description-toggle-generating');
    expect(indicator).toBeNull();
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
    expect(result.isGenerating).toBe(true);
  });

  it('handles null node', () => {
    const result = resolveDescription(null, 'plain');
    expect(result.text).toBe('');
    expect(result.isGenerating).toBe(false);
  });
});
