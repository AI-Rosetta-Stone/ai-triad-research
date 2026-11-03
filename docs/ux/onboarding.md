# First-Time User Onboarding — UX Spec

**Ticket:** t/664
**Author:** Design (Orca)
**Status:** Superseded. The Welcome Tour overlay (`OnboardingTour`) and the Help dialog's "Welcome Tour" tab are retired. Their content now lives on the **Rosetta Stone** home page (`RosettaStoneTab.tsx`, t/4542), which is the top item in the left rail and opens on launch. The PI confirmed this replacement on 2026-10-27. This document is kept for history only; don't implement from it.

## Overview

A guided walkthrough that introduces first-time users to the app's four main tools. Appears once after the FirstRunDialog completes (data is loaded). Each step shows a screenshot of the tool with a brief explanation. The final step covers Settings and the AI API key requirement.

## Trigger

Show the onboarding tour when **all** of these are true:
1. `localStorage.getItem('taxonomy-editor-onboarding-dismissed')` is not `'true'`
2. Taxonomy data is loaded and available (FirstRunDialog has completed or was skipped)
3. The app is on its first render after data becomes available

**Do not show** if the user already has an AI API key configured — they're not a first-time user.

Persistence key: `taxonomy-editor-onboarding-dismissed` → `'true'` when the user finishes or skips.

## Component

`OnboardingTour.tsx` — a full-screen modal overlay, same pattern as `FirstRunDialog` and `SettingsDialog` (uses `.dialog-overlay` backdrop).

Rendered in `App.tsx` after the existing `FirstRunDialog` conditional, before `SaveBar`:
```
{showOnboarding && <OnboardingTour onDismiss={() => setShowOnboarding(false)} />}
```

## Flow

Four steps, navigated with Next / Back / Skip:

```
 ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
 │ Step 1   │───▸│ Step 2   │───▸│ Step 3   │───▸│ Step 4   │
 │ Taxonomy │    │ Debates  │    │ Chat     │    │ Settings │
 └─────────┘    └─────────┘    └─────────┘    └─────────┘
```

## Layout

### Desktop (768px+)

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│   ┌──────────────────────────────────────────────┐   │
│   │                                              │   │
│   │   Welcome to the AI Triad Taxonomy Editor    │   │
│   │                                              │   │
│   │   ┌──────────────────────────────────────┐   │   │
│   │   │                                      │   │   │
│   │   │         (screenshot image)           │   │   │
│   │   │           480 x 300px                │   │   │
│   │   │                                      │   │   │
│   │   └──────────────────────────────────────┘   │   │
│   │                                              │   │
│   │   The Taxonomy Tool                          │   │
│   │                                              │   │
│   │   Browse and edit the three-perspective      │   │
│   │   taxonomy of AI policy positions...         │   │
│   │                                              │   │
│   │       ● ● ○ ○         [Back] [Next]          │   │
│   │                                  Skip tour → │   │
│   │                                              │   │
│   └──────────────────────────────────────────────┘   │
│                                                      │
└──────────────────────────────────────────────────────┘
  backdrop: semi-transparent overlay (existing .dialog-overlay)
```

**Card dimensions:** max-width `560px`, centered vertically and horizontally. Padding `32px`.

### Phone (<768px)

Same card but full-width with `16px` margin on each side. Screenshot scales to fill width. Text and buttons stack naturally.

## Step Content

### Step 1 — Taxonomy Tool

**Heading:** Explore the Taxonomy
**Screenshot:** The POV list panel showing a POV tab (Safetyist) with category groups expanded, a node selected, and the detail panel visible.

**Body:**
> Browse three distinct perspectives on AI policy — Accelerationist, Safetyist, and Skeptic. Each perspective is organized into Beliefs, Desires, and Intentions.
>
> Select any item to see its full description, related nodes, graph attributes, and source evidence.

### Step 2 — Debate Tool

**Heading:** Run AI Debates
**Screenshot:** The debate detail view showing a debate in progress with speaker cards (Accelerationist, Safetyist, Skeptic) and the conversation thread.

**Body:**
> Stage structured debates between AI-powered characters who argue from each perspective. Choose a topic, select debaters, and watch them engage in real-time.
>
> After a debate, the reflection tool analyzes results and proposes taxonomy edits based on what emerged.

**Badge (inline, muted):**
> Requires an AI API key

### Step 3 — Chat Tool

**Heading:** Chat with Perspectives
**Screenshot:** The chat interface showing a conversation with a POV character, mode selector (Brainstorm / Inform / Decide).

**Body:**
> Have one-on-one conversations with any perspective. Use Brainstorm mode to explore ideas, Inform mode to learn a position's reasoning, or Decide mode to work through a specific policy question.

**Badge (inline, muted):**
> Requires an AI API key

### Step 4 — Settings & API Key

**Heading:** Set Up Your AI Key
**Screenshot:** The Settings dialog with the AI Backend section visible, showing the backend dropdown set to "Gemini" and the API key input field.

**Body:**
> Some features — debates, chat, enrichment, and analysis — need an AI backend to work. Without a key, those features are read-only or unavailable.
>
> We recommend **Gemini Flash Lite** — it's fast, capable, and very inexpensive (free tier available).
>
> **Get a free API key:** [Google AI Studio](https://aistudio.google.com/apikey)
>
> Once you have a key, open **Settings** from the toolbar and paste it into the AI Backend section. Gemini is selected by default.

**CTA button:** Instead of "Next", this step shows **"Open Settings"** (opens SettingsDialog) and **"Done"** (dismisses tour).

## Step indicator

Four dots at the bottom-left of the card. Current step is filled (`●`), others are hollow (`○`). Clicking a dot navigates to that step.

```
● ● ○ ○
```

Style: `8px` circles, `6px` gap, current dot uses `var(--accent-color)`, inactive uses `var(--text-muted)` at 40% opacity.

## Navigation

| Element | Position | Behavior |
|---|---|---|
| **Next** | Bottom-right, primary button | Advances to next step. On step 4, label changes to "Done" |
| **Back** | Bottom-right, secondary button | Returns to previous step. Hidden on step 1 |
| **Skip tour →** | Below buttons, text link | Dismisses immediately. Muted text, `0.75rem` |
| **Step dots** | Bottom-left | Click to jump to any step |
| **Escape key** | N/A | Dismisses (same as Skip) |
| **Backdrop click** | Overlay area | Does NOT dismiss — prevents accidental closure |

## Screenshots

Screenshots are static images bundled with the app. Place in `taxonomy-editor/public/onboarding/`:
- `onboarding-taxonomy.png`
- `onboarding-debate.png`
- `onboarding-chat.png`
- `onboarding-settings.png`

Capture at 960x600 resolution, displayed at `max-width: 100%; height: auto` within the card. Use the light theme for all screenshots (neutral, highest contrast for first impression).

**Dark mode handling:** Screenshots stay as-is (light theme captures). Add a subtle `border-radius: 8px` and `1px solid var(--border-color)` frame so they don't clash with dark backgrounds.

## "Requires AI key" badge

Steps 2 and 3 include an inline badge below the body text:

```
🔑 Requires an AI API key
```

Style: `font-size: 0.72rem`, `color: var(--text-muted)`, `background: var(--bg-tertiary)`, `padding: 3px 10px`, `border-radius: 12px`, inline-block. The `🔑` is the only emoji in the spec — it's a functional indicator, not decoration.

## "Open Settings" action (Step 4)

The primary CTA on step 4 is **"Open Settings"** instead of "Next":
1. Clicking it dismisses the onboarding tour
2. Sets `taxonomy-editor-onboarding-dismissed` → `'true'`
3. Opens the SettingsDialog (calls the same handler as the toolbar settings button)

A secondary **"Done"** button dismisses without opening settings (for users who already have a key or want to do it later).

## Animations

- **Step transitions:** CSS transition, `opacity` + `translateX` (slide left on Next, slide right on Back). Duration `200ms ease`.
- **Entry:** Fade-in backdrop + scale-up card from `0.95` to `1.0`, `250ms ease`.
- **Exit:** Fade-out, `150ms`.

Keep it minimal — the content is what matters.

## Re-access from Help dialog

The HelpDialog (`HelpDialog.tsx`) has a tabbed sidebar layout. Add **"Welcome Tour"** as the **first item** in the tab list — above "About".

### Tab list update

Current `TABS` array:
```
About | Overview | Documentation | Methods | Shortcuts | SBOM | Licenses
```

New:
```
Welcome Tour | About | Overview | Documentation | Methods | Shortcuts | SBOM | Licenses
```

Add to the `HelpTab` type union and `TABS` array:
```typescript
type HelpTab = 'tour' | 'about' | 'overview' | ...;

const TABS: { id: HelpTab; label: string }[] = [
  { id: 'tour', label: 'Welcome Tour' },
  { id: 'about', label: 'About' },
  // ... existing tabs
];
```

### "Tour" tab content

When the "Welcome Tour" tab is active, the content area shows a brief description and a launch button:

```
┌──────────────────────────────────────────────────┐
│ *Tour*  │                                        │
│  About  │  Welcome Tour                          │
│  Overv. │                                        │
│  Docs   │  A guided walkthrough of the app's     │
│  Method │  main tools: Taxonomy, Debates, Chat,  │
│  Short. │  and Settings.                         │
│  SBOM   │                                        │
│  Licen. │  [Start Tour]                          │
│         │                                        │
└──────────────────────────────────────────────────┘
```

- **Heading:** "Welcome Tour" — same `<h4>` style as other tab content headings
- **Description:** "A guided walkthrough of the app's main tools: Taxonomy, Debates, Chat, and Settings." — `font-size: 0.85rem, color: var(--text-secondary)`
- **Button:** "Start Tour" — `btn btn-primary btn-sm`

### Visual treatment

The "Welcome Tour" tab button uses the same styling as all other tabs — no special icon or color. It is a peer of About/Overview/etc.

### Behavior

1. User clicks "Start Tour" button in the tour tab content
2. HelpDialog closes (calls `onClose`)
3. `localStorage.removeItem('taxonomy-editor-onboarding-dismissed')` — clears the dismissed flag
4. App re-renders the `OnboardingTour` component (since the dismissed flag is now gone)

The click handler:
```
onClick={() => {
  localStorage.removeItem('taxonomy-editor-onboarding-dismissed');
  onClose();
  // App.tsx watches this flag and will show OnboardingTour
}}
```

For App.tsx to react to this, use a Zustand action or a custom event. Simplest approach: add a `showOnboarding` state to the settings slice (or local App state) and expose a `triggerOnboarding()` action that sets it to true. The HelpDialog calls this action before closing.

### Default active tab

The HelpDialog should still default to `'about'` when opened — not 'tour'. The tour tab is discoverable in the sidebar but not forced on every Help open.

## What NOT to do

- No multi-page tutorial or documentation dump — 4 steps max, each scannable in 5 seconds
- No forced completion — Skip is always available
- No video — static screenshots load instantly and work offline
- No per-feature tooltips or spotlight overlays — those are a different pattern (coach marks), not needed here
- No feature gating — the tour is informational only, never blocks access
- No account creation or sign-up flow — this is a research tool, not a SaaS product

## Integration points

| File | Change |
|---|---|
| New: `components/OnboardingTour.tsx` | Tour modal component (4 steps, screenshots, navigation) |
| `App.tsx` | Conditional render after FirstRunDialog, manage `showOnboarding` state |
| `public/onboarding/*.png` | 4 screenshot images (light theme, 960x600) |
| `styles.css` | `.onboarding-overlay`, `.onboarding-card`, `.onboarding-dots`, step transition classes |
| `settings/HelpDialog.tsx` | Add 'tour' as first tab in TABS array; render tour content panel with "Start Tour" button (closes dialog, clears dismissed flag, triggers tour) |

## Accessibility

- Modal traps focus (same pattern as SettingsDialog)
- Step dots have `aria-label="Step N of 4: {title}"`
- Screenshots have descriptive `alt` text (e.g., "Taxonomy editor showing the Safetyist perspective with Desires category expanded")
- "Skip tour" link is keyboard-focusable
- Escape key dismisses
- Step transitions respect `prefers-reduced-motion` — disable slide animations, use instant swap
