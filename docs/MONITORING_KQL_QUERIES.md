# Phase 2 Monitoring: KQL Queries

ApplicationInsights KQL queries for Phase 2 telemetry. Use these in the Azure Portal to track feature behavior.

**Related:** `lib/events-schema.ts`, `lib/telemetry-client.ts`

---

## Query 1: Debate Engine V2 — Coherence Score Distribution

Track BDI coherence scores across all debate sessions.

```kusto
customEvents
| where name == "phase2_coherence_computed"
| extend score = todouble(tostring(customDimensions.score))
| summarize 
    AvgScore = avg(score),
    P50Score = percentile(score, 50),
    P99Score = percentile(score, 99),
    Count = count()
    by bin(timestamp, 1h)
| render timechart
```

**Interpretation:**
- **AvgScore:** Mean coherence (target: >0.65)
- **P99Score:** 99th percentile (outliers show problematic debates)
- **Count:** Debate volume per hour

---

## Query 2: Taxonomy Cache V2 — Hit Rate Over Time

Track cache effectiveness (hit % vs miss %).

```kusto
customEvents
| where name in ("phase2_cache_hit", "phase2_cache_miss")
| extend hitOrMiss = case(
    name == "phase2_cache_hit", "hit",
    name == "phase2_cache_miss", "miss",
    "unknown")
| summarize
    Hits = countif(hitOrMiss == "hit"),
    Misses = countif(hitOrMiss == "miss"),
    HitRate = (countif(hitOrMiss == "hit") / count()) * 100
    by bin(timestamp, 5m)
| render timechart
```

**Interpretation:**
- **HitRate:** % of cache hits (target: >75%)
- **Hits/Misses:** Absolute counts
- **Trends:** Decreasing hit rate signals cache pollution or TTL issues

---

## Query 3: AI Client V2 — Batch Size Histogram

Track batch sizes (batching effectiveness).

```kusto
customEvents
| where name == "phase2_batch_sent"
| extend batchSize = toint(tostring(customDimensions.batchSize))
| summarize
    AvgBatchSize = avg(batchSize),
    MinBatch = min(batchSize),
    MaxBatch = max(batchSize),
    P95Batch = percentile(batchSize, 95),
    Count = count()
    by bin(timestamp, 1h)
| render timechart
```

**Interpretation:**
- **AvgBatchSize:** Mean requests per batch (target: 8-10)
- **P95Batch:** 95th percentile (outliers = long timeouts or high load)
- **Count:** Batches sent per hour

---

## Query 4: Error Rates by Feature

Track fallback-to-v1 events (error severity).

```kusto
customEvents
| where name in (
    "phase2_debate_engine_error",
    "phase2_ai_client_error",
    "phase2_cache_error")
| extend
    errorMessage = tostring(customDimensions.errorMessage),
    fallbackToV1 = tobool(tostring(customDimensions.fallbackToV1))
| summarize
    TotalErrors = count(),
    FallbackCount = countif(fallbackToV1 == true),
    FallbackRate = (countif(fallbackToV1 == true) / count()) * 100
    by name, bin(timestamp, 1h)
| render barchart
```

**Interpretation:**
- **FallbackRate:** % of errors that require v1 fallback (target: <1%)
- **TotalErrors:** Error volume (should be near zero in healthy state)
- **Trends:** Increasing errors signal regression or configuration issue

---

## Query 5: Latency Breakdown — All Phase 2 Operations

Compare v1 vs v2 latency.

```kusto
customMetrics
| where name in (
    "phase2_debate_enrichment_p99",
    "phase2_ai_batch_p99",
    "phase2_cache_lookup_p99")
| summarize
    AvgLatency = avg(value),
    MaxLatency = max(value),
    P99Latency = percentile(value, 99)
    by name, bin(timestamp, 5m)
| render timechart
```

**Interpretation:**
- **P99Latency:** 99th percentile (critical for SLA)
- **MaxLatency:** Worst-case (detect spikes/outages)
- **Targets:**
  - Debate enrichment: <50ms p99
  - AI batch: <200ms p99
  - Cache lookup: <2ms p99

---

## Query 6: Streaming Completeness

Track AI Client V2 streaming success rate.

```kusto
customEvents
| where name == "phase2_streaming_started"
| extend streamId = tostring(customDimensions.streamId)
| join kind=leftouter (
    customEvents
    | where name == "phase2_streaming_complete"
    | extend streamId = tostring(customDimensions.streamId)
  ) on streamId
| summarize
    StreamsStarted = count(),
    StreamsCompleted = countif(name1 != ""),
    CompletionRate = (countif(name1 != "") / count()) * 100
    by bin(timestamp, 1h)
| render timechart
```

**Interpretation:**
- **CompletionRate:** % of streams that finish (target: >99%)
- **Incomplete streams:** Check logs for truncation/timeout
- **Trends:** Decreasing rate signals network or model issues

---

## Query 7: Session-Level Performance Summary

Overall Phase 2 health per debate session.

```kusto
customEvents
| where name startswith "phase2_"
| summarize
    EventCount = count(),
    UniqueErrors = dcount(tostring(customDimensions.errorMessage)),
    AvgEnrichmentMs = avg(todouble(tostring(customDimensions.durationMs))),
    CacheHitRate = (countif(name == "phase2_cache_hit") / (countif(name in ("phase2_cache_hit", "phase2_cache_miss")) + 1)) * 100,
    FallbackEvents = countif(tostring(customDimensions.fallbackToV1) == "true")
    by tostring(customDimensions.sessionId), bin(timestamp, 1h)
| render table
```

**Interpretation:**
- **EventCount:** Activity level (high = busy session)
- **UniqueErrors:** Error diversity (high = instability)
- **AvgEnrichmentMs:** Baseline comparison point
- **CacheHitRate:** Cache effectiveness
- **FallbackEvents:** Rollback count

---

## Query 8: Deployment Impact Check

Compare metrics before/after feature flag flip.

```kusto
customMetrics
| where name == "phase2_debate_enrichment_p99"
| summarize
    P99Latency = percentile(value, 99),
    Count = count(),
    Window = bin(timestamp, 1h)
    by Window
| order by Window
```

**Use:**
1. Run query for hour before flag change
2. Run query for hour after flag change
3. If P99 increase >10%, rollback or investigate

---

## Query 9: Disk/Memory Usage (if logging available)

Track resource consumption during Phase 2 operations.

```kusto
performanceCounters
| where name in (
    "Process\\Private Bytes",
    "Process\\Working Set")
| summarize
    AvgMemoryMB = avg(value) / (1024 * 1024),
    MaxMemoryMB = max(value) / (1024 * 1024),
    P99MemoryMB = percentile(value, 99) / (1024 * 1024)
    by bin(timestamp, 1h), name
| render timechart
```

**Interpretation:**
- **Memory growth:** Should be flat (stable)
- **Spikes:** Check for cache evictions or AI batch buildup

---

## Query 10: Comparison: V2 Enabled vs Disabled

Isolate Phase 2 events from background traffic.

```kusto
customEvents
| where name startswith "phase2_"
| summarize
    Events = count(),
    AvgDuration = avg(todouble(tostring(customDimensions.durationMs)))
    by name
| render barchart
```

**Use to verify:**
- All event types firing
- Durations reasonable (no outliers)
- No events stuck in backlog

---

## Setting Alerts

Recommended ApplicationInsights alerts:

| Alert | Condition | Threshold | Action |
|-------|-----------|-----------|--------|
| Coherence Score Low | avg(coherence_computed.score) < 0.6 | 5m window | Investigate BDI grounding |
| Cache Hit Rate Drop | cache_hit_rate < 70% | 15m window | Check TTL/size limits |
| Fallback Rate High | fallback_to_v1 / total > 1% | 10m window | Rollback Phase 2 flag |
| Latency Spike | debate_enrichment_p99 > 100ms | 5m avg | Investigate backend |
| Stream Incomplete | streaming_complete / streaming_started < 99% | 30m window | Check network/model |

---

## Running Queries

**In Azure Portal:**
1. Open ApplicationInsights resource
2. Go to **Logs** (Kusto query editor)
3. Paste query above
4. Click **Run**

**In Azure CLI:**
```bash
az monitor app-insights query \
  --resource GROUP/NAME \
  --analytics-query 'customEvents | where name startswith "phase2_" | count'
```

---

**Last Updated:** 2026-11-08  
**Related Docs:** `PHASE_2_GATE_CRITERIA.md`, `lib/telemetry-client.ts`
