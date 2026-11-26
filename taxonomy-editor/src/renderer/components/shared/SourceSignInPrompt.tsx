// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/678 (PI decision 5e): shown in place of a source's full text or file when the server says sign-in is required.
// Titles, summaries, quotes and publisher links stay visible elsewhere; only the full text is behind sign-in.
import './SourceSignInPrompt.css';

export const SOURCE_SIGN_IN_LINE = 'Sign in to read the full text of this source. The title, summary, key quotes and publisher link are available without signing in.';

export function SourceSignInPrompt() {
  return (
    <div className="source-signin-prompt" role="note">
      <p className="source-signin-prompt-line">{SOURCE_SIGN_IN_LINE}</p>
      <div className="source-signin-prompt-links">
        <a href="/api/auth/fresh-login/github" className="source-signin-prompt-link">Sign in with GitHub</a>
        <a href="/api/auth/fresh-login/google" className="source-signin-prompt-link">Sign in with Google</a>
      </div>
    </div>
  );
}
