// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Standardized actionable error for humans and AI agents.
 * Every error must state: goal, problem, location, and next steps.
 *
 * ## Convention: re-wrapping a caught error
 * Pass the original as `innerError`; never copy a caught error's `.message`
 * into `problem`. Write a fresh one-line `problem` for this layer's context.
 * When you need the inner text inline:
 *   `err instanceof ActionableError ? err.problem : errorMessage(err)`
 * Never use `.message` directly — it is the multi-line formatted block.
 *
 * ## Convention: user-facing display
 * UI code never renders `.message`. Use `mapErrorToUserMessage(err)`
 * (renderer/utils/errorMessages.ts), which already prefers `.problem`.
 */
export class ActionableError extends Error {
  public readonly goal: string;
  public readonly problem: string;
  public readonly location: string;
  public readonly nextSteps: string[];
  public readonly innerError?: Error;
  public httpStatus?: number;
  public readonly code?: string;

  constructor(opts: {
    goal: string;
    problem: string;
    location: string;
    nextSteps: string[];
    innerError?: unknown;
    httpStatus?: number;
    code?: string;
  }) {
    const inner = opts.innerError instanceof Error ? opts.innerError : undefined;
    const innerMsg = inner ? `\n  Inner error: ${inner.message}` : '';
    const steps = opts.nextSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n');

    const message = [
      '',
      `  Goal:     ${opts.goal}`,
      `  Error:    ${opts.problem}${innerMsg}`,
      `  Location: ${opts.location}`,
      `  Resolve:`,
      steps,
    ].join('\n');

    super(message);
    this.name = 'ActionableError';
    this.goal = opts.goal;
    this.problem = opts.problem;
    this.location = opts.location;
    this.nextSteps = opts.nextSteps;
    this.innerError = inner;
    this.httpStatus = opts.httpStatus;
    this.code = opts.code;

    // Maintain prototype chain for instanceof checks
    Object.setPrototypeOf(this, ActionableError.prototype);
  }
}

/**
 * Extract a message from an unknown caught value.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

