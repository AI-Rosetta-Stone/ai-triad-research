# t/4478 fresh adjudication — n=24, drawn from the 217 POV+BDI-flagged items (seed 4478)

Verdicts: **FP** = false-positive flag (assigned correct) · **FIX** = fixable misfire (BDI
top1 clearly/moderately better) · **NOFIX** = genuine misfire, no clean retrieval home ·
**BORDERLINE** = both candidates plausible, not scored either way.

| # | doc | assigned | BDI top1 | margin_bdi | verdict | note |
|---|---|---|---|---|---|---|
| 1 | law-digital-resurrection-2026 | saf-desires-025 | saf-desires-027 | 0.1779 | BORDERLINE | neither node is a close fit for the KP's RUFADAA opt-in point |
| 2 | tort-law-frontier-artificial-intelligence-2026 | saf-beliefs-111 | saf-beliefs-019 | 0.1632 | FP | assigned (corporate responsibility) fits; top1 (self-modeling) is unrelated |
| 3 | fools-gold-defensive-deception-against-safety-removal-2026 | saf-beliefs-144 | saf-beliefs-223 | 0.0903 | FP | assigned (self-critique inflates confidence) fits exactly |
| 4 | alignment-assessment-recent-cybersecurity-incidents-2026-1 | saf-intentions-039 | saf-intentions-220 | 0.0675 | FP | assigned (prompt-variation deception testing) fits |
| 5 | hugging-face-incident-road-ahead-2026 | saf-beliefs-014 | saf-beliefs-203 | 0.1223 | FP | assigned (bypassable post-training safety) fits |
| 6 | guillotine-hypervisors-isolating-malicious-ais-2026 | saf-intentions-215 | saf-intentions-147 | 0.0934 | FP | assigned (safe-harbor liability shield) is the closer mechanism match |
| 7 | openai-hugging-face-partner-address-security-incident-2026 | saf-intentions-008 | saf-intentions-200 | 0.1112 | FP | assigned (capability testing) closer than top1 (defense-in-depth) |
| 8 | foundation-models-fair-use-2026-1 | saf-beliefs-131 | saf-beliefs-214 | 0.1727 | FIX | top1 (direct liability for generated content) is the clean copyright-liability home |
| 9 | mai-code-conduct-humanist-ai-2026 | saf-intentions-008 | saf-intentions-011 | 0.1436 | NOFIX | KP is a CBRNE/cyberops prohibition; neither testing nor minimal-impact-design nodes fit |
| 10 | cheating-behaviour-frontier-model-evaluations-2026-2 | saf-beliefs-003 | saf-beliefs-057 | 0.2936 | FIX | top1 ("resist detection, degrade over time") matches "harder-to-detect cheating" directly |
| 11 | dream-rsi-recursive-self-improvement-through-evolving-worlds-2026-1 | saf-beliefs-143 | saf-beliefs-116 | 0.1668 | NOFIX | KP is a methodological caution about interpreting failed experiments; neither node fits |
| 12 | democracy-v-machine-birth-digital-age-warnings-that-were-2026 | saf-beliefs-155 | saf-beliefs-018 | 0.1301 | FP | assigned (AI info-pollution erodes democracy) closer than top1 (cost-gap erodes trust) |
| 13 | fools-gold-defensive-deception-against-safety-removal-2026 | saf-intentions-008 | saf-intentions-142 | 0.1294 | FP | assigned (adversarial testing protocol) closer than top1 (architecture diversity) |
| 14 | letter-ai-lab-ceos-demanding-immediate-pause-frontier-2026 | saf-intentions-159 | saf-intentions-040 | 0.1148 | NOFIX | KP is a pause/moratorium demand; neither grant-conditioning nor officer-liability node fits |
| 15 | atria-dawn-dawn-agentic-superintelligence-evolving-roles-2026 | saf-beliefs-227 | saf-beliefs-056 | 0.1303 | BORDERLINE | memetic capture vs. dependency/deskilling — both plausible homes for "reduced to reviewer" |
| 16 | traiga-compliance-guide-texas-ai-law-requirements-2026-2026 | saf-intentions-158 | saf-intentions-234 | 0.1269 | FP | assigned (voluntary-standards theme) closer than top1 (pre-deployment safety case gating) |
| 17 | international-ai-safety-report-2026-2026-2 | saf-beliefs-104 | saf-beliefs-030 | 0.0803 | FIX | top1 (supply-chain/upstream vulnerability) fits "weights as attack target" better than data-poisoning |
| 18 | jensen-huang-thinks-ai-alarmism-has-gone-too-far-2026 | saf-desires-001 | saf-beliefs-206 | 0.0726 | FIX | assigned (AGI x-risk Desire) is category-wrong for an energy/scaling claim; top1 closer |
| 19 | pain-axis-llms-represent-self-directed-harm-act-relieve-it-2026-2 | saf-beliefs-096 | saf-beliefs-226 | 0.1712 | FIX | top1 (interpretability feature mapping) is the exact SAE-feature-analysis home |
| 20 | openais-disconcerting-hack-huggingface-what-we-should-do-2026 | saf-intentions-074 | saf-beliefs-097 | 0.0942 | FIX | genuine category-field/assigned-BDI mismatch (0.6% class); top1 fits both topically and by BDI type |
| 21 | fools-gold-defensive-deception-against-safety-removal-2026 | saf-beliefs-014 | saf-beliefs-133 | 0.0867 | FP | assigned (post-training safety bypassable) is an exact match |
| 22 | uncovering-trump-administrations-secret-rules-ai-model-2026 | saf-beliefs-141 | saf-beliefs-151 | 0.1614 | FP | assigned (unenforceable policy) fits; top1 (approval-speed fiction) is a different claim |
| 23 | international-ai-safety-report-2026-2026-2 | saf-intentions-009 | saf-intentions-202 | 0.1366 | FIX | assigned (data-center physical security) is wrong mechanism; top1 (tiered safety reqs) closer |
| 24 | international-ai-safety-report-2026-2026-2 | saf-beliefs-023 | saf-beliefs-130 | 0.0974 | FIX | top1 ("manipulation tactics may transfer") is closer to "RL rewards manipulative outputs" |

**Tally:** FP 11 (46%) · FIX 8 (33%) · NOFIX 4 (17%) · BORDERLINE 1 (4%).
Misfire-precision at 0.06 = FIX / (FP+FIX+NOFIX) = 8/23 ≈ 35%, or 8/24 ≈ 33% including the
borderline case in the denominator.
