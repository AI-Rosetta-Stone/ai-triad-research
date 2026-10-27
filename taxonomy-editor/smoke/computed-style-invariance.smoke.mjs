// Computed-style invariance leg (t/2940 — TL Option C, t/2940#5/#6). Second assertion class in
// the t/3026 Playwright harness. A CSS source-split is a pure move → getComputedStyle unchanged
// per theme; this asserts the moved selectors' computed style still equals a committed fixture,
// across the 4 themes. A value change (non-pure split) fires the gate; a pure move passes.
//
// TWO MODES:
//   • CAPTURE (SMOKE_CAPTURE=1) — snapshot current computed style → write the fixture (commit it).
//   • ASSERT (default) — compare current vs the committed fixture. Skips (does not fail) when the
//     fixture is absent, so the gate is inert until a baseline is captured + committed.
// Fixture capture + both-arms belong in the Node-22 CI browser — the @playwright/test runner
// hangs on local Node-24 (t/3026/#1589), and a committed style baseline must come from the
// deterministic CI env. DevOps owns the CI wiring (t/2940#5); TL owns the both-arms GV.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, PROPS, CLUSTERS } from './computed-style-invariance.manifest.mjs';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:7862';
const CAPTURE = process.env.SMOKE_CAPTURE === '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'fixtures', 'computed-style-invariance.json');

/** For one theme, inject each selector's class, read PROPS via getComputedStyle, remove it. */
async function probeCluster(page, theme, selectors) {
  return page.evaluate(({ theme, selectors, props }) => {
    document.documentElement.dataset.theme = theme;
    const out = {};
    for (const sel of selectors) {
      const el = document.createElement('div');
      el.className = sel;
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const rec = {};
      for (const p of props) rec[p] = cs.getPropertyValue(p);
      el.remove();
      out[sel] = rec;
    }
    return out;
  }, { theme, selectors, props: PROPS });
}

test.beforeEach(async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // t/4543: every launch now opens the Rosetta Stone landing view (the old OnboardingTour
  // overlay this beforeEach used to suppress is retired — same navigation fix as the
  // attributes spec). Navigate into Taxonomy to reach the [data-tab] POV surface.
  await page.locator('button[aria-label="Taxonomy"]').first().click();
  await page.waitForSelector('[data-tab]', { timeout: 30_000 });
});

/**
 * Bring a cluster's CSS into the document, then wait until it's actually injected.
 *   • `gotoHash` clusters (full-document routes, e.g. debatePopout at #debate-window — t/3299 C):
 *     navigate the page to BASE + hash; App.tsx early-returns the popout root, lazy-loading its CSS.
 *     This REPLACES the document, so the caller passes a throwaway page (see the loop).
 *   • `switchTab` clusters (lazy chunks, e.g. summaries — t/3299 B): drive setActiveTab via the
 *     window.__ZUSTAND_STORES__.taxonomy handle (the nav button hides behind an advanced-view
 *     popover, so store-nav is the selector-stable path), then wait for the dynamic import's CSS.
 *   • `openTab` clusters (eager CSS): click the POV [data-tab]; the wait resolves immediately since
 *     the rule is already present.
 * The wait keys off the cluster's own selectors appearing in a loaded stylesheet — so a lazy chunk
 * that never loads (flag off / nav failed) fails loudly here instead of silently capturing defaults.
 */
async function reachCluster(page, cluster) {
  if (cluster.gotoHash) {
    await page.goto(BASE + cluster.gotoHash, { waitUntil: 'domcontentloaded' });
  } else if (cluster.switchTab) {
    await page.evaluate((tab) => {
      const stores = /** @type {any} */ (window).__ZUSTAND_STORES__;
      if (!stores?.taxonomy) throw new Error('taxonomy store not exposed on window.__ZUSTAND_STORES__');
      stores.taxonomy.getState().setActiveTab(tab);
    }, cluster.switchTab);
  } else {
    await page.locator(`[data-tab="${cluster.openTab}"]`).first().click();
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForFunction((selectors) => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet — skip
      for (const r of Array.from(rules)) {
        const st = /** @type {CSSStyleRule} */ (r).selectorText;
        if (st && selectors.some((s) => st.includes(s))) return true;
      }
    }
    return false;
  }, cluster.selectors, { timeout: 15_000 });
}

test('computed-style invariance across the 4 themes (t/2940)', async ({ page }) => {
  const captured = {};
  for (const [name, cluster] of Object.entries(CLUSTERS)) {
    // Skip clusters the web smoke can't reach — probing them would capture only CSS defaults (a
    // vacuous gate). The reason + re-inclusion trigger live in the manifest's `excluded` (t/2940#9,
    // t/3299); removing that marker re-includes the cluster here.
    if (cluster.excluded) continue;
    // gotoHash clusters load a full-document route (the #debate-window popout) that REPLACES the
    // main-app document — probe them on a throwaway page so they don't clobber the shared page the
    // other clusters use (and so cluster order doesn't matter). Others probe on the shared page.
    const probePage = cluster.gotoHash ? await page.context().newPage() : page;
    // Load the cluster's CSS (full-document goto, eager POV [data-tab] click, or lazy-chunk
    // store-nav) and wait for it to inject before probing — see reachCluster.
    await reachCluster(probePage, cluster);
    captured[name] = {};
    for (const theme of THEMES) {
      captured[name][theme] = await probeCluster(probePage, theme, cluster.selectors);
    }
    if (probePage !== page) await probePage.close();
  }

  if (CAPTURE) {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(captured, null, 2) + '\n');
    test.info().annotations.push({ type: 'capture', description: `wrote invariance fixture → ${FIXTURE}` });
    return; // capture run — nothing to assert against
  }

  test.skip(!existsSync(FIXTURE), 'invariance fixture not yet captured — run `SMOKE_CAPTURE=1` and commit fixtures/computed-style-invariance.json (t/2940)');
  const expected = JSON.parse(readFileSync(FIXTURE, 'utf-8'));
  // Whole-object equality: any drifted selector/theme/prop surfaces in the diff.
  expect(captured).toEqual(expected);
});
