// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { ColorScheme } from '../../hooks/useTaxonomyStore/slices/settingsSlice';

// t/4887: single source for the theme id->label list, shared by SettingsDialog's picker and
// HelpDialog's Overview tab so the two can't drift the way Overview drifted from everything else.
export const THEME_OPTIONS: readonly { value: ColorScheme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'bkc', label: 'BKC' },
  { value: 'harvard', label: 'Harvard' },
  { value: 'system', label: 'System' },
];
