# Phase 2 Gate Rules & Thresholds

**Version:** 1.0  
**Last Updated:** 2026-11-08  
**Status:** Ready for Production  

---

## Overview

The Phase 2 Gate is an automated CI check that validates Phase 2 features (Debate V2, Cache V2, AI Client V2) are ready for production rollout.

**When it runs:**
- After 2-hour soak test completes
- Compares Phase 2 metrics vs Phase 1 baseline
- Posts pass/fail report to PR
- Blocks merge if FAIL (unless force-approved)

**Who can override:**
- PI (principal investigator) only
- Use when regression is acceptable and understood
- Document reason in override comment

---

## Thresholds

### Debate Engine V2

| Metric | Baseline | Threshold | Fail If |
|--------|----------|-----------|---------|
| p99 latency | 94.62ms (v1) | +10% max | >104.1ms |
| error rate | <0.5% | <1% | >1% |
| fallback rate | 0% | <2% | >2% |

**Rationale:**
- 10% p99 increase is acceptable (BDI grounding overhead)
- Errors must be <1% (safety margin)
- Fallbacks <2% (indicates v1 path rarely triggered)

### Taxonomy Cache V2

| Metric | Baseline | Threshold | Fail If |
|--------|----------|-----------|---------|
| hit rate | 80.5% | -5% max | <75.5% |
| eviction rate | <20% | <30% | >30% |
| lookup latency | <2ms | <5ms | >5ms p99 |

**Rationale:**
- Cache should hit >75% of time (else defeats purpose)
- Evictions >30% suggests misconfigured TTL/size
- Lookup <5ms ensures caching adds minimal overhead

### AI Client V2

| Metric | Baseline | Threshold | Fail If |
|--------|----------|-----------|---------|
| batch overhead | 15% | +20% max | >35% |
| stream completion | >99% | >95% | <95% |
| api call reduction | ~60% | >50% | <50% |

**Rationale:**
- Batch overhead of 15% is acceptable for 60% API call reduction
- Streaming must work (internet stability check)
- API call reduction shows batching is effective

---

## Pass/Fail Logic

### Automatic PASS
All conditions must be true:
```
1. Debate V2 p99 latency <= baseline + 10%
2. Debate V2 error rate < 1%
3. Debate V2 fallback rate < 2%
4. Cache V2 hit rate >= baseline - 5%
5. Cache V2 eviction rate < 30%
6. AI Client V2 batch overhead <= baseline + 20%
7. AI Client V2 stream completion > 95%
```

### Automatic FAIL
If any condition fails, gate blocks merge.

---

## Force Override

**When to override:**
- Threshold regression is within acceptable risk (e.g., +12% latency for new feature)
- Root cause understood and documented
- PI has approved the risk

**How to override:**
1. PI comments on PR: `@ai-triad-bot gate-override REASON`
2. Reason must explain why regression is acceptable
3. Commit message includes override: `Gate-Override: <reason>`
4. Merge queue runs final checks (build, deploy)

**Example override:**
```
Gate-Override: Cache hit rate at 74% due to cold-start effect during
soak test. Expected to stabilize to 80%+ in production over first hour.
Root cause: TTL misalignment with test data freshness. Fix pending in
t/1234. Approved by PI for production rollout.
```

---

## Tuning Thresholds

To adjust thresholds:

1. **Proposal:** Comment on t/23 (gate ticket) with new values and rationale
2. **Approval:** PI reviews and approves
3. **Change:** Update `lib/regression-detector.ts` (const values)
4. **Test:** Dry-run gate on test soak results
5. **Land:** Merge to main, effective on next soak test

**Current maintainer:** Platform Team  
**Escalation:** PI, then principal architect

---

## Alert Rules (ApplicationInsights)

Separate from gate thresholds, these alerts fire during production:

| Alert | Trigger | Action |
|-------|---------|--------|
| Coherence Score Low | avg < 0.6 for 5m | Page oncall, check BDI grounding |
| Cache Hit Rate Drop | <70% for 15m | Review cache TTL, restart if needed |
| Error Rate Spike | >1% for 10m | Disable flag, fallback to v1 |
| Latency Spike | p99 > 150ms for 5m | Investigate backend, check load |
| Fallback Rate High | >2% for 10m | Debug v2 issues, gather logs |

**Escalation path:**
1. ApplicationInsights alert fires
2. Oncall paged (if critical)
3. Debug via KQL queries (see MONITORING_KQL_QUERIES.md)
4. If unresolved after 30min: disable flag, open incident

---

## Gate Workflow (.github/workflows/gate-performance.yml)

**Triggered by:** Soak test completion  
**Inputs:** Soak results (JSONL), baseline metrics  
**Outputs:** PR comment (pass/fail), merge status (blocked if fail)

**Steps:**
1. Download soak results from artifacts
2. Load baseline from docs/BASELINE_METRICS_PHASE2_2026_11_08.json
3. Run `regression-detector` (lib/regression-detector.ts)
4. Format report via `formatRegressionReport`
5. Post to PR as comment
6. Set commit status:
   - PASS: `status: success`
   - FAIL: `status: failure` (blocks merge queue)
7. If override: check for PI override comment, skip fail if found

**Failure handling:**
- CI gate is required status check (cannot merge without pass)
- Force push to override NOT allowed (security: audit trail required)
- Manual override via GitHub UI after PI approval

---

## Testing the Gate

**Dry-run on test data:**
```bash
npm run test:gate -- \
  --baseline docs/BASELINE_METRICS_PHASE2_2026_11_08.json \
  --soak-results test-data/soak-2h-sample.jsonl \
  --format json
```

**Output:**
```json
{
  "passed": true,
  "regressions": [],
  "metrics": { ... },
  "summary": "✅ All checks passed..."
}
```

---

## FAQ

**Q: Why is threshold +10% for debate latency?**  
A: BDI grounding adds overhead for state tracking. 10% is acceptable for safety improvement. If >10%, investigate coherence scoring algorithm.

**Q: Can I adjust thresholds during production?**  
A: No. Thresholds are frozen during rollout. Changes require PR + code review to maintain audit trail.

**Q: What if soak test is interrupted?**  
A: Gate waits for complete results. Partial results = FAIL (conservative).

**Q: Can we run gate on v1-only baseline?**  
A: No. Gate requires both baseline (v1) and soak results (v2) to compare.

**Q: Who owns the gate?**  
A: Platform Team (gate logic + CI workflow). Phase 3 agents (integration, monitoring, ci-gates) document and maintain gate criteria.

---

## Related

- `MONITORING_KQL_QUERIES.md` — Query telemetry for deep dives
- `PHASE_2_GATE_CRITERIA.md` — High-level gate approval strategy
- `lib/regression-detector.ts` — Gate detection logic
- `docs/BASELINE_METRICS_PHASE2_2026_11_08.json` — Baseline data

---

**Approval:** t/21 (Phase 3 parent), t/23 (agent-ci-gates)  
**Go-live:** 2026-11-13 (after Phase 2 Gate passes)
