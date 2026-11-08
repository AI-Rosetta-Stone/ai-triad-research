// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * T3.3 Phase 3: Regression Detection Engine
 *
 * Compares Phase 2 (v2) performance vs Phase 1 (v1) baseline.
 * Used by CI gate to block merges if regression detected.
 *
 * Thresholds (can be tuned):
 * - Debate: p99 latency increase >10% = FAIL
 * - Cache: hit rate drop >5% = FAIL
 * - AI Client: batch overhead >20% = FAIL
 */

export interface BaselineMetrics {
  debate_v1_p99ms: number;
  cache_hit_rate: number;
  ai_client_batch_overhead_pct: number;
}

export interface SoakTestMetrics {
  debate_v2_p99ms: number;
  cache_hit_rate: number;
  ai_client_batch_overhead_pct: number;
  error_rate_pct: number;
  fallback_to_v1_pct: number;
}

export interface RegressionReport {
  passed: boolean;
  regressions: Regression[];
  metrics: {
    debate: DebateMetricComparison;
    cache: CacheMetricComparison;
    aiClient: AIClientMetricComparison;
  };
  summary: string;
}

export interface Regression {
  feature: string;
  metric: string;
  baseline: number;
  current: number;
  change_pct: number;
  threshold_pct: number;
  severity: 'critical' | 'warning';
}

export interface DebateMetricComparison {
  v1_p99ms: number;
  v2_p99ms: number;
  change_pct: number;
  threshold_pct: number;
  passed: boolean;
}

export interface CacheMetricComparison {
  baseline_hit_rate: number;
  current_hit_rate: number;
  change_pct: number;
  threshold_pct: number;
  passed: boolean;
}

export interface AIClientMetricComparison {
  baseline_overhead_pct: number;
  current_overhead_pct: number;
  change_pct: number;
  threshold_pct: number;
  passed: boolean;
}

/**
 * Detect regressions by comparing soak results vs baseline
 */
export function detectRegressions(
  baseline: BaselineMetrics,
  soakResults: SoakTestMetrics,
): RegressionReport {
  const regressions: Regression[] = [];

  // ─────────────────────────────────────────────────
  // Debate Engine: p99 latency
  // ─────────────────────────────────────────────────

  const debateChange =
    ((soakResults.debate_v2_p99ms - baseline.debate_v1_p99ms) / baseline.debate_v1_p99ms) * 100;
  const debateThreshold = 10; // Max 10% increase

  const debatePassed = debateChange <= debateThreshold;
  if (!debatePassed) {
    regressions.push({
      feature: 'Debate Engine V2',
      metric: 'p99 latency',
      baseline: baseline.debate_v1_p99ms,
      current: soakResults.debate_v2_p99ms,
      change_pct: debateChange,
      threshold_pct: debateThreshold,
      severity: debateChange > 20 ? 'critical' : 'warning',
    });
  }

  // ─────────────────────────────────────────────────
  // Taxonomy Cache: hit rate
  // ─────────────────────────────────────────────────

  const cacheChange = soakResults.cache_hit_rate - baseline.cache_hit_rate;
  const cacheThreshold = -5; // Max 5% drop

  const cachePassed = cacheChange >= cacheThreshold;
  if (!cachePassed) {
    regressions.push({
      feature: 'Taxonomy Cache V2',
      metric: 'hit rate',
      baseline: baseline.cache_hit_rate,
      current: soakResults.cache_hit_rate,
      change_pct: cacheChange,
      threshold_pct: cacheThreshold,
      severity: cacheChange < -10 ? 'critical' : 'warning',
    });
  }

  // ─────────────────────────────────────────────────
  // AI Client: batch overhead
  // ─────────────────────────────────────────────────

  const aiChange = soakResults.ai_client_batch_overhead_pct - baseline.ai_client_batch_overhead_pct;
  const aiThreshold = 20; // Max 20% increase

  const aiPassed = aiChange <= aiThreshold;
  if (!aiPassed) {
    regressions.push({
      feature: 'AI Client V2',
      metric: 'batch overhead',
      baseline: baseline.ai_client_batch_overhead_pct,
      current: soakResults.ai_client_batch_overhead_pct,
      change_pct: aiChange,
      threshold_pct: aiThreshold,
      severity: aiChange > 50 ? 'critical' : 'warning',
    });
  }

  // ─────────────────────────────────────────────────
  // Error rate check
  // ─────────────────────────────────────────────────

  const errorThreshold = 1; // Max 1% error rate
  const errorPassed = soakResults.error_rate_pct <= errorThreshold;
  if (!errorPassed) {
    regressions.push({
      feature: 'Overall',
      metric: 'error rate',
      baseline: 0,
      current: soakResults.error_rate_pct,
      change_pct: soakResults.error_rate_pct,
      threshold_pct: errorThreshold,
      severity: soakResults.error_rate_pct > 5 ? 'critical' : 'warning',
    });
  }

  // ─────────────────────────────────────────────────
  // Fallback rate check
  // ─────────────────────────────────────────────────

  const fallbackThreshold = 2; // Max 2% fallback
  const fallbackPassed = soakResults.fallback_to_v1_pct <= fallbackThreshold;
  if (!fallbackPassed) {
    regressions.push({
      feature: 'Overall',
      metric: 'v1 fallback rate',
      baseline: 0,
      current: soakResults.fallback_to_v1_pct,
      change_pct: soakResults.fallback_to_v1_pct,
      threshold_pct: fallbackThreshold,
      severity: 'warning',
    });
  }

  // ─────────────────────────────────────────────────
  // Overall verdict
  // ─────────────────────────────────────────────────

  const passed =
    [debatePassed, cachePassed, aiPassed, errorPassed, fallbackPassed].every(Boolean) &&
    regressions.length === 0;

  const summary = passed
    ? '✅ All checks passed. Phase 2 ready for gate approval.'
    : `❌ ${regressions.length} regression(s) detected. Investigate before approval.`;

  return {
    passed,
    regressions,
    metrics: {
      debate: {
        v1_p99ms: baseline.debate_v1_p99ms,
        v2_p99ms: soakResults.debate_v2_p99ms,
        change_pct: debateChange,
        threshold_pct: debateThreshold,
        passed: debatePassed,
      },
      cache: {
        baseline_hit_rate: baseline.cache_hit_rate,
        current_hit_rate: soakResults.cache_hit_rate,
        change_pct: cacheChange,
        threshold_pct: cacheThreshold,
        passed: cachePassed,
      },
      aiClient: {
        baseline_overhead_pct: baseline.ai_client_batch_overhead_pct,
        current_overhead_pct: soakResults.ai_client_batch_overhead_pct,
        change_pct: aiChange,
        threshold_pct: aiThreshold,
        passed: aiPassed,
      },
    },
    summary,
  };
}

/**
 * Format report for GitHub PR comment
 */
export function formatRegressionReport(report: RegressionReport): string {
  const icon = report.passed ? '✅' : '❌';

  let md = `## ${icon} Phase 2 Gate Report\n\n`;
  md += `${report.summary}\n\n`;

  if (report.regressions.length > 0) {
    md += '### Regressions Detected\n\n';
    md += '| Feature | Metric | Baseline | Current | Change | Severity |\n';
    md += '|---------|--------|----------|---------|--------|----------|\n';

    for (const reg of report.regressions) {
      const severity_icon = reg.severity === 'critical' ? '🔴' : '🟡';
      md += `| ${reg.feature} | ${reg.metric} | ${reg.baseline.toFixed(2)} | ${reg.current.toFixed(2)} | ${reg.change_pct > 0 ? '+' : ''}${reg.change_pct.toFixed(1)}% | ${severity_icon} ${reg.severity} |\n`;
    }

    md += '\n';
  }

  md += '### Metrics Comparison\n\n';
  md += '#### Debate Engine V2\n';
  md += `- Baseline (V1): ${report.metrics.debate.v1_p99ms.toFixed(2)}ms (p99)\n`;
  md += `- Current (V2): ${report.metrics.debate.v2_p99ms.toFixed(2)}ms (p99)\n`;
  md += `- Change: ${report.metrics.debate.change_pct > 0 ? '+' : ''}${report.metrics.debate.change_pct.toFixed(1)}% (threshold: ${report.metrics.debate.threshold_pct}%)\n`;
  md += `- Status: ${report.metrics.debate.passed ? '✅ PASS' : '❌ FAIL'}\n\n`;

  md += '#### Taxonomy Cache V2\n';
  md += `- Baseline Hit Rate: ${report.metrics.cache.baseline_hit_rate.toFixed(1)}%\n`;
  md += `- Current Hit Rate: ${report.metrics.cache.current_hit_rate.toFixed(1)}%\n`;
  md += `- Change: ${report.metrics.cache.change_pct > 0 ? '+' : ''}${report.metrics.cache.change_pct.toFixed(1)}% (threshold: ${report.metrics.cache.threshold_pct}%)\n`;
  md += `- Status: ${report.metrics.cache.passed ? '✅ PASS' : '❌ FAIL'}\n\n`;

  md += '#### AI Client V2\n';
  md += `- Baseline Batch Overhead: ${report.metrics.aiClient.baseline_overhead_pct.toFixed(1)}%\n`;
  md += `- Current Batch Overhead: ${report.metrics.aiClient.current_overhead_pct.toFixed(1)}%\n`;
  md += `- Change: ${report.metrics.aiClient.change_pct > 0 ? '+' : ''}${report.metrics.aiClient.change_pct.toFixed(1)}% (threshold: ${report.metrics.aiClient.threshold_pct}%)\n`;
  md += `- Status: ${report.metrics.aiClient.passed ? '✅ PASS' : '❌ FAIL'}\n\n`;

  if (report.passed) {
    md += '### ✅ Gate Status: APPROVED\n';
    md += 'Phase 2 features are ready for production rollout. Proceed with flag enablement.\n';
  } else {
    md += '### ❌ Gate Status: BLOCKED\n';
    md += 'Regressions detected. Review metrics above and investigate before re-running gate.\n';
  }

  return md;
}
