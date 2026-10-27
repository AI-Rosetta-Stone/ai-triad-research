// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/600.css';
import '@fontsource-variable/jetbrains-mono';
import { App } from './App';
import { PublicPovView } from './components/PublicPovView';
import { PublicOpEdView } from './components/PublicOpEdView';
import { PublicOpEdIndexView } from './components/PublicOpEdIndexView';
import { PublicInquiryView } from './components/PublicInquiryView';
import { installVitePreloadRecovery } from './lib/vitePreloadRecovery';
import './LibraryTheme.css'; // loaded before styles.css, as its @import was (keeps styles.css under its LOC ceiling)
import './styles.css';
import './responsive.css';
import './Tooltip.css';
import './components/shared/ContextMenu.css';
import './components/shared/DialogOverlay.css';

// Public share link (t/1790, t/2728, t/3482, t/3628): a fully logged-out visitor to
// `/share/pov/:id`, `/share/oped/:shareId`, `/share/opeds`, or `/inquiries/:shareId`
// gets the slim read-only view — NOT the main app. The inquiry share path is `/inquiries/`
// (not `/share/inquiry/`, unlike the other three) to match ServerAPI's already-landed mint
// route (t/3626, PR #2405: `-> { shareId, url: '/inquiries/{shareId}' }`).
// Rendering App() here would run its feature-flag refresh (getFlags → session-
// recovering bridge helper) and mount MainApp/loadAll (auth + `/ws`), all of which
// would mint a session and violate the no-session invariant (TL, t/1787#2). Branch
// before App renders.
// Self-heal transient/stale CSS+chunk preload misses (t/3080). Registered before
// createRoot so it's live for any runtime dynamic import; App's import already ran
// initFlightRecorder(), so getGlobalRecorder() is available to the handler.
installVitePreloadRecovery();

const path = window.location.pathname;
const publicView = path.startsWith('/share/pov/')
  ? <PublicPovView />
  : path === '/share/opeds' || path === '/share/opeds/'
    ? <PublicOpEdIndexView />
    : path.startsWith('/share/oped/')
      ? <PublicOpEdView />
      : path.startsWith('/inquiries/')
        ? <PublicInquiryView />
        : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {publicView ?? <App />}
  </StrictMode>,
);
