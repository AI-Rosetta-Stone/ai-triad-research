import type { EmbeddingsFile } from '../electron-shared/embeddingIO.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { ActionableError, errorMessage } from '../debate/errors.js';

export interface EmbeddingFallback {
  name: string;
  compute: (texts: string[], ids?: string[]) => Promise<number[][]>;
}

/** The most characters of one backend's failure reason carried in the chain-exhaustion error (t/716). */
const FAILURE_REASON_MAX_CHARS = 300;

interface FallbackFailure {
  name: string;
  reason: string;
  code?: string;
}

/** One backend's failure as a single bounded line, plus its stable code when it has one (t/716). */
function describeFailure(name: string, err: unknown): FallbackFailure {
  const text = (err instanceof ActionableError ? err.problem : errorMessage(err)).replace(/\s+/g, ' ').trim();
  const reason = text.length > FAILURE_REASON_MAX_CHARS ? `${text.slice(0, FAILURE_REASON_MAX_CHARS)}…` : text;
  const code = (err as { code?: unknown } | null)?.code;
  return { name, reason, ...(typeof code === 'string' && { code }) };
}

/** The code every failed backend shares, e.g. a load-shed; undefined when they differ or have none (t/716). */
function sharedCode(failures: FallbackFailure[]): string | undefined {
  const first = failures[0]?.code;
  return first !== undefined && failures.every(f => f.code === first) ? first : undefined;
}

/**
 * The error for a chain whose every backend failed. An ActionableError (not a bare throw) so the upstream
 * catch/triage doesn't misattribute this to an unrelated cause (e.g. "ONNX init failure"): the real cause is
 * chain exhaustion. (e/134 #3; root AGENTS.md error-handling convention.)
 * t/716: each member's own reason is carried in `problem`. The ai.fallback WARN records go to the
 * flight-recorder ring only, never stdout, so a hosted log showed the exhaustion with no cause.
 * A code every member shares (a worker-pool shed) is kept, so a caller can tell a shed from a fault.
 */
function exhaustionError(fallbackChain: EmbeddingFallback[], failures: FallbackFailure[]): ActionableError {
  const tried = fallbackChain.length ? fallbackChain.map(f => f.name).join(', ') : '(empty chain)';
  const reasons = failures.map(f => `${f.name}: ${f.reason}`).join('; ');
  return new ActionableError({
    goal: 'Resolve embeddings for the requested texts',
    problem: `All embedding fallbacks failed (tried: ${tried})${reasons ? `. ${reasons}` : ''}`,
    location: 'lib/embeddings/embeddingResolver.ts resolveEmbeddings',
    nextSteps: [
      'Read each backend’s reason in this error; the ai.fallback WARN records in the flight-recorder dump carry the same failures',
      'Ensure at least one embedding backend is available: provision the ONNX model, install Python sentence-transformers, or set a Gemini API key',
      'Retry once a backend is restored',
    ],
    code: sharedCode(failures),
  });
}

export async function resolveEmbeddings(
  texts: string[],
  ids: string[] | undefined,
  localData: EmbeddingsFile | null,
  fallbackChain: EmbeddingFallback[],
): Promise<number[][]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  const missingIndices: number[] = [];

  if (ids && localData) {
    for (let i = 0; i < texts.length; i++) {
      const nodeId = ids[i];
      if (nodeId && localData.nodes[nodeId]) {
        results[i] = localData.nodes[nodeId].vector;
      } else {
        missingIndices.push(i);
      }
    }
  } else {
    for (let i = 0; i < texts.length; i++) {
      missingIndices.push(i);
    }
  }

  if (missingIndices.length > 0) {
    const missingTexts = missingIndices.map(i => texts[i]);
    const missingIds = ids ? missingIndices.map(i => ids[i]) : undefined;
    let computed: number[][] | null = null;
    const failures: FallbackFailure[] = [];

    getGlobalRecorder()?.record({
      type: 'ai.request',
      component: 'embedding-resolver',
      level: 'info',
      message: 'computing embeddings',
      data: { chainMembers: fallbackChain.map(f => f.name) },
    });

    for (const fallback of fallbackChain) {
      try {
        computed = await fallback.compute(missingTexts, missingIds);
        break;
      } catch (err) {
        failures.push(describeFailure(fallback.name, err));
        getGlobalRecorder()?.record({
          type: 'ai.fallback',
          component: 'embedding-resolver',
          level: 'warn',
          message: `Embedding fallback "${fallback.name}" failed, trying next`,
          data: { chainMembers: fallbackChain.map(f => f.name) },
          error: { name: (err as Error).name ?? 'Error', message: String(err) },
        });
      }
    }

    if (!computed) throw exhaustionError(fallbackChain, failures);

    for (let j = 0; j < missingIndices.length; j++) {
      results[missingIndices[j]] = computed[j];
    }
  }

  return results as number[][];
}
