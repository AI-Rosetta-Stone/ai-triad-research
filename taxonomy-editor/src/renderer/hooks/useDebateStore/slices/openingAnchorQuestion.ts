// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DebateSession } from '../../../types/debate';

/** t/284 item 3: the question an opening must answer. Only inquiry debates carry it; others get undefined. */
export function openingAnchorQuestion(activeDebate: Pick<DebateSession, 'origin'>, topic: string): string | undefined {
  return activeDebate.origin?.mode === 'inquiry' ? topic : undefined;
}
