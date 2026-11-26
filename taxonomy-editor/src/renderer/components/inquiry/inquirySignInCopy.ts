// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/719: Design's copy (p/25#201) for an anonymous visitor on Ask a Question, verbatim. The server refuses
// anonymous asks by design (403 anon_route_blocked), so the page offers sign-in instead of the action.

/** In place of the example questions. */
export const INQUIRY_ANON_NOTICE = 'Sign in to ask your own questions. You can read questions others have shared in Community.';

/** In the New question dialog when the server refuses an ask as anonymous (a session that ended while it was open). */
export const INQUIRY_SESSION_ENDED_LINE = 'Your session has ended. Sign in to ask a question.';
