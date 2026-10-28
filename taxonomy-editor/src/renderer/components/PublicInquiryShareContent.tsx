// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Extracted from PublicInquiryView.tsx (t/3654) — behavior-preserving move, not a rewrite
// (flagging to Server Auth to re-confirm their t/3628 review, since it covered the inline
// version). Shared by BOTH the actual public page (PublicInquiryView.tsx) and the mint-time
// disclosure preview (InquiryShareDialog.tsx) so the two render from the literal same
// component fed the literal same PublicInquiryShare object — the drift risk TL flagged
// (t/3654#1) is closed structurally, not just by a data-shape test.

import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { PublicInquiryShare } from '@lib/inquiry';
import { CAMP_LABELS, FIDELITY_LABELS, trustVerdictLabel } from './inquiry/inquiryDisplay';
import { InquiryTagScope } from './InquiryTagScope';
import { PublicGroundingSection } from './inquiry/PublicGroundingSection';
import './PublicInquiryView.css';

/** ADR-001 graceful-empty: a terminal share with no substantive content needs its own
 *  treatment, not a blank page that reads as broken (mirrors InquiryAnswerPanel's
 *  isZeroResult, adapted to the narrower public projection). */
function isZeroShare(doc: PublicInquiryShare): boolean {
  return doc.campVerdicts.length === 0 && doc.convergences.length === 0 && doc.evidenceLayers.length === 0;
}

/** t/4591: shares minted before `grounding` existed on this schema predate the field at runtime
 *  even though the type says it's required (`JSON.parse … as T` on the read side) — hide rather
 *  than crash, and WARN so the gap is diagnosable. */
function PublicInquiryGrounding({ grounding }: { grounding: PublicInquiryShare['grounding'] }) {
  if (!grounding) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'PublicInquiryShareContent',
      level: 'warn',
      message: 'Public share has no grounding field — hiding Grounding section',
      error: { name: 'MissingField', message: 'doc.grounding is undefined', stack: '' },
    });
    return null;
  }
  return <PublicGroundingSection grounding={grounding} />;
}

export function PublicInquiryShareContent({ doc }: { doc: PublicInquiryShare }) {
  return (
    <div className="pov-inquiry-card" aria-label="Shared question">
      <span className="pov-inquiry-eyebrow">Question</span>
      <h1 className="pov-inquiry-question">{doc.request.question}</h1>
      {/* POV-tag scope (t/3983): renders nothing for an untagged share. */}
      <InquiryTagScope doc={doc} />

      {/* Provenance — must-include per SO review (t/3628#2): a reader unfamiliar with the
          Ask screen must be able to see how this answer was produced. */}
      <div className="pov-inquiry-prov mono">
        <span>fidelity <b>{FIDELITY_LABELS[doc.request.fidelity]}</b></span>
        {Object.entries(doc.derivation.models).map(([role, model]) => (
          <span key={role}>{role} <b>{model}</b></span>
        ))}
        <span><b>{doc.derivation.rounds}</b> rounds</span>
      </div>

      {isZeroShare(doc) ? (
        <div className="pov-inquiry-banner pov-inquiry-banner-zero">
          <span className="pov-inquiry-bi">NO RESULT</span>
          <p>This run completed without producing camp verdicts, convergences, or evidence.</p>
        </div>
      ) : (
        <>
          {doc.campVerdicts.length > 0 && (
            <section className="pov-inquiry-sect">
              <span className="pov-inquiry-eyebrow">How each camp draws the line</span>
              <div className="pov-inquiry-camps">
                {doc.campVerdicts.map((cv) => (
                  <div className={`pov-inquiry-camp pov-inquiry-camp-${cv.camp}`} key={cv.camp}>
                    <div className="pov-inquiry-who">{CAMP_LABELS[cv.camp]}</div>
                    <p>{cv.verdict}</p>
                    {cv.nodes.length > 0 && (
                      <div className="pov-inquiry-nodes mono">{cv.nodes.map((n) => n.label).join(' · ')}</div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {doc.convergences.map((conv, i) => (
            <section className="pov-inquiry-conv" key={i}>
              <span className="pov-inquiry-eyebrow">Where they converged</span>
              <p>{conv.claim}</p>
              {conv.nodes.length > 0 && <div className="pov-inquiry-nodes mono">{conv.nodes.map((n) => n.label).join(' · ')}</div>}
            </section>
          ))}

          {doc.evidenceLayers.length > 0 && (
            <section className="pov-inquiry-sect">
              <span className="pov-inquiry-eyebrow">The layered answer the debate produced</span>
              <div className="pov-inquiry-layers">
                {doc.evidenceLayers.map((layer, i) => (
                  <div className="pov-inquiry-layer" key={i}>
                    <span className="pov-inquiry-ln">L{i + 1}</span>
                    <div>
                      <h5>{layer.title}</h5>
                      <p>{layer.role} — {layer.solves}</p>
                      {layer.sources.length > 0 && <div className="pov-inquiry-src mono">{layer.sources.join(' · ')}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {doc.unresolvedGaps.length > 0 && (
            <section className="pov-inquiry-sect">
              <span className="pov-inquiry-eyebrow">Unresolved</span>
              <ul className="pov-inquiry-gaps">
                {doc.unresolvedGaps.map((g, i) => <li key={i}>{g.description} <span className="pov-inquiry-faint">({g.confidence})</span></li>)}
              </ul>
            </section>
          )}

          {/* t/4591 removes only the Calibration badge CARDS (metric name, value, pill) — the
           *  trust reason itself is a must-include per SO review (t/3628#2) and stays on the
           *  page in this minimal form (TL triage, p/336#701). */}
          {doc.calibration.length > 0 && (
            <section className="pov-inquiry-sect">
              <div className="pov-inquiry-trust-notes">
                {doc.calibration.map((entry, i) => (
                  <p className="pov-inquiry-trust-note" key={i}>
                    <span className="pov-inquiry-trust-verdict">{trustVerdictLabel(entry.trust.verdict)}</span>
                    {' — '}{entry.trust.reason}
                  </p>
                ))}
              </div>
            </section>
          )}

          {/* t/4591: Grounding replaces Calibration's badge-card UI on this page — calibration
           *  data itself stays in the result, this only removes the cards from the page. */}
          <PublicInquiryGrounding grounding={doc.grounding} />
        </>
      )}

      {/* Adjacency-by-construction (t/3734, SO condition via t/3667#6). synthesizedHeadline's
       *  absence on this surface is already suppression-by-construction (toPublicInquiryShare
       *  Condition A/B) — presence-branch only, no content inspection (t/3566 exemption scope).
       *  Must-include per SO review (t/3628#2): "one run, not a finding" caveat. */}
      <div className="pov-inquiry-headline-group">
        {doc.synthesizedHeadline && <p className="pov-inquiry-headline">{doc.synthesizedHeadline}</p>}
        <div className="pov-inquiry-caveat"><b>One run, not a finding.</b> {doc.singleRunCaveat}</div>
      </div>

      <footer className="pov-inquiry-footer">
        <span className="pov-inquiry-brand">AI Triad Research</span>
      </footer>
    </div>
  );
}
