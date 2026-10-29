// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure Fisher–Yates partial-shuffle pick (t/4633) — shared by every library-page tool's
 * getting-started card (Chat, Op-Ed Studies, Ask a Question, Debate) so each can keep a pool of
 * 15 example chips and show a random, non-repeating subset per visit.
 *
 * `rng` is injectable for seeded, deterministic tests. `mustInclude`, when given, guarantees at
 * least one returned item satisfies it — but only when the pool actually has one; it never
 * invents a match. `pool.length <= count` returns every item, in a fresh array (never the pool's
 * own array reference, so a caller can't accidentally mutate the pool through the result).
 */
export function pickExamples<T>(
  pool: readonly T[],
  count: number,
  rng: () => number = Math.random,
  mustInclude?: (item: T) => boolean,
): T[] {
  if (pool.length <= count) return [...pool];

  const shuffled = [...pool];
  const picks = Math.max(0, Math.min(count, shuffled.length));
  for (let i = 0; i < picks; i++) {
    const j = i + Math.floor(rng() * (shuffled.length - i));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const result = shuffled.slice(0, picks);

  if (mustInclude && !result.some(mustInclude)) {
    const forced = pool.find(mustInclude);
    if (forced !== undefined && result.length > 0) {
      result[result.length - 1] = forced;
    }
  }

  return result;
}
