// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1687 (Phase 2 server.ts split, ADR-007): the server-rendered login /
// forbidden pages and their helpers, moved verbatim out of server.ts to get the
// core HTTP file under budget. This module has NO routes, so it does not touch
// the routeTable snapshot — server.ts's request pipeline imports these back.
//
// loginPageHeaders calls parseCookies, now shared from ./httpCookies.ts (t/2019) —
// it was duplicated here because importing from server.ts boots the HTTP server.
// SW_HEAL_SCRIPT and escapeHtml are used only within this module, so they stay
// module-private.

import http from 'http';
import crypto from 'crypto';
import { hasEasyAuthSessionCookie, expiredAuthCookies } from './security/accessControl.js';
import { parseCookies } from './httpCookies.js';
import {
  INTRO_EYEBROW, INTRO_TITLE, LOGIN_TAGLINE_LINES, INTRO_QUESTION, INTRO_VOICES,
} from '../../../lib/electron-shared/introCopy.js';

// t/4183: the hero copy is shared with the intro tour's first page; only the markup lives here.
const VOICE_STYLE: Record<(typeof INTRO_VOICES)[number]['pov'], { short: string; label: string }> = {
  accelerationist: { short: 'acc', label: 'Accelerationist' },
  safetyist: { short: 'saf', label: 'Safetyist' },
  skeptic: { short: 'skp', label: 'Skeptic' },
};

function heroVoicesHtml(): string {
  return INTRO_VOICES.map(({ pov, line }) => {
    const { short, label } = VOICE_STYLE[pov];
    return `
        <div class="voice voice-${short}">
          <span class="voice-dot" style="background:var(--color-${short});"></span>
          <span class="voice-name" style="color:var(--color-${short});">${label}</span>
          <span class="voice-line">${escapeHtml(line)}</span>
        </div>`;
  }).join('');
}

// t/940: a stale Easy Auth cookie (AppServiceAuthSession present but no valid
// principal) makes the OAuth redirect loop back to the login page. Whenever we
// serve that page, expire any such cookie so the next sign-in click starts from a
// clean state — the auto-clear half of AC#1 (the page also offers a manual link).
export function loginPageHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'text/html' };
  const cookieNames = [...parseCookies(req).keys()];
  if (hasEasyAuthSessionCookie(cookieNames)) {
    headers['Set-Cookie'] = expiredAuthCookies(cookieNames);
  }
  return headers;
}

// t/1128: login-page service-worker self-heal + state beacon. The server-rendered
// login page otherwise has no JS, so a stuck old SW (from before the /.auth/
// denylist) can intercept the sign-in navigations (t/1126) with no signal. This
// (1) beacons the SW registration state for diagnosis and (2) unregisters any SW
// once (sessionStorage-guarded against reload loops) so the sign-in links work —
// the current SW re-registers after a successful login. The script text is static,
// so its CSP sha256 is derived from this same constant and can never drift out of
// sync (script-src has no 'unsafe-inline'; a hash source is the safe way in).
//
// t/2474: a second IIFE carries the URL fragment through the anonymous flow so a
// pasted community-debate deep link (`/#debate-window?id=...`) survives login. The
// hash fragment never reaches the server, so the auth gate serves this login page
// for such a cold visit; without help the anon link discards the fragment. Per
// RFC 7231 §7.1.2, a 302 whose Location has no fragment re-applies the request
// URL's fragment — so navigating to `/.auth/anonymous#debate-window?...` lands the
// visitor on `/#debate-window?...` with session cookies set. Two behaviours:
//   (1) Hash-carry (always, when a hash is present): rewrite `.anon-link`'s href to
//       `/.auth/anonymous` + the current hash.
//   (2) Auto-continue (known deep-link routes only): for `#debate-window` hashes,
//       replace to the anon endpoint immediately — paste-in-incognito opens the
//       debate with no interstitial.
// Both are gated on `.anon-link` being present in the DOM: it exists iff
// buildLoginPage was called with showAnonymous=true, so in required-auth mode this
// script advertises NO path toward /.auth/anonymous (TL t/2474#2, req. change 1).
// Auto-continue is guarded by a one-shot sessionStorage marker so a failed anon
// handshake (cookies blocked / endpoint error) that re-serves this page cannot
// loop — on the second pass we fall through to the interstitial with the
// hash-carried link intact. If sessionStorage is unavailable we do NOT
// auto-continue (can't guarantee the loop breaker), only hash-carry (req. change 2).
// Staying in this one constant keeps a single CSP hash source (no drift).
const SW_HEAL_SCRIPT =
  `(function(){try{if(!('serviceWorker' in navigator))return;` +
  `navigator.serviceWorker.getRegistrations().then(function(regs){` +
  `var info={page:'login',controller:navigator.serviceWorker.controller?navigator.serviceWorker.controller.scriptURL:null,` +
  `registrations:regs.map(function(r){return{scope:r.scope,script:(r.active&&r.active.scriptURL)||null};}),` +
  `ua:navigator.userAgent,ts:Date.now()};` +
  `try{navigator.sendBeacon('/api/diagnostics/sw-state',new Blob([JSON.stringify(info)],{type:'application/json'}));}catch(e){}` +
  `var stuck=regs.length>0||!!navigator.serviceWorker.controller;` +
  `if(stuck&&sessionStorage.getItem('sw_login_cleared')!=='1'){sessionStorage.setItem('sw_login_cleared','1');` +
  `Promise.all(regs.map(function(r){return r.unregister();})).then(function(){location.reload();}).catch(function(){});}` +
  `}).catch(function(){});}catch(e){}})();` +
  `(function(){try{var h=location.hash;if(!h)return;function run(){` +
  `var a=document.querySelector('.anon-link');if(!a)return;` +
  `var target='/.auth/anonymous'+h;a.setAttribute('href',target);` +
  `if(h.indexOf('#debate-window')===0){var go=false;` +
  `try{if(sessionStorage.getItem('anon_autocontinue')!=='1'){sessionStorage.setItem('anon_autocontinue','1');go=true;}}catch(e){go=false;}` +
  `if(go)location.replace(target);}}` +
  `if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run);}else{run();}` +
  `}catch(e){}})();`;
export const SW_HEAL_SCRIPT_CSP_HASH = `'sha256-${crypto.createHash('sha256').update(SW_HEAL_SCRIPT).digest('base64')}'`;

export function buildLoginPage(showAnonymous: boolean): string {
  // t/1416 (login-redesign.md): "Specimen" front door — dark jacket with static
  // debate specimen, warm-white paper sign-in card. DOM order puts paper first so
  // keyboard/SR users reach the door before the ornament; flex-direction reverses
  // the visual order. The paper panel is deliberately light even for dark-theme
  // users — one bright page against a dark jacket is the book metaphor.
  const anonymousSection = showAnonymous ? `
      <div class="divider"><span>or</span></div>
      <a class="anon-link" href="/.auth/anonymous">Browse without an account</a>
      <p class="anon-note">Read-only: explore the full taxonomy and debate archive. Sign in to run debates and edit.</p>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign In — AITriad Taxonomy Editor</title>
<style>
  :root {
    --jacket:#111a28;
    --paper:#FBF9F4;
    --paper-text:#1e293b;
    --paper-muted:#94a3b8;
    --paper-border:rgba(17,26,40,0.15);
    --radius-md:8px;
    --color-acc:#e89450;
    --color-saf:#7da3d6;
    --color-skp:#a888c8;
    --font-ui:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    --font-serif:Georgia,'Times New Roman',serif;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  body{min-height:100vh;font-family:var(--font-ui);background:var(--jacket);}

  .split{display:flex;flex-direction:row-reverse;min-height:100vh;}

  /* — Paper (sign-in card) — */
  .paper{flex:0 0 45%;display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:48px 40px;background:var(--paper);color:var(--paper-text);
    animation:fadeIn 150ms ease-out both;}
  .card{width:100%;max-width:360px;}
  .card h2{font-size:20px;font-weight:600;margin-bottom:24px;}
  .btn{display:flex;align-items:center;gap:12px;width:100%;height:44px;padding:0 16px;
    margin-bottom:12px;border:1px solid var(--paper-border);border-radius:var(--radius-md);
    background:#fff;color:var(--paper-text);font-size:14px;font-weight:500;
    font-family:var(--font-ui);text-decoration:none;cursor:pointer;
    transition:border-color .15s,box-shadow .15s;}
  .btn:hover{border-color:#94a3b8;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
  .btn:focus-visible{outline:2px solid #2b5fad;outline-offset:2px;}
  .btn svg{width:18px;height:18px;flex-shrink:0;}
  .divider{display:flex;align-items:center;gap:12px;margin:16px 0;color:var(--paper-muted);font-size:12px;}
  .divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--paper-border);}
  .anon-link{display:block;text-align:center;padding:10px 0;color:#475569;font-size:14px;
    text-decoration:none;border-radius:var(--radius-md);transition:background .15s;}
  .anon-link:hover{background:rgba(0,0,0,0.04);text-decoration:underline;}
  .anon-link:focus-visible{outline:2px solid #2b5fad;outline-offset:2px;}
  .anon-note{color:var(--paper-muted);font-size:12px;margin-top:6px;line-height:1.5;text-align:center;}
  .clear-link{display:block;margin-top:28px;color:var(--paper-muted);font-size:12px;
    text-align:center;text-decoration:none;}
  .clear-link:hover{color:#475569;text-decoration:underline;}

  /* — Jacket (specimen) — */
  .jacket{flex:0 0 55%;display:flex;flex-direction:column;justify-content:center;
    padding:48px 56px;background:var(--jacket);color:#fff;}
  .jacket-content{max-width:480px;}
  .eyebrow{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;
    color:rgba(255,255,255,0.55);margin-bottom:20px;
    animation:fadeIn 150ms ease-out both;}
  .project-title{font-family:var(--font-serif);font-size:38px;font-weight:700;line-height:1.2;
    color:#fff;margin-bottom:12px;
    animation:fadeIn 150ms ease-out both;}
  .tagline{font-family:var(--font-serif);font-size:19px;font-weight:400;line-height:1.4;
    color:rgba(255,255,255,0.72);margin-bottom:32px;
    animation:fadeIn 150ms ease-out both;}
  .specimen-sep{width:48px;height:1px;background:rgba(255,255,255,0.2);margin-bottom:28px;
    animation:fadeIn 150ms ease-out 100ms both;}
  .question{font-family:var(--font-serif);font-style:italic;font-size:17px;
    color:rgba(255,255,255,0.92);margin-bottom:24px;line-height:1.45;
    animation:fadeIn 150ms ease-out 250ms both;}
  .voice{display:flex;gap:10px;align-items:flex-start;margin-bottom:14px;}
  .voice-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:6px;}
  .voice-name{font-size:12px;font-weight:600;min-width:100px;flex-shrink:0;}
  .voice-line{font-family:var(--font-serif);font-size:15px;color:rgba(255,255,255,0.78);line-height:1.45;}
  .voice-acc{animation:fadeIn 150ms ease-out 370ms both;}
  .voice-saf{animation:fadeIn 150ms ease-out 490ms both;}
  .voice-skp{animation:fadeIn 150ms ease-out 610ms both;}
  .jacket-footer{margin-top:40px;font-size:12px;color:rgba(255,255,255,0.35);
    animation:fadeIn 150ms ease-out 610ms both;}

  @keyframes fadeIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
  @media(prefers-reduced-motion:reduce){
    *{animation:none!important;transition:none!important;}
  }

  /* Tablet: 50/50 */
  @media(max-width:1023px){
    .jacket,.paper{flex:1;}
  }
  /* Phone: jacket collapses to header band, no specimen */
  @media(max-width:767px){
    .split{flex-direction:column-reverse;}
    .jacket{flex:none;padding:28px 24px;align-items:center;text-align:center;}
    .jacket-content{max-width:none;}
    .specimen,.specimen-sep,.jacket-footer{display:none;}
    .project-title{font-size:24px;}
    .tagline{display:none;}
    .eyebrow{margin-bottom:12px;}
    .paper{flex:1;padding:32px 24px;}
  }
</style>
<script>${SW_HEAL_SCRIPT}</script>
</head>
<body>
<div class="split">
  <section class="paper">
    <div class="card">
      <h2>Sign in</h2>
      <a class="btn" href="/api/auth/fresh-login/github">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
        Continue with GitHub
      </a>
      <a class="btn" href="/api/auth/fresh-login/google">
        <svg viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
        Continue with Google
      </a>
      <a class="btn" href="/api/auth/fresh-login/aad">
        <svg viewBox="0 0 24 24"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="13" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="13" width="10" height="10" fill="#00A4EF"/><rect x="13" y="13" width="10" height="10" fill="#FFB900"/></svg>
        Continue with Microsoft
      </a>${anonymousSection}
      <a class="clear-link" href="/api/auth/logout">Trouble signing in? Clear session and retry</a>
    </div>
  </section>
  <section class="jacket">
    <div class="jacket-content">
      <div class="eyebrow">${escapeHtml(INTRO_EYEBROW)}</div>
      <div class="project-title">${escapeHtml(INTRO_TITLE)}</div>
      <div class="tagline">${LOGIN_TAGLINE_LINES.map(escapeHtml).join('<br>')}</div>
      <div class="specimen">
        <div class="specimen-sep"></div>
        <div class="question">&ldquo;${escapeHtml(INTRO_QUESTION)}&rdquo;</div>${heroVoicesHtml()}
      </div>
      <div class="jacket-footer">A research instrument of the Berkman Klein Center, 2026</div>
    </div>
  </section>
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const FORBIDDEN_PAGE = (name: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Access Denied — Taxonomy Editor</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .card { background: #1e293b; border-radius: 12px; padding: 40px; max-width: 400px; width: 90%; text-align: center; }
  h1 { font-size: 1.5rem; color: #ef4444; margin-bottom: 12px; }
  p { color: #94a3b8; margin-bottom: 8px; font-size: 0.9rem; }
  .user { color: #f59e0b; font-weight: 600; }
  .btn { display: inline-block; margin-top: 20px; padding: 10px 24px; border-radius: 8px;
         background: #334155; color: #e2e8f0; text-decoration: none; font-size: 0.9rem; }
  .btn:hover { background: #475569; }
</style>
</head>
<body>
<div class="card">
  <h1>Access Denied</h1>
  <p>Signed in as <span class="user">${escapeHtml(name)}</span></p>
  <p>You are not in the authorized users list. Contact the administrator to request access.</p>
  <a class="btn" href="/api/auth/logout">Sign out</a>
</div>
</body>
</html>`;
