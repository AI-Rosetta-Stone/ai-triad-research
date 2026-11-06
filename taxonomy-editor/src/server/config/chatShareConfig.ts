// Chat share configuration (t/4787). Each value is env-overridable, matching the
// pattern in config.ts (e.g. AI_TRIAD_DATA_ROOT) — SO review (p/835#21) flagged the
// prior version as hardcoded constants with no deployment-time override path.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CHAT_SHARE_CONFIG = {
  MAX_ACTIVE: envInt('CHAT_SHARE_MAX_ACTIVE', 20),
  CREATES_PER_HOUR: envInt('CHAT_SHARE_CREATES_PER_HOUR', 5),
  TTL_DAYS: envInt('CHAT_SHARE_TTL_DAYS', 30),
  PUBLIC_READ_PER_HOUR: envInt('CHAT_SHARE_PUBLIC_READ_PER_HOUR', 100),
  MAX_MESSAGES: envInt('CHAT_SHARE_MAX_MESSAGES', 500),
  MAX_TOTAL_CHARS: envInt('CHAT_SHARE_MAX_TOTAL_CHARS', 1_000_000),
};
