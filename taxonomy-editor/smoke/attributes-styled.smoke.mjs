// Render smoke (t/3026): assert key surfaces render STYLED in a real prod web build.
// Technique = probe-injection: navigate to the tab that owns a surface (loads its lazy
// chunk → injects that chunk's CSS into <head>), then inject a throwaway element with a
// target class and read getComputedStyle. This asserts the RULE is loaded on that surface
// without needing real data to mount a real element — catching the whole failure class
// (a surface's CSS living in a chunk it doesn't load → silent unstyling; t/3024 + t/3025).
import { test, expect } from '@playwright/test';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:7862';

/** Inject `<div class=className>`, read one computed property, remove it. */
async function probe(page, className, prop) {
  return page.evaluate(({ className, prop }) => {
    const el = document.createElement('div');
    el.className = className;
    document.body.appendChild(el);
    const v = getComputedStyle(el).getPropertyValue(prop);
    el.remove();
    return v;
  }, { className, prop });
}

/** Navigate to a main tab (loads its lazy chunk → injects that chunk's CSS). */
async function openTab(page, tabId) {
  await page.locator(`[data-tab="${tabId}"]`).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
}

test.beforeEach(async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // t/4543: every launch now opens the Rosetta Stone landing view (the old OnboardingTour
  // overlay this beforeEach used to suppress is retired — every user lands here, not just
  // first-time/no-API-key ones). Navigate into Taxonomy to reach the [data-tab] POV surface
  // this spec's openTab() helper and every test below assume.
  await page.locator('button[aria-label="Taxonomy"]').first().click();
  await page.waitForSelector('[data-tab]', { timeout: 30_000 });
});

test('Attributes / GraphAttributesPanel: .ga-* grid rule is loaded (t/3024 regression)', async ({ page }) => {
  await openTab(page, 'accelerationist'); // POV chunk statically imports NodeDetail → GraphAttributesPanel
  const cols = await probe(page, 'ga-grid-3col', 'grid-template-columns');
  // styled → 3 tracks (e.g. "610px 305px 305px"); unstyled → 'none' / single track
  expect(cols.split(/\s+/).filter(Boolean).length, `ga-grid-3col grid-template-columns="${cols}"`).toBeGreaterThanOrEqual(3);
});

test('HighlightedField: .hl-backdrop overlay rule is loaded (t/3025)', async ({ page }) => {
  await openTab(page, 'accelerationist'); // NodeDescriptionSection renders HighlightedField on the POV surface
  expect(await probe(page, 'hl-backdrop', 'position')).toBe('absolute');
});

// t/3059: DataSourceCard's CSS is NOT chat-gated — it rides the main entry chunk. The chain is
// all static: DataSourceCard ← PromptInspector ← PromptsPanel ← ToolbarPaneRenderer ← PovTab
// (App.tsx statically imports PovTab), so DataSourceCard.css is injected at boot and present on
// every POV tab. The earlier `[data-tab="chat"]` assumption was over-conservative — probe on a
// POV tab. `.pi-node-count-preview` sets `border-bottom: 1px` → styled = 1px, unstyled = 0px.
test('DataSourceCard: .pi-node-count-preview rule is loaded (t/3025, enabled t/3059)', async ({ page }) => {
  await openTab(page, 'accelerationist');
  const bw = await probe(page, 'pi-node-count-preview', 'border-bottom-width');
  expect(bw, `pi-node-count-preview border-bottom-width="${bw}"`).not.toBe('0px');
});

// t/3059: ApiKeyErrorMessage.css also rides the main chunk — ApiKeyErrorMessage ← AnalysisPanel,
// which PovTab statically imports (PovTab.tsx:23) and renders. So the rule is loaded at boot on
// the POV tabs; probe-injection needs only the rule present, not the error state triggered.
// `.api-key-error-link` sets `text-decoration: underline` → styled = 'underline', unstyled = 'none'.
test('ApiKeyErrorMessage: .api-key-error-link rule is loaded (t/3025, enabled t/3059)', async ({ page }) => {
  await openTab(page, 'accelerationist');
  const td = await probe(page, 'api-key-error-link', 'text-decoration-line');
  expect(td, `api-key-error-link text-decoration-line="${td}"`).toContain('underline');
});

// t/3059: `.claim-attribution-*` was a CONFIRMED orphan — used LIVE on the POV Attributes/Research
// tab (NodeDetail.tsx renders `.claim-attribution-text`/`-label`) but its only CSS home was
// ArgumentGraph.css, imported solely by ArgumentGraph ← TimelineScrubber, which is NEVER rendered
// → tree-shaken → the rule shipped in NO chunk → unstyled on the POV tab. Fixed the #1561 way in
// this PR by relocating the two rules into NodeDetail.css (main chunk → present on every consuming
// surface). `.claim-attribution-label` sets `text-transform: uppercase` → styled, unstyled = 'none'.
test('claim-attribution: .claim-attribution-label rule is loaded (t/3025/t/3059 orphan fix)', async ({ page }) => {
  await openTab(page, 'accelerationist'); // NodeDetail renders claim-attribution on the POV surface
  const tt = await probe(page, 'claim-attribution-label', 'text-transform');
  expect(tt, `claim-attribution-label text-transform="${tt}"`).toBe('uppercase');
});
