# Token Telemetry Setup

Claude Code can export token usage through OpenTelemetry. Agents cannot edit `.claude/settings.json`, so the PI must add the block below. Verify every variable name against the Claude Code monitoring docs before saving.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318"
  }
}
```

The endpoint is a placeholder: point it at whatever OTLP collector or backend the PI chooses. For a quick local check, `OTEL_METRICS_EXPORTER=console` prints metrics to the terminal.

## Reading tokens per role

Claude Code emits a token-usage counter with attributes for token type (input, output, cache read, cache creation) and model. To attribute usage to a role, set a per-role resource attribute (for example `OTEL_RESOURCE_ATTRIBUTES=role=devops`) in each role's launch environment, then group the counter by that attribute. Verify the metric and attribute names against the monitoring docs.

## Weekly tracking

The Historian records `tokens_per_merged_pr` weekly: total tokens in the week divided by PRs merged to `main` that week. Compare week over week to judge whether the token-reduction workstreams are working.
