// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// A neutral notice with the two sign-in links, shown where an anonymous visitor would otherwise meet a refused
// action (t/678's source prompt, t/719's Ask a Question). The line is the caller's; the links are the same everywhere.
import './SourceSignInPrompt.css';

export function SignInNotice({ line, role = 'note' }: { line: string; role?: 'note' | 'alert' }) {
  return (
    <div className="source-signin-prompt" role={role}>
      <p className="source-signin-prompt-line">{line}</p>
      <div className="source-signin-prompt-links">
        <a href="/api/auth/fresh-login/github" className="source-signin-prompt-link">Sign in with GitHub</a>
        <a href="/api/auth/fresh-login/google" className="source-signin-prompt-link">Sign in with Google</a>
      </div>
    </div>
  );
}
