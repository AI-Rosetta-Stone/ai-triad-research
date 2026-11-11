import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HowPanel, HowSection, HowRawContent } from './HowPanel';

vi.mock('@bridge', () => ({
  api: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

describe('HowPanel', () => {
  it('renders How toggle button', () => {
    render(<HowPanel rawPrompt="" rawResponse="" />);
    expect(screen.getByText('How')).toBeInTheDocument();
  });

  it('expands and collapses on toggle click', async () => {
    const { container } = render(<HowPanel rawPrompt="test prompt" rawResponse="test response" />);
    const toggleBtn = screen.getByText('How');

    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.how-body')).not.toBeInTheDocument();

    await userEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.how-body')).toBeInTheDocument();
  });

  it('displays raw prompt and response sections when expanded', async () => {
    const { container } = render(<HowPanel rawPrompt="test prompt" rawResponse="test response" />);
    await userEvent.click(screen.getByText('How'));

    expect(screen.getByText('Raw Prompt')).toBeInTheDocument();
    expect(screen.getByText('Raw Response')).toBeInTheDocument();
    expect(container.querySelector('.how-textbox')).toHaveTextContent('test prompt');
  });

  it('shows missing text when values are undefined', async () => {
    render(<HowPanel rawPrompt={undefined} rawResponse={undefined} />);
    await userEvent.click(screen.getByText('How'));

    expect(screen.getByText(/Raw prompt not recorded/)).toBeInTheDocument();
    
    // Expand Raw Response section
    const responseToggle = Array.from(screen.getAllByRole('button')).find(btn => 
      btn.textContent?.includes('Raw Response')
    );
    if (responseToggle) {
      await userEvent.click(responseToggle);
      expect(screen.getByText(/Raw response not recorded/)).toBeInTheDocument();
    }
  });

  it('displays Methods section when methodsLinks prop is provided', async () => {
    const customLinks = [
      { label: 'Custom Link 1', url: 'https://example.com/1' },
      { label: 'Custom Link 2', url: 'https://example.com/2' },
    ];
    render(<HowPanel rawPrompt="test" rawResponse="test" methodsLinks={customLinks} />);
    await userEvent.click(screen.getByText('How'));

    // Expand Methods section
    const methodsToggle = Array.from(screen.getAllByRole('button')).find(btn => 
      btn.textContent?.includes('Methods')
    );
    if (methodsToggle) {
      await userEvent.click(methodsToggle);
      expect(screen.getByRole('button', { name: /Custom Link 1/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Custom Link 2/i })).toBeInTheDocument();
    }
  });

  it('does not display Methods section when methodsLinks prop is empty array', async () => {
    render(<HowPanel rawPrompt="test" rawResponse="test" methodsLinks={[]} />);
    await userEvent.click(screen.getByText('How'));

    expect(screen.queryByText('Methods')).not.toBeInTheDocument();
  });

  it('does not display Methods section when no methodsLinks prop provided', async () => {
    render(<HowPanel rawPrompt="test" rawResponse="test" />);
    await userEvent.click(screen.getByText('How'));

    expect(screen.queryByText('Methods')).not.toBeInTheDocument();
  });
});

describe('HowSection', () => {
  it('renders title and toggles expanded state', async () => {
    render(
      <HowSection title="Test Section" defaultExpanded={false}>
        <p>Section content</p>
      </HowSection>
    );

    const toggle = screen.getByRole('button', { name: /Test Section/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Section content')).toBeInTheDocument();
  });

  it('renders content by default when defaultExpanded is true', () => {
    render(
      <HowSection title="Test Section" defaultExpanded={true}>
        <p>Section content</p>
      </HowSection>
    );

    expect(screen.getByText('Section content')).toBeInTheDocument();
  });
});

describe('HowRawContent', () => {
  it('renders textbox with content when value exists', () => {
    const { container } = render(
      <HowRawContent value="test content" label="Test Label" missingText="Not available" />
    );

    const textbox = container.querySelector('.how-textbox');
    expect(textbox).toHaveTextContent('test content');
    expect(textbox).toHaveAttribute('aria-label', 'Test Label');
  });

  it('renders missing message when value is undefined', () => {
    render(
      <HowRawContent value={undefined} label="Test Label" missingText="Custom missing text" />
    );

    expect(screen.getByText('Custom missing text')).toBeInTheDocument();
  });

  it('renders missing message when value is empty string', () => {
    render(
      <HowRawContent value="" label="Test Label" missingText="Not available" />
    );

    expect(screen.getByText('Not available')).toBeInTheDocument();
  });
});
