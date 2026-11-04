// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4138 — PI report: community chat pages have no scroll bar. jsdom doesn't apply
// imported CSS and layout bugs like a missing flex `min-height: 0` can't be caught by
// rendered-DOM assertions, so this reads the raw stylesheets and asserts on the rules
// directly (precedent: SpeakerIdentity.test.tsx's contrast-override check).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('chat scroll containers (t/4138)', () => {
  // t/4824: the scroll container moved from .chat-transcript to .chat-scroll-region (its new
  // parent, now also holding The Question) so The Question scrolls with the conversation instead
  // of sitting pinned above it. The t/4138 fix this test guards still has to hold on whichever
  // element is the real scroll container.
  it('.chat-scroll-region can shrink below its content height (min-height: 0) so overflow-y:auto triggers', () => {
    const css = readFileSync(join(import.meta.dirname, 'ChatWorkspace.css'), 'utf8');
    const block = css.slice(css.indexOf('.chat-scroll-region {'), css.indexOf('.chat-scroll-region {') + 400);
    expect(block).toMatch(/min-height:\s*0/);
    expect(block).toMatch(/overflow-y:\s*auto/);
  });

  it('.community-chat-detail (the opened read-only community chat) is a flex-shrinkable scroll container', () => {
    const css = readFileSync(join(import.meta.dirname, 'ChatTab.css'), 'utf8');
    const block = css.slice(css.indexOf('.community-chat-detail {'), css.indexOf('.community-chat-detail {') + 200);
    expect(block).toMatch(/min-height:\s*0/);
    expect(block).toMatch(/overflow-y:\s*auto/);
  });
});
