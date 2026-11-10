#!/usr/bin/env node
// Static token-contrast check (t/2264).
//
// Catches the defect class our test suite is structurally blind to: text
// reversed out over a tokenized fill that is light in some themes. vitest runs
// under jsdom, which applies no stylesheet, so no DOM-structure test can ever
// evaluate computed color — every instance of this class (four in t/2234) was
// found by hand-computing WCAG ratios against styles.css.
//
// Unlike scripts/check-camp-contrast.mjs, which hardcodes a snapshot of the
// theme palette, this reads styles.css as the source of truth, so it cannot
// drift from the real tokens.
//
// Usage:
//   node scripts/check-contrast.mjs [--all] [--json]
//     --all   also scan styles.css itself (noisy: pre-existing findings)
//     --include-page-bg   also check text with no explicit fill against the
//                         page surface (a broad AA audit, not this gate's class)
//     --json  machine-readable output

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = join(ROOT, 'src', 'renderer');
const STYLES = join(RENDERER, 'styles.css');

const AA_NORMAL = 4.5;
const AA_LARGE = 3.0; // >=24px, or >=18.66px bold
const NONTEXT = 3.0; // WCAG 1.4.11 — graphical objects / non-text controls (t/2359)
const ROOT_FONT_PX = 16;

// ── WCAG math (same as check-camp-contrast.mjs) ──────────────

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance([r, g, b]) {
  return 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
}

function contrast(rgbA, rgbB) {
  const [a, b] = [luminance(rgbA), luminance(rgbB)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ── CSS parsing ──────────────────────────────────────────────
// Hand-rolled rather than postcss: the renderer's CSS is plain (no nesting),
// and a zero-dependency check is easier for DevOps to wire into ci-gate.

/** Strip comments, but first harvest `contrast-fill` annotations (see below). */
function extractAnnotations(css) {
  const anns = [];
  const re = /\/\*\s*contrast-fill:\s*([^*]+?)\s*\*\/\s*([^{]+)\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    // A rule can list several selectors; the annotation applies to each.
    const selectors = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    anns.push({ selectors, fills: m[1].split(',').map((s) => s.trim()) });
  }
  return anns;
}

/**
 * Harvest bare `/* contrast-nontext *\/` markers (t/2359). A marked selector is a
 * graphical/non-text control (icon glyph, SVG stroke, border-only affordance) and
 * is scored at the WCAG 1.4.11 3:1 floor instead of the 4.5/3.0 text thresholds.
 * Boolean marker, parsed parallel to contrast-fill. Returns base selectors.
 */
function extractNonText(css) {
  const set = new Set();
  const re = /\/\*\s*contrast-nontext\s*\*\/\s*([^{]+?)\s*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    for (const s of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      set.add(splitThemeScope(s).base);
    }
  }
  return set;
}

function parseRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];

  const walk = (text) => {
    let i = 0;
    let buf = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '{') {
        const selector = buf.trim();
        let depth = 1;
        let j = i + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === '{') depth++;
          else if (text[j] === '}') depth--;
          if (depth > 0) j++;
        }
        const body = text.slice(i + 1, j);
        if (selector.startsWith('@')) {
          // @media / @supports wrap rules; @keyframes bodies are not rules we check.
          if (!/^@(keyframes|font-face|import|charset)/.test(selector)) walk(body);
        } else {
          rules.push({ selector, decls: parseDecls(body) });
        }
        i = j + 1;
        buf = '';
        continue;
      }
      buf += ch;
      i++;
    }
  };

  walk(src);
  return rules;
}

function parseDecls(body) {
  const decls = {};
  // Only top-level declarations (nested blocks were consumed by walk()).
  for (const part of body.split(';')) {
    if (part.includes('{')) continue;
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (prop && value) decls[prop] = value;
  }
  return decls;
}

// ── Theme token maps ─────────────────────────────────────────

const THEMES = ['light', 'dark', 'bkc', 'harvard'];

function buildThemeTokens(stylesFile = STYLES) {
  const rules = parseRules(readFileSync(stylesFile, 'utf8'));
  const tokens = Object.fromEntries(THEMES.map((t) => [t, {}]));

  for (const { selector, decls } of rules) {
    const targets = new Set();
    for (const sel of selector.split(',').map((s) => s.trim())) {
      if (sel === ':root') THEMES.forEach((t) => targets.add(t)); // :root is the base for all
      const m = sel.match(/\[data-theme=["']?([a-z]+)["']?\]/);
      if (m && THEMES.includes(m[1])) targets.add(m[1]);
    }
    if (!targets.size) continue;
    for (const [prop, value] of Object.entries(decls)) {
      if (!prop.startsWith('--')) continue;
      for (const t of targets) tokens[t][prop] = value;
    }
  }
  return tokens;
}

// ── Color resolution ─────────────────────────────────────────

const NAMED = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  transparent: null,
};

class Unresolved extends Error {
  constructor(token) {
    super(`undefined token ${token}`);
    this.token = token;
  }
}

function parseHex(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) {
    const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return [...rgb, parseInt(h.slice(6, 8), 16) / 255];
  }
  if (h.length !== 6) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** Split a function's argument list on top-level commas. */
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Resolve a CSS color value to [r,g,b] for a given theme.
 * Returns null for values that carry no color (transparent, none, currentColor
 * with no context). Throws Unresolved for an undefined custom property — that
 * is its own error class deliberately: silent fallthrough is exactly what hid
 * the white-on-`--bg-tertiary` defect, and a checker that treats an unknown
 * token as "no color" reproduces the blind spot it exists to catch.
 */
function resolveColor(value, tokens, seen = new Set()) {
  if (!value) return null;
  const v = value.trim();

  if (v.startsWith('#')) return parseHex(v);
  if (v in NAMED) return NAMED[v];
  if (v === 'currentColor' || v === 'inherit' || v === 'none') return null;

  const varM = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (varM) {
    const [, token, fallback] = varM;
    if (seen.has(token)) return null; // cycle guard
    seen.add(token);
    const defined = tokens[token];
    if (defined !== undefined) return resolveColor(defined, tokens, seen);
    if (fallback !== undefined) return resolveColor(fallback, tokens, seen);
    throw new Unresolved(token);
  }

  const rgbM = v.match(/^rgba?\(([^)]+)\)$/);
  if (rgbM) {
    const parts = rgbM[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => !Number.isNaN(n))) {
      // Keep alpha: a translucent fill must be composited over what is behind
      // it, or `rgba(R,G,B,.12)` under `color: rgb(R,G,B)` reads as a 1:1
      // false positive — the single most common chip pattern in this codebase.
      const a = parts.length >= 4 && !Number.isNaN(parts[3]) ? parts[3] : 1;
      return [parts[0], parts[1], parts[2], a];
    }
    return null;
  }

  // color-mix(in srgb, A p%, B) — approximate in sRGB. Good enough to rank a
  // pair against a 4.5:1 threshold; flagged as approximate in the report.
  const mixM = v.match(/^color-mix\(\s*in\s+[\w-]+\s*,\s*([\s\S]+)\)$/);
  if (mixM) {
    const args = splitArgs(mixM[1]);
    if (args.length !== 2) return null;
    const parse = (arg) => {
      const pm = arg.match(/^([\s\S]+?)\s+([\d.]+)%$/);
      return pm ? { color: pm[1], pct: parseFloat(pm[2]) / 100 } : { color: arg, pct: null };
    };
    const a = parse(args[0]);
    const b = parse(args[1]);
    const aPct = a.pct ?? (b.pct !== null ? 1 - b.pct : 0.5);
    const ca = resolveColor(a.color, tokens, new Set(seen));
    const cb = resolveColor(b.color, tokens, new Set(seen));
    if (!ca || !cb) return null; // mixing with transparent → treat as unknown
    return [0, 1, 2].map((i) => Math.round(ca[i] * aPct + cb[i] * (1 - aPct)));
  }

  return null;
}

/**
 * Flatten a possibly-translucent color onto an opaque base. Alpha is normal
 * source-over compositing; WCAG ratios are only meaningful between opaque
 * colors, so every pair is flattened before comparison.
 */
function flatten(color, base) {
  if (!color) return null;
  const a = color.length === 4 ? color[3] : 1;
  if (a >= 1) return color.slice(0, 3);
  if (!base) return null;
  return [0, 1, 2].map((i) => Math.round(color[i] * a + base[i] * (1 - a)));
}

// ── Selector indexing ────────────────────────────────────────

/** `[data-theme="dark"] .a .b` → { theme: 'dark', base: '.a .b' } */
function splitThemeScope(sel) {
  const m = sel.match(/\[data-theme=["']?([a-z]+)["']?\]\s*/);
  if (!m) return { theme: null, base: sel.trim() };
  return { theme: m[1], base: sel.replace(m[0], '').trim() || ':root' };
}

/**
 * Candidate ancestor selectors whose background could apply, nearest first.
 * `.a .b.c` → ['.a .b.c', '.a .b', '.a .c', '.a'] — the compound split matters:
 * the badge defects put the fill on `.speaker-identity-badge` while the text
 * sits on `.speaker-identity-badge .speaker-identity-label`, so a checker that
 * only looks at the same declaration block misses half the real corpus.
 */
function ancestorCandidates(base) {
  const parts = base.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = parts.length; i > 0; i--) {
    const chain = parts.slice(0, i);
    out.push(chain.join(' '));
    const last = chain[chain.length - 1];
    const classes = last.match(/\.[\w-]+/g) || [];
    if (classes.length > 1) {
      for (const c of classes) out.push([...chain.slice(0, -1), c].join(' '));
    }
  }
  return out;
}

function sizeThreshold(decls, tokens) {
  const fsRaw = decls['font-size'];
  const weight = parseInt(decls['font-weight'] || '400', 10);
  let px = ROOT_FONT_PX;
  if (fsRaw) {
    let v = fsRaw.trim();
    const varM = v.match(/^var\(\s*(--[\w-]+)/);
    if (varM && tokens[varM[1]]) v = tokens[varM[1]].trim();
    const rem = v.match(/^([\d.]+)rem$/);
    const pxm = v.match(/^([\d.]+)px$/);
    if (rem) px = parseFloat(rem[1]) * ROOT_FONT_PX;
    else if (pxm) px = parseFloat(pxm[1]);
  }
  const large = px >= 24 || (px >= 18.66 && weight >= 700);
  return { px, weight, min: large ? AA_LARGE : AA_NORMAL };
}

// ── Main check ───────────────────────────────────────────────

function cssFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (entry.endsWith('.css')) out.push(p);
  }
  return out;
}

export function check({
  all = false,
  includePageBg = false,
  rendererDir = RENDERER,
  stylesFile = STYLES,
} = {}) {
  const themeTokens = buildThemeTokens(stylesFile);
  const findings = [];
  const undefinedTokens = new Map();

  // Always scan every file. styles.css is normally excluded by default (scanning
  // all of it surfaces ~hundreds of noisy pre-existing findings → opt-in via --all),
  // but a selector carrying an explicit annotation (contrast-fill / contrast-nontext)
  // is a deliberate "check this control" statement, so THOSE are evaluated even in
  // the stylesFile without --all. Unannotated stylesFile rules stay opt-in (t/2372).
  const files = cssFiles(rendererDir);

  for (const file of files) {
    const css = readFileSync(file, 'utf8');
    const annotations = extractAnnotations(css);
    const nonTextSel = extractNonText(css);
    const rules = parseRules(css);

    // In default mode the stylesFile contributes ONLY its annotated selectors.
    const annotatedOnly = !all && file === stylesFile;
    const isAnnotated = (b) => {
      const control = b.replace(/::?[\w-]+(\([^)]*\))?/g, '').trim();
      if (nonTextSel.has(b) || (control && nonTextSel.has(control))) return true;
      return annotations.some((a) =>
        a.selectors.some((s) => {
          const sb = splitThemeScope(s).base;
          return sb === b || sb === control;
        }),
      );
    };

    // base selector -> theme ('*' for unscoped) -> decls
    const index = new Map();
    for (const { selector, decls } of rules) {
      for (const sel of selector.split(',').map((s) => s.trim())) {
        if (!sel) continue;
        const { theme, base } = splitThemeScope(sel);
        if (!index.has(base)) index.set(base, {});
        const slot = index.get(base);
        const key = theme || '*';
        slot[key] = { ...(slot[key] || {}), ...decls };
      }
    }

    const declsFor = (base, theme) => {
      const slot = index.get(base);
      if (!slot) return null;
      return { ...(slot['*'] || {}), ...(slot[theme] || {}) };
    };

    for (const [base, slot] of index) {
      const hasColorAnywhere = Object.values(slot).some((d) => d.color);
      if (!hasColorAnywhere) continue;
      if (annotatedOnly && !isAnnotated(base)) continue;

      for (const theme of THEMES) {
        const tokens = themeTokens[theme];
        const decls = declsFor(base, theme);
        if (!decls?.color) continue;

        let fg;
        try {
          fg = resolveColor(decls.color, tokens);
        } catch (e) {
          if (e instanceof Unresolved) {
            undefinedTokens.set(e.token, (undefinedTokens.get(e.token) || 0) + 1);
            continue;
          }
          throw e;
        }
        if (!fg) continue;

        // Non-text controls (icon glyph / SVG stroke / border ring) are scored at
        // the WCAG 1.4.11 3:1 floor, not the text thresholds. The marker sits on the
        // resting rule; strip pseudo-classes so :hover/:focus-visible states of the
        // SAME control inherit it (not a broadening to other selectors) (t/2359).
        const controlBase = base.replace(/::?[\w-]+(\([^)]*\))?/g, '').trim();
        const isNonText = nonTextSel.has(base) || (!!controlBase && nonTextSel.has(controlBase));

        // Background: own rule, else nearest ancestor, else the page surface.
        const backgrounds = [];
        const ann = annotations.find((a) =>
          a.selectors.some((s) => s === base || splitThemeScope(s).base === base),
        );
        if (ann) {
          for (const f of ann.fills) backgrounds.push({ value: f, from: 'annotation' });
        } else {
          let sawTransparent = false;
          for (const cand of ancestorCandidates(base)) {
            const d = declsFor(cand, theme);
            const bg = d?.background || d?.['background-color'];
            if (!bg) continue;
            // `transparent`/`none` carry no color — see-through, so keep walking
            // UP the chain instead of stopping here. Stopping at the first
            // transparent fill is exactly what hid transparent-fill controls
            // (the help icons) from the gate (t/2359).
            const norm = bg.trim().toLowerCase();
            if (norm === 'transparent' || norm === 'none') { sawTransparent = true; continue; }
            backgrounds.push({ value: bg, from: cand });
            break;
          }
          if (!backgrounds.length) {
            // An explicit `background: transparent` up the chain is a positive
            // statement that the page surface shows through, so evaluate against
            // it even without --include-page-bg (distinct from "no fill declared
            // anywhere", which stays the opt-in broad audit below). NOTE: assuming
            // var(--bg-primary) here is optimistic — a transparent control shown
            // only over a darker panel could pass against the page yet fail there;
            // fine for the current set (.field-help-btn/.theory-link sit on the
            // page surface). Scope the fall-through to non-text-annotated controls
            // (or the opt-in broad audit) — evaluating EVERY transparent text
            // control against the page surface floods the gate with the same ~2400
            // page-bg findings the includePageBg flag deliberately gates off. (t/2359)
            if (sawTransparent && (isNonText || includePageBg)) {
              backgrounds.push({ value: 'var(--bg-primary)', from: 'page surface (transparent control)' });
            } else if (includePageBg) {
              backgrounds.push({ value: 'var(--bg-primary)', from: 'page default' });
            } else {
              continue;
            }
          }
        }

        const { px, weight, min } = sizeThreshold(decls, tokens);
        const minReq = isNonText ? NONTEXT : min;

        for (const { value, from } of backgrounds) {
          let bg;
          try {
            bg = resolveColor(value, tokens);
          } catch (e) {
            if (e instanceof Unresolved) {
              undefinedTokens.set(e.token, (undefinedTokens.get(e.token) || 0) + 1);
              findings.push({
                kind: 'undefined-fill',
                file: relative(ROOT, file),
                selector: base,
                theme,
                detail: `background ${value} on ${from} — token ${e.token} is defined nowhere, so the fill silently falls through`,
              });
              continue;
            }
            throw e;
          }
          if (!bg) continue;

          // Flatten both onto the page surface before comparing: a translucent
          // chip fill sits over the page, and the text sits over the result.
          const surface = resolveColor('var(--bg-primary)', tokens);
          const bgFlat = flatten(bg, surface);
          const fgFlat = flatten(fg, bgFlat);
          if (!bgFlat || !fgFlat) continue;

          const ratio = contrast(fgFlat, bgFlat);
          if (ratio < minReq) {
            findings.push({
              kind: 'contrast',
              file: relative(ROOT, file),
              selector: base,
              theme,
              ratio: Number(ratio.toFixed(2)),
              required: minReq,
              nonText: isNonText,
              fg: decls.color,
              bg: value,
              bgFrom: from,
              text: `${px}px/${weight}`,
            });
          }
        }
      }
    }
  }

  return { findings, undefinedTokens };
}

// ── CLI ──────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('check-contrast.mjs');
if (!invokedDirectly) {
  // Imported (self-test) — expose check() without running or exiting.
} else {
const args = process.argv.slice(2);
const { findings, undefinedTokens } = check({
  all: args.includes('--all'),
  includePageBg: args.includes('--include-page-bg'),
});

if (args.includes('--json')) {
  console.log(JSON.stringify({ findings, undefinedTokens: [...undefinedTokens] }, null, 2));
} else {
  const contrastFindings = findings.filter((f) => f.kind === 'contrast');
  const fillFindings = findings.filter((f) => f.kind === 'undefined-fill');

  console.log('Token contrast check — text over tokenized fills, per theme\n');

  if (contrastFindings.length) {
    console.log(`AA failures (${contrastFindings.length}):\n`);
    for (const f of contrastFindings) {
      console.log(`  ${f.file}`);
      console.log(`    ${f.selector}  [${f.theme}]`);
      console.log(`    ${f.ratio}:1  (needs ${f.required}:1 at ${f.text})`);
      console.log(`    color ${f.fg} over ${f.bg}${f.bgFrom === 'annotation' ? ' (declared dynamic fill)' : ` (from ${f.bgFrom})`}\n`);
    }
  }

  if (fillFindings.length) {
    console.log(`Unresolvable fills (${fillFindings.length}) — cannot be verified:\n`);
    for (const f of fillFindings) {
      console.log(`  ${f.file}\n    ${f.selector}  [${f.theme}]\n    ${f.detail}\n`);
    }
  }

  if (undefinedTokens.size) {
    console.log('Undefined tokens referenced:');
    for (const [t, n] of [...undefinedTokens].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t}  (${n} resolution${n === 1 ? '' : 's'})`);
    }
    console.log('');
  }

  if (!findings.length) console.log('No AA failures found.\n');
}

// t/111: exitCode, never process.exit(). On Linux, stdout into a pipe is asynchronous, so exiting
// right after console.log drops whatever hasn't flushed: the ~330 KB --json payload reached
// check-contrast.sh cut off mid-object, the parse failed, and the gate read an empty count as OK.
process.exitCode = findings.length ? 1 : 0;
}
