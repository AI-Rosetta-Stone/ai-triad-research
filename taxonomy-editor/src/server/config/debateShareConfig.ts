// Debate share configuration (t/4788). Each value is env-overridable, matching the
// chat-share config pattern (t/4787, SO review p/835#21) — no bare hardcoded constants.
//
// No MAX_MESSAGES/MAX_TOTAL_CHARS analog here: unlike chat (client-supplied body, K7/D1),
// a debate share's content is loaded server-side from an already-persisted, already-bounded
// debate session (SO D1, p/835#36) — there's no client-abuse surface to size-cap.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const DEBATE_SHARE_CONFIG = {
  MAX_ACTIVE: envInt('DEBATE_SHARE_MAX_ACTIVE', 20),
  CREATES_PER_HOUR: envInt('DEBATE_SHARE_CREATES_PER_HOUR', 5),
  TTL_DAYS: envInt('DEBATE_SHARE_TTL_DAYS', 30),
  PUBLIC_READ_PER_HOUR: envInt('DEBATE_SHARE_PUBLIC_READ_PER_HOUR', 100),
};
