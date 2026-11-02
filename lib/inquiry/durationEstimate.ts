// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Estimate inquiry execution time (t/4751). Seeded from prod Log Analytics p50/p90 wall-clock
// by fidelity (Quick/Standard/Deep) and debater model. Unknown models fall back to fidelity row.

export type InquiryFidelity = 'Quick' | 'Standard' | 'Deep';

export interface DurationEstimate {
  lowMin: number;
  highMin: number;
}

// Placeholder: this table is sourced from Azure prod Log Analytics (t/4751 step 1).
// PLACEHOLDER: awaiting Azure measurement table on t/4751; seeded with conservative estimates.
// Format: p50 as lowMin, p90 as highMin, in minutes.
interface DurationTable {
  [fidelity: string]: {
    [modelId: string]: DurationEstimate;
  };
}

// TODO(t/4751): Replace with actual Azure p50/p90 measurements once available.
// Conservative fallback: assumes worst-case overhead.
const FIDELITY_DURATIONS: DurationTable = {
  Quick: {
    // Fast models (e.g., gemini-3.5-flash-lite, claude-haiku-4-5)
    default: { lowMin: 1, highMin: 3 },
  },
  Standard: {
    // Mid-tier models (e.g., gemini-3.5-pro, claude-sonnet-5)
    default: { lowMin: 3, highMin: 8 },
  },
  Deep: {
    // Reasoning models (e.g., gemini-2.0-pro-exp, claude-opus-5.5)
    default: { lowMin: 5, highMin: 15 },
  },
};

export function estimateInquiryDuration(options: {
  fidelity: InquiryFidelity;
  debaterModel: string;
}): DurationEstimate {
  const { fidelity, debaterModel } = options;

  const fidelityTable = FIDELITY_DURATIONS[fidelity];
  if (!fidelityTable) {
    throw new Error(`Unknown fidelity: ${fidelity}. Expected Quick, Standard, or Deep.`);
  }

  // Try exact model match first, then fall back to fidelity default.
  const estimate = fidelityTable[debaterModel] || fidelityTable.default;

  return {
    lowMin: estimate.lowMin,
    highMin: estimate.highMin,
  };
}
