// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * Conformance suite for repairSnapshotMojibake (t/4394).
 * Mirrors the 12 Pester gate cases in tests/Repair-SnapshotMojibake.Tests.ps1 (PR #3671).
 * Inputs are built from the real mangle — CP437-mapped values of the original bytes — so
 * every round-trip is exact.
 */

import { describe, it, expect } from 'vitest';
import { repairSnapshotMojibake } from './repairSnapshotMojibake.js';

// ── Variant-A mangled chars (CP1252 smart-punct bytes read as CP437) ───────
// CP1252 0x92 (U+2019 ') → CP437 byte 0x92 → U+00C6 (Æ)
const AE = 'Æ'; // mangled '
// CP1252 0x91 (U+2018 ') → CP437 byte 0x91 → U+00E6 (æ)
const ae = 'æ'; // mangled '
// CP1252 0x93 (U+201C ") → CP437 byte 0x93 → U+00F4 (ô)
const OO = 'ô'; // mangled "
// CP1252 0x94 (U+201D ") → CP437 byte 0x94 → U+00F6 (ö)
const oo = 'ö'; // mangled "
// CP1252 0x96 (U+2013 –) → CP437 byte 0x96 → U+00FB (û)
const en = 'û'; // mangled –
// CP1252 0x97 (U+2014 —) → CP437 byte 0x97 → U+00F9 (ù)
const em = 'ù'; // mangled —

// ── Variant-B mangled chars (UTF-8 bytes read as CP437) ───────────────────
// U+2019 UTF-8: E2 80 99 → CP437 bytes → U+0393, U+00C7, U+00D6
const G = 'Γ';  // CP437 0xE2 (Γ)
const CC = 'Ç'; // CP437 0x80 (Ç)
const OD = 'Ö'; // CP437 0x99 (Ö)
const GCC = G + CC;  // B_LEAD signature

describe('repairSnapshotMojibake', () => {

  // ── Case 1: CP1252-as-CP437 full repair ──────────────────────────────────
  it('repairs cp1252-as-cp437: apostrophe Æ → U+2019', () => {
    const body = `don${AE}t worry about it`;
    const r = repairSnapshotMojibake(body);
    expect(r.variant).toBe('cp1252-as-cp437');
    expect(r.text).toBe("don’t worry about it");
  });

  // ── Case 2: UTF-8-as-CP437 full repair (strict arm) ──────────────────────
  it('repairs utf8-as-cp437: ΓÇÖ triplet → U+2019 (strict arm)', () => {
    const apos = G + CC + OD; // E2 80 99 → U+2019
    const body = `It${apos}s fine. She${apos}s happy. That${apos}s all.`;
    const r = repairSnapshotMojibake(body);
    expect(r.variant).toBe('utf8-as-cp437');
    expect(r.text).toBe("It’s fine. She’s happy. That’s all.");
  });

  // ── Case 3: Wrapper is never modified ────────────────────────────────────
  it('leaves the wrapper (everything before the first ---) untouched', () => {
    // HTML comment + metadata block + --- rule is the wrapper; body starts after.
    const wrapper = '<!-- source-id: abc123 -->\ntitle: Test doc\n---\n';
    const body = `don${AE}t modify the wrapper`;
    const full = wrapper + body;
    const r = repairSnapshotMojibake(full);
    expect(r.variant).toBe('cp1252-as-cp437');
    expect(r.text.startsWith(wrapper)).toBe(true);
    expect(r.text).toBe(wrapper + "don’t modify the wrapper");
  });

  // ── Case 4: Double-quote damage only (no apostrophe) ─────────────────────
  it('repairs cp1252-as-cp437: double quotes ôHelloö → "Hello"', () => {
    const body = `She said ${OO}Hello${oo} and left.`;
    const r = repairSnapshotMojibake(body);
    expect(r.variant).toBe('cp1252-as-cp437');
    expect(r.text).toBe("She said “Hello” and left.");
  });

  // ── Case 5: Clean French text — single LDQ only, no typographic evidence ─
  it('returns none for French text with isolated ô (only LDQ, no RDQ)', () => {
    // ô → CP1252 U+201C (LDQ) but no ö (RDQ), no apostrophe, no dashes → not typographic
    const body = `Le r${OO}seau nerveux traite l information.`;
    const r = repairSnapshotMojibake(body);
    expect(r.variant).toBe('none');
    expect(r.text).toBe(body);
  });

  // ── Case 6: Clean German text — single RDQ only, no typographic evidence ─
  it('returns none for German text with isolated ö (only RDQ, no LDQ)', () => {
    // ö → CP1252 U+201D (RDQ) but no ô (LDQ), no apostrophe, no dashes → not typographic
    const body = `Das Netz${oo}werk verarbeitet Informationen schnell.`;
    const r = repairSnapshotMojibake(body);
    expect(r.variant).toBe('none');
    expect(r.text).toBe(body);
  });

  // ── Case 7: French text with mid-word û and pre-space ù — spaced-dash gate fails
  it('returns none for French with û mid-word and ù before space (no spaced-dash pattern)', () => {
    // û (en dash) mid-word → decoded as word–word (no surrounding spaces)
    // ù (em dash) before space → decoded as word— (no leading space)
    // Neither matches ' [–—] '
    const body = `heur${en}eux bient${em} apr${OO}s.`;
    // decoded: heur–eux bient— apr"s. (no RDQ, no spaced dash, no apostrophe letter)
    const r = repairSnapshotMojibake(body);
    expect(r.variant).toBe('none');
    expect(r.text).toBe(body);
  });

  // ── Case 8: English em-dash between letters ───────────────────────────────
  it('repairs cp1252-as-cp437: em-dash ù between letters → [A-Za-z]—[A-Za-z]', () => {
    // ù → CP1252 U+2014 (—); pattern word—word matches isTypographic
    const body = `The risk${em}reward ratio matters here.`;
    const r = repairSnapshotMojibake(body);
    expect(r.variant).toBe('cp1252-as-cp437');
    expect(r.text).toBe("The risk—reward ratio matters here.");
  });

  // ── Case 9: UTF-8 with one broken byte — lenient arm ─────────────────────
  it('repairs utf8-as-cp437 via lenient arm; broken byte kept as U+00E1', () => {
    // á = U+00E1 = CP437 byte 0xA0 (orphaned continuation byte → strict fails)
    // Three ΓÇÖ sequences → three B_LEAD sigs → lenient arm fires
    const apos = G + CC + OD;
    const brokenChar = 'á'; // maps to CP437 0xA0 (orphaned continuation byte)
    const body = `It${apos}s fine. She${apos}s happy. He${apos}s here. Also ${brokenChar} letter.`;
    const r = repairSnapshotMojibake(body);
    expect(r.variant).toBe('utf8-as-cp437');
    // The three apostrophes are repaired; the broken á is kept as-is
    expect(r.text).toContain('’s fine');
    expect(r.text).toContain('’s happy');
    expect(r.text).toContain('’s here');
    expect(r.text).toContain('á letter');
  });

  // ── Case 10: Body has a real U+2019 — not CP437-encodable ────────────────
  it('returns none when body has a real U+2019 (not in CP437)', () => {
    // U+2019 is not representable as a CP437 byte — encoding gate rejects it
    const body = 'It’s already clean text.';
    const r = repairSnapshotMojibake(body);
    expect(r.variant).toBe('none');
    expect(r.text).toBe(body);
  });

  // ── Case 11: ASCII, empty, and trivially-clean inputs ─────────────────────
  it('returns none for ASCII-only text', () => {
    const r = repairSnapshotMojibake('Hello, world. No damage here.');
    expect(r.variant).toBe('none');
    expect(r.text).toBe('Hello, world. No damage here.');
  });

  it('returns none for empty string', () => {
    const r = repairSnapshotMojibake('');
    expect(r.variant).toBe('none');
    expect(r.text).toBe('');
  });

  // ── Case 12: CP437-encodable but no smart-punctuation gain ────────────────
  it('returns none when decoded CP1252 adds no smart chars (no smartGain)', () => {
    // é = U+00E9 = CP437 byte 0x82, not in VARIANT_A_CHARS → hasVariantAChar = false
    // Gate fails before smartGain is checked
    const body = 'café au lait';
    const r = repairSnapshotMojibake(body);
    expect(r.variant).toBe('none');
    expect(r.text).toBe(body);
  });

});
