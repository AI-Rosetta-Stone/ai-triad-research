import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HowPanel, HowSection, HowRawContent } from './HowPanel';

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

    expect(screen.getByText('Raw prompt not recorded for this message.')).toBeInTheDocument();
    const responseToggle = screen.getByRole('button', { name: 'Raw Response' });
    expect(responseToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Raw response not recorded for this message.')).not.toBeInTheDocument();

    await userEvent.click(responseToggle);
    expect(responseToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Raw response not recorded for this message.')).toBeInTheDocument();
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
