// Node-24-safe computed-style-invariance capture/assert harness (t/3299 B).
//
// WHY THIS EXISTS: `computed-style-invariance.smoke.mjs` runs under `@playwright/test`, whose spec
// runner HANGS on local Node-24 (t/3026/#1589) — so fixture capture had to be done via an ad-hoc
// raw-Chromium session by the TL (#1927 lineage baseline, #1992 summaries). That made every capture
// a TL-manual ritual. This harness removes that: it drives the SAME capture logic through the
// Playwright LIBRARY (`chromium.launch()`), which is NOT the hanging test-runner — so `node
// smoke/invariance-capture.mjs` works on Node-24 (and CI Node-22) for anyone. The both-arms GV
// stays TL-owned (gate-signal-integrity); the capture MECHANISM is now committed + repeatable.
//
// The probe/nav logic is kept byte-contract-identical to computed-style-invariance.smoke.mjs so the
// fixture it writes is exactly what the @playwright/test gate asserts against. If you change the
// probe here, change it there too (and re-run both-arms).
//
// MODES (mirror the spec):
//   • CAPTURE (SMOKE_CAPTURE=1) — snapshot computed style for every non-excluded cluster → write the
//     fixture (commit it).
//   • ASSERT (default) — capture live + compare to the committed fixture; exit 1 (with a diff) on any
//     drift, exit 0 on match. Skips (exit 0) when the fixture is absent (inert until a baseline).
//
// Usage (from taxonomy-editor/, after `npm run build:container` + a running `smoke/serve.mjs`):
//   SMOKE_CAPTURE=1 node smoke/invariance-capture.mjs   # capture → fixtures/computed-style-invariance.json
//   node smoke/invariance-capture.mjs                   # assert vs the committed fixture
// NB: import the browser API from '@playwright/test' (re-exports chromium/firefox/webkit), NOT the
// bare 'playwright' package (not a direct dep here). This is the LIBRARY, not the test RUNNER — the
// Node-24 hang (t/3026/#1589) is the `playwright test` CLI spec runner, which we never invoke;
// chromium.launch() is verified clean on Node-24.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, PROPS, CLUSTERS } from './computed-style-invariance.manifest.mjs';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:7862';
const CAPTURE = process.env.SMOKE_CAPTURE === '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'fixtures', 'computed-style-invariance.json');

/** For one theme, inject each selector's class, read PROPS via getComputedStyle, remove it.
 *  IDENTICAL to computed-style-invariance.smoke.mjs::probeCluster. */
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

/** Bring a cluster's CSS into the document, then wait until it's actually injected.
 *  IDENTICAL to computed-style-invariance.smoke.mjs::reachCluster. */
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

async function captureAll() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    // t/4543: every launch now opens the Rosetta Stone landing view (the old OnboardingTour
    // overlay this used to suppress is retired) — same navigation fix as the spec's beforeEach.
    await page.locator('button[aria-label="Taxonomy"]').first().click();
    await page.waitForSelector('[data-tab]', { timeout: 30_000 });

    const captured = {};
    for (const [name, cluster] of Object.entries(CLUSTERS)) {
      if (cluster.excluded) continue; // vacuous-defaults guard — never silently capture an unreachable cluster.
      // gotoHash clusters load a full-document route (the #debate-window popout) that REPLACES the
      // main-app document — probe on a throwaway page so they don't clobber the shared page (and so
      // cluster order doesn't matter). IDENTICAL page handling to the spec's loop.
      const probePage = cluster.gotoHash ? await page.context().newPage() : page;
      await reachCluster(probePage, cluster);
      captured[name] = {};
      for (const theme of THEMES) {
        captured[name][theme] = await probeCluster(probePage, theme, cluster.selectors);
      }
      if (probePage !== page) await probePage.close();
    }
    return captured;
  } finally {
    await browser.close();
  }
}

const captured = await captureAll();

if (CAPTURE) {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify(captured, null, 2) + '\n');
  console.log(`[invariance-capture] wrote fixture → ${FIXTURE}`);
  console.log(`[invariance-capture] clusters: ${Object.keys(captured).join(', ')}`);
  process.exit(0);
}

if (!existsSync(FIXTURE)) {
  console.log('[invariance-capture] fixture absent — inert (run SMOKE_CAPTURE=1 to baseline).');
  process.exit(0);
}
const expected = JSON.parse(readFileSync(FIXTURE, 'utf-8'));
if (JSON.stringify(captured) === JSON.stringify(expected)) {
  console.log('[invariance-capture] ASSERT PASS — computed style matches the committed fixture.');
  process.exit(0);
}
// Report the first drifting cluster/theme/selector/prop for a legible failure.
const diffs = [];
for (const c of new Set([...Object.keys(captured), ...Object.keys(expected)])) {
  const a = captured[c], b = expected[c];
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    if (!a) { diffs.push(`cluster ${c}: present in fixture, MISSING in capture`); continue; }
    if (!b) { diffs.push(`cluster ${c}: present in capture, MISSING in fixture`); continue; }
    for (const th of THEMES) {
      for (const sel of Object.keys(b[th] || {})) {
        for (const p of PROPS) {
          const av = a[th]?.[sel]?.[p], bv = b[th]?.[sel]?.[p];
          if (av !== bv) diffs.push(`${c}/${th}/${sel}/${p}: capture=${JSON.stringify(av)} fixture=${JSON.stringify(bv)}`);
        }
      }
    }
  }
}
console.error('[invariance-capture] ASSERT FAIL — computed style drifted from the fixture:');
console.error(diffs.slice(0, 40).join('\n'));
if (diffs.length > 40) console.error(`… and ${diffs.length - 40} more`);
process.exit(1);
