// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4410 item D (PI decision D, p/548#316): the data-use disclosure for users served by the free Gemini pool.
// The wording is checked by the TL against Google's current Gemini API terms (t/4410#5). Change it only through
// that ticket: this is the one place the copy lives, shared by the banner and the key-settings line.

export const GEMINI_TERMS_URL = 'https://ai.google.dev/gemini-api/terms';

export const FREE_TIER_NOTICE = {
  title: 'About the free AI access',
  body:
    "You're using free Gemini access that this site provides. With Google's free tier, Google may use what you send " +
    '(your prompts, plus any text the site includes with them) and the responses to improve its products, and human ' +
    "reviewers may read them. Please don't include confidential or personal information.",
  remedy: 'To keep your prompts out of this, add your own Gemini API key from a Google Cloud project with billing enabled.',
  addKey: 'Add a key',
  acknowledge: 'Got it',
  terms: "Google's terms",
} as const;

/** The line for the key-settings page. */
export const FREE_TIER_SETTINGS_LINE =
  'Without your own key, AI features use free Gemini access, and Google may use those prompts and responses to ' +
  'improve its products. A key from a billing-enabled Google project avoids this.';
