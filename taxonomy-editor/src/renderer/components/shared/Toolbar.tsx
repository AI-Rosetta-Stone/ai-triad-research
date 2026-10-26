// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useRef, Fragment } from 'react';
import {
  LayoutGrid, MessageSquare, MessageCircle,
  Ellipsis, CircleHelp, MessageSquareText, Layers,
  RefreshCw, Settings, User, Users, Shield, LogOut, Newspaper, Sparkles,
} from 'lucide-react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { api, isElectronMode } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { HelpDialog } from '../settings/HelpDialog';
import { SettingsDialog } from '../settings/SettingsDialog';
import { useAuthStatus, useUserProfile } from '../../hooks/useAuthStatus';
import { useFlag } from '../../hooks/useFeatureFlags';
import { useNavVisibilityContext } from '../../hooks/useNavVisibilityContext';
import { useSettingsDialog } from '../../hooks/useSettingsDialog';
import { useTierInfo } from '../../hooks/useTierInfo';
import { FeedbackPopover } from './FeedbackPopover';
import { NAV_ITEMS, getVisibleNavItems, getSecondaryByGroup, type NavItem, type NavAction } from '../../data/navConfig';
import { usePreferencesStore } from '../../store/preferencesStore';
import './Toolbar.css';

type ToolbarPanel = 'search' | 'related' | 'attrFilter' | 'attrInfo' | 'lineage' | 'prompts' | 'console' | 'fallacy' | 'edges' | 'policyAlignment' | 'policyDashboard' | 'vocabulary' | 'calibration';

function useAdminReviewCount(): number {
  const adminFeatures = useFlag('permission-admin-features');
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!isElectronMode() && !adminFeatures) return;
    let cancelled = false;
    let configState: boolean | null = null;
    const doPoll = () => {
      api.adminReviewStats()
        .then(s => { if (!cancelled && s) setCount(s.total ?? 0); })
        .catch((err) => {
          getGlobalRecorder()?.record({ type: 'system.error', component: 'Toolbar', level: 'warn', message: 'Admin review stats poll failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        });
    };
    const poll = () => {
      if (isElectronMode()) {
        if (configState === false) return;
        if (configState === null) {
          api.adminReviewConfigured().then(configured => {
            configState = configured;
            if (configured) doPoll();
          }).catch(() => {});
          return;
        }
      }
      doPoll();
    };
    poll();
    const id = setInterval(poll, 300_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [adminFeatures]);
  return count;
}

function ToolbarAuthButton() {
  const auth = useAuthStatus();
  const profile = useUserProfile();
  const adminFeatures = useFlag('permission-admin-features');
  const { tier, usage } = useTierInfo();
  const [showPopover, setShowPopover] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const reviewCount = useAdminReviewCount();

  useEffect(() => {
    if (!showPopover) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [showPopover]);

  if (!auth) return null;

  const initial = auth.anonymous ? '?' : (auth.user?.[0] ?? '?').toUpperCase();

  return (
    <div className="toolbar-auth-wrap" ref={wrapRef}>
      <button
        className={`toolbar-icon toolbar-auth-btn${showPopover ? ' toolbar-icon-active' : ''}`}
        onClick={() => setShowPopover(v => !v)}
        aria-label={auth.anonymous ? 'Sign in' : auth.user ?? 'Account'}
        data-tooltip={auth.anonymous ? 'Sign in' : auth.user}
      >
        {auth.anonymous ? (
          <User size="1.25em" />
        ) : (
          <span className="toolbar-auth-avatar">{initial}</span>
        )}
      </button>
      {showPopover && (
        <div className="toolbar-auth-popover" role="menu">
          {auth.anonymous ? (
            <>
              <div className="toolbar-auth-anon-banner">Anonymous mode — data is temporary. Sign in to save.</div>
              {tier?.level === 'free' && (
                <div className="toolbar-auth-quota toolbar-auth-quota-col">
                  <span className="toolbar-auth-tier-label">Free Tier</span>
                  <span>{tier.pinnedModel} &middot; {tier.limits.requestsPerMinute} req/min &middot; {Math.round(tier.limits.tokensPerDay / 1000)}K tokens/day</span>
                  {usage && (
                    <span className="toolbar-auth-usage-note">
                      Used: {usage.usage.requestsInWindow} req &middot; {Math.round(usage.usage.tokensToday / 1000)}K tokens today
                    </span>
                  )}
                </div>
              )}
              <a className="toolbar-more-item toolbar-more-link" href="/api/auth/fresh-login/github"
                onClick={() => setShowPopover(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
                <span>Sign in with GitHub</span>
              </a>
              <a className="toolbar-more-item toolbar-more-link" href="/api/auth/fresh-login/google"
                onClick={() => setShowPopover(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 8v8" /><path d="M8 12h8" /></svg>
                <span>Sign in with Google</span>
              </a>
            </>
          ) : (
            <>
              <div className="toolbar-auth-identity">
                <span className="toolbar-auth-avatar-lg">{initial}</span>
                <div className="toolbar-auth-details">
                  <span className="toolbar-auth-name">{auth.user}</span>
                  <span className="toolbar-auth-meta">
                    {auth.idp ? `via ${auth.idp}` : ''}
                    {adminFeatures && <span className="toolbar-auth-admin-badge">Admin</span>}
                  </span>
                </div>
              </div>
              {profile?.quotas && (
                <div className="toolbar-auth-quota">
                  Chats: {profile.quotas.maxChats} max &middot; Debates: {profile.quotas.maxDebates} max
                </div>
              )}
              {tier && (
                <div className="toolbar-auth-quota">
                  <span className="toolbar-auth-tier-name">{tier.level} Tier</span>
                  {' '}&middot; {tier.limits.requestsPerMinute} req/min &middot; {Math.round(tier.limits.tokensPerDay / 1000)}K tokens/day
                  {usage && (
                    <div className="toolbar-auth-usage-note toolbar-auth-usage-note-mt">
                      Used: {usage.usage.requestsInWindow} req &middot; {Math.round(usage.usage.tokensToday / 1000)}K tokens today
                    </div>
                  )}
                </div>
              )}
              <div className="toolbar-auth-divider" />
              <a className="toolbar-more-item toolbar-more-link" href="#community"
                onClick={() => setShowPopover(false)}>
                <Users size="1.25em" />
                <span>Community Library</span>
              </a>
              {adminFeatures && (
                <a className="toolbar-more-item toolbar-more-link" href="#admin"
                  onClick={() => setShowPopover(false)}>
                  <Shield size="1.25em" />
                  <span>Admin Review</span>
                  {reviewCount > 0 && (
                    <span className="toolbar-auth-admin-badge toolbar-auth-badge-ml">
                      {reviewCount}
                    </span>
                  )}
                </a>
              )}
              <div className="toolbar-auth-divider" />
              <a className="toolbar-more-item toolbar-more-link" href="/api/auth/logout"
                onClick={() => { getGlobalRecorder()?.record({ type: 'auth.logout_initiated', component: 'auth', level: 'info', message: 'User initiated logout', data: { target: '/api/auth/logout', source: 'toolbar' } }); setShowPopover(false); }}>
                <LogOut size="1.25em" />
                <span>Sign out</span>
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Toolbar() {
  const {
    toolbarPanel, setToolbarPanel,
    activeTab, setActiveTab,
    selectedNodeId,
    clearSimilarSearch, getLabelForId,
    showRelatedEdges,
    attributeFilter, runAttributeFilter,
    clearAttributeFilter,
    attributeInfo, showAttributeInfo,
    clearAttributeInfo,
    loadAll, loading,
  } = useTaxonomyStore();
  const adminFlag = useFlag('permission-admin-features');
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Global open-signal so surfaces outside the toolbar (e.g. the daily-quota
  // banners) can route the user to Settings → API Keys (t/3190).
  const settingsRequested = useSettingsDialog(s => s.isOpen);
  const closeSettingsSignal = useSettingsDialog(s => s.close);
  const [showMore, setShowMore] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  // Close "More" popover on outside click
  useEffect(() => {
    if (!showMore) return;
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setShowMore(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [showMore]);

  const navCtx = useNavVisibilityContext(); // whole flag record — no subset to drift (t/2641)
  const visibleItems = getVisibleNavItems(NAV_ITEMS, navCtx);
  const secondaryGroups = getSecondaryByGroup(visibleItems);
  // The hardcoded primary Op-Eds button honors the SAME navConfig gate as the data-driven
  // items — it was gated on env-electron-opeds ALONE, so it stayed hidden on web even with
  // env-web-opeds ON (the Toolbar is what renders on desktop-width web). t/2641.
  const opedsVisible = visibleItems.some(i => i.id === 'opeds');
  // t/3616: same class of bug as t/2641 (Op-Eds) — this Toolbar hardcodes primary buttons rather
  // than mapping visibleItems, so a new primary NAV_ITEMS entry (inquiry, t/3583) never rendered
  // here even though it's gate-free and correctly shown by the data-driven HamburgerMenu.
  const inquiryVisible = visibleItems.some(i => i.id === 'inquiry');
  const isNavItemActive = (item: NavItem): boolean => {
    if (item.action.type === 'switchTab') return activeTab === item.action.target && toolbarPanel === null;
    if (item.action.type === 'togglePanel') return toolbarPanel === item.action.target;
    return false;
  };
  const moreHasActive = secondaryGroups.flatMap(g => g.items).some(i => isNavItemActive(i));
  const viewMode = usePreferencesStore(state => state.viewMode);
  const setViewMode = usePreferencesStore(state => state.setViewMode);

  const clearCurrentPanel = () => {
    if (toolbarPanel === 'search') clearSimilarSearch();
    else if (toolbarPanel === 'related') showRelatedEdges(null);
    else if (toolbarPanel === 'attrFilter') clearAttributeFilter();
    else if (toolbarPanel === 'attrInfo') clearAttributeInfo();
  };

  const switchTab = (tab: 'situations' | 'conflicts' | 'cruxes' | 'debate' | 'chat' | 'opeds' | 'summaries' | 'validation' | 'inquiry') => {
    clearCurrentPanel();
    useTaxonomyStore.setState({ relatedNodeId: null, selectedEdge: null });
    setToolbarPanel(null);
    setActiveTab(tab);
  };

  const toggle = (panel: ToolbarPanel) => {
    if (toolbarPanel === panel) {
      clearCurrentPanel();
      setToolbarPanel(null);
    } else {
      if (panel === 'related' && selectedNodeId) {
        showRelatedEdges(selectedNodeId);
      } else if (panel === 'attrFilter' && !attributeFilter) {
        runAttributeFilter('epistemic_type', 'empirical_claim');
      } else if (panel === 'attrInfo' && !attributeInfo) {
        showAttributeInfo('epistemic_type', 'empirical_claim');
      } else {
        setToolbarPanel(panel);
      }
    }
  };

  const dispatchNav = (action: NavAction) => {
    if (action.type === 'switchTab') switchTab(action.target as Parameters<typeof switchTab>[0]);
    else if (action.type === 'togglePanel') toggle(action.target as ToolbarPanel);
  };

  const isTaxonomyActive = toolbarPanel === null && !['situations', 'conflicts', 'cruxes', 'debate', 'chat', 'opeds', 'summaries', 'validation', 'inquiry'].includes(activeTab);

  return (
    <nav className="toolbar" aria-label="Primary">
      <div className="toolbar-top">
        {/* Primary nav — icon-over-label stacks. t/4535: reordered to Chat, Op-Ed Studies,
            Ask a Question, Debate, Taxonomy (PI request, p/351#29; order only). */}
        {/* t/2813: Search removed from the nav rail; entry points now live in the
            Taxonomy panel header + POV detail header. toggle('search') still works. */}
        <button
          className={`toolbar-nav${activeTab === 'chat' && toolbarPanel === null ? ' toolbar-nav-active' : ''}`}
          onClick={() => switchTab('chat')}
          aria-label="Chat"
        >
          <MessageCircle size="1.25em" />
          <span className="toolbar-nav-label">Chat</span>
        </button>
        {opedsVisible && (
          <button
            className={`toolbar-nav${activeTab === 'opeds' && toolbarPanel === null ? ' toolbar-nav-active' : ''}`}
            onClick={() => switchTab('opeds')}
            aria-label="Op-Ed Studies"
          >
            <Newspaper size="1.25em" />
            <span className="toolbar-nav-label">Op-Ed<br />Studies</span>
          </button>
        )}
        {inquiryVisible && (
          <button
            className={`toolbar-nav${activeTab === 'inquiry' && toolbarPanel === null ? ' toolbar-nav-active' : ''}`}
            onClick={() => switchTab('inquiry')}
            aria-label="Ask a Question"
          >
            <Sparkles size="1.25em" />
            <span className="toolbar-nav-label">Ask a<br />Question</span>
          </button>
        )}
        <button
          className={`toolbar-nav${activeTab === 'debate' && toolbarPanel === null ? ' toolbar-nav-active' : ''}`}
          onClick={() => switchTab('debate')}
          aria-label="Debate"
        >
          <MessageSquare size="1.25em" />
          <span className="toolbar-nav-label">Debate</span>
        </button>
        <button
          className={`toolbar-nav${isTaxonomyActive ? ' toolbar-nav-active' : ''}`}
          onClick={() => {
            clearCurrentPanel();
            setToolbarPanel(null);
            if (['situations', 'conflicts', 'debate', 'chat', 'opeds', 'summaries', 'validation'].includes(activeTab)) {
              setActiveTab('accelerationist');
            }
          }}
          aria-label="Taxonomy"
        >
          <LayoutGrid size="1.25em" />
          <span className="toolbar-nav-label">Taxonomy</span>
        </button>
      </div>
      <div className="toolbar-bottom">
        <button
          className={`toolbar-icon${viewMode === 'advanced' ? ' toolbar-icon-active' : ''}`}
          onClick={() => void setViewMode(viewMode === 'simple' ? 'advanced' : 'simple')}
          aria-label={viewMode === 'simple' ? 'Switch to Advanced view' : 'Switch to Simple view'}
          data-tooltip={viewMode === 'simple' ? 'Switch to Advanced view' : 'Switch to Simple view'}
        >
          <Layers size="1.25em" />
        </button>
        {/* Other Tools — hidden in Simple view */}
        {viewMode === 'advanced' && <div className="toolbar-more-wrap" ref={moreRef}>
          <button
            className={`toolbar-icon${moreHasActive || showMore ? ' toolbar-icon-active' : ''}`}
            onClick={() => setShowMore(v => !v)}
            aria-label="Other Tools"
            data-tooltip="Other Tools"
          >
            <Ellipsis size="1.25em" />
          </button>
          {showMore && (
            <div className="toolbar-more-popover" role="menu">
              {secondaryGroups.map((group, gi) => (
                <Fragment key={group.group}>
                  {gi > 0 && <div className="toolbar-more-divider" />}
                  {group.items.map(item => (
                    <button
                      key={item.id}
                      className={`toolbar-more-item${isNavItemActive(item) ? ' active' : ''}`}
                      onClick={() => { dispatchNav(item.action); setShowMore(false); }}
                    >
                      <item.icon size="1.25em" />
                      <span>{item.label}</span>
                    </button>
                  ))}
                </Fragment>
              ))}
            </div>
          )}
        </div>}
        <div className="toolbar-separator" />
        <button
          className="toolbar-icon"
          onClick={() => setShowHelp(true)}
          aria-label="Help"
          data-tooltip="Help"
        >
          <CircleHelp size="1.25em" />
        </button>
        <div className="toolbar-feedback-wrap" ref={feedbackRef}>
          <button
            className={`toolbar-icon${showFeedback ? ' toolbar-icon-active' : ''}`}
            onClick={() => setShowFeedback(v => !v)}
            aria-label="Feedback"
            data-tooltip="Feedback"
          >
            <MessageSquareText size="1.25em" />
          </button>
          {showFeedback && <FeedbackPopover onClose={() => setShowFeedback(false)} />}
        </div>
        <ToolbarAuthButton />
        {adminFlag && (
          <button
            className={`toolbar-icon${loading ? ' toolbar-icon-spin' : ''}`}
            onClick={() => { if (!loading) void loadAll(true); }}
            disabled={loading}
            aria-label="Reload taxonomy data"
            data-tooltip="Reload taxonomy data (admin)"
          >
            <RefreshCw size="1.25em" />
          </button>
        )}
        <button
          className="toolbar-icon"
          onClick={() => setShowSettings(true)}
          aria-label="Settings"
          data-tooltip="Settings"
        >
          <Settings size="1.25em" />
        </button>
      </div>
      {(showSettings || settingsRequested) && (
        <SettingsDialog onClose={() => { setShowSettings(false); closeSettingsSignal(); }} />
      )}
      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
    </nav>
  );
}
