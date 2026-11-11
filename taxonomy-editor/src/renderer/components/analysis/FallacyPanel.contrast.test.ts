// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/145: the chips inside a SELECTED fallacy row sit on the row's solid --focus-ring fill, which
// check-contrast.mjs can't see (it measures a descendant against the page, t/143). This resolves
// the tokens the rules use against each theme block and checks them against the row fill.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readCss, THEMES, token, ruleVar as ruleVarIn, ratio } from './__tests__/themeContrast';

const CSS = readCss(join(import.meta.dirname, 'FallacyPanel.css'));
const ruleVar = (selector: string, prop: string) => ruleVarIn(CSS, selector, prop);

const ROW = '.fallacy-panel-item.selected';
const COUNT = `${ROW} .fallacy-panel-item-count`;
const CAT = `${ROW} .fallacy-panel-item-cat`;

describe('FallacyPanel selected-row chip contrast (t/145)', () => {
  describe.each(THEMES)('%s theme', (theme) => {
    const rowFill = () => token(theme, ruleVar(ROW, 'background'));

    it('count chip: label passes 4.5:1 on its own fill, and the fill stands out 3:1 from the row', () => {
      const fill = token(theme, ruleVar(COUNT, 'background'));
      expect(ratio(token(theme, ruleVar(COUNT, 'color')), fill)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(fill, rowFill())).toBeGreaterThanOrEqual(3);
    });

    it('category chip: no fill of its own; label passes 4.5:1 on the row and its border 3:1', () => {
      expect(CSS).toMatch(new RegExp(`${CAT.replace(/\./g, '\\.')} \\{[^}]*background: transparent;`));
      expect(ratio(token(theme, ruleVar(CAT, 'color')), rowFill())).toBeGreaterThanOrEqual(4.5);
      expect(ratio(token(theme, ruleVar(CAT, 'border')), rowFill())).toBeGreaterThanOrEqual(3);
    });
  });

  it('a zero count in a selected row has no dimmed override; it differs by weight only', () => {
    expect(CSS).not.toContain(`${COUNT}.zero`);
  });
});
