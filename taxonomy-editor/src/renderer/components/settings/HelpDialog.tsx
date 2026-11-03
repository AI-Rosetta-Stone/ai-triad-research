// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { api } from '@bridge';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ossData from '../../data/oss-licenses.json';
import { SupportCaseForm } from '../support/SupportCaseForm';
import { MyCases } from '../support/MyCases';
import { useSupportStore } from '../../hooks/useSupportStore';
import './HelpDialog.css';

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
declare const __CHANGELOG_MD__: string;

const REPO_URL = 'https://github.com/AI-Rosetta-Stone/ai-triad-research';

const DOCS = [
  { title: 'Architecture Overview', path: 'docs/architecture-overview.md',
    desc: 'Two-repo split, Electron apps, AI backends, and data model' },
  { title: 'API Key Protection', path: 'docs/security/api-key-protection.md',
    desc: 'How your AI provider API key is stored, transmitted, and protected' },
  { title: 'Debate Engine Design', path: 'docs/debate-engine-design.md',
    desc: 'Three-agent BDI debate system, QBAF scoring, and moderator' },
  { title: 'Debate System Overview', path: 'docs/debate-system-overview.md',
    desc: 'High-level overview of the multi-agent debate system' },
  { title: 'Theory of Success', path: 'docs/theory-of-success.md',
    desc: 'What success looks like for debate, step-by-step execution, weaknesses' },
  { title: 'Taxonomy & Ontology Guide', path: 'docs/taxonomy-ontology-guide.md',
    desc: 'How the taxonomy is structured — BDI categories, POVs, situations' },
  { title: 'Document Processing Pipeline', path: 'docs/document-processing-pipeline.md',
    desc: 'How documents are ingested, chunked, and claims extracted' },
  { title: 'FIRE Extraction', path: 'docs/fire-extraction.md',
    desc: 'Confidence-gated iterative claim extraction details' },
  { title: 'Rhetorical Strategies', path: 'docs/rhetorical-strategies.md',
    desc: 'The argumentation strategies debaters employ' },
  { title: 'Epistemic Types', path: 'docs/epistemic-types.md',
    desc: 'Types of knowledge claims and their evaluation criteria' },
  { title: 'Emotional Registers', path: 'docs/emotional-registers.md',
    desc: 'Character voice and register design for debate personas' },
  { title: 'Computational Dialectics Comparison', path: 'docs/computational-dialectics-comparison.md',
    desc: 'How this system compares to other argumentation tools' },
  { title: 'Adaptive Debate Staging', path: 'docs/design/adaptive-debate-staging.md',
    desc: 'Convergence diagnostics and phase transition design' },
  { title: 'Full Methodology Paper', path: 'docs/academic-paper-draft.md',
    desc: 'Complete technical paper with algorithms, evaluation, and theoretical grounding' },
  { title: 'Epistemic Infrastructure Framing', path: 'research/comp-linguist/analyses/epistemic-infrastructure-framing.md',
    desc: 'The AI Rosetta Stone as epistemic infrastructure for multi-perspective policy analysis' },
  { title: 'Troubleshooting', path: 'docs/troubleshooting.md',
    desc: 'Known issues and their workarounds' },
] as const;

function getRuntime(): string {
  const target = import.meta.env.VITE_TARGET;
  if (target === 'web') return 'Container';
  if (typeof window !== 'undefined' && (window as any).electronAPI) return 'Electron';
  return 'Browser';
}

const isWeb = import.meta.env.VITE_TARGET === 'web';

export type HelpTab = 'about' | 'overview' | 'documentation' | 'methods' | 'shortcuts' | 'sbom' | 'licenses' | 'changelog' | 'my-cases';

const TABS: { id: HelpTab; label: string }[] = [
  { id: 'about', label: 'About' },
  { id: 'changelog', label: "What's New" },
  { id: 'overview', label: 'Overview' },
  { id: 'documentation', label: 'Documentation' },
  { id: 'methods', label: 'Methods' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'sbom', label: 'SBOM' },
  { id: 'licenses', label: 'Licenses' },
  ...(isWeb ? [{ id: 'my-cases' as const, label: 'My Cases' }] : []),
];

type SortCol = 'name' | 'version' | 'license';
type SortDir = 'asc' | 'desc';

const sbomSummary = (ossData as { summary: { name: string; version: string; license: string }[] }).summary;

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function SbomPanel() {
  const [filter, setFilter] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [lastClickedIdx, setLastClickedIdx] = useState<number | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);

  const filtered = useMemo(() => {
    const rows = sbomSummary.map((row, originalIndex) => ({ ...row, originalIndex }));
    const lc = filter.toLowerCase();
    const matching = lc ? rows.filter(r =>
      r.name.toLowerCase().includes(lc) ||
      r.version.toLowerCase().includes(lc) ||
      r.license.toLowerCase().includes(lc)
    ) : rows;
    matching.sort((a, b) => {
      let cmp: number;
      if (sortCol === 'version') {
        cmp = compareSemver(a.version, b.version);
      } else {
        cmp = a[sortCol].localeCompare(b[sortCol], undefined, { sensitivity: 'base' });
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return matching;
  }, [filter, sortCol, sortDir]);

  const handleSort = useCallback((col: SortCol) => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }, [sortCol]);

  const handleRowClick = useCallback((displayIdx: number, e: React.MouseEvent) => {
    setSelectedRows(prev => {
      const next = new Set(prev);
      if (e.shiftKey && lastClickedIdx !== null) {
        const start = Math.min(lastClickedIdx, displayIdx);
        const end = Math.max(lastClickedIdx, displayIdx);
        for (let i = start; i <= end; i++) next.add(i);
      } else if (e.ctrlKey || e.metaKey) {
        if (next.has(displayIdx)) next.delete(displayIdx); else next.add(displayIdx);
      } else {
        next.clear();
        next.add(displayIdx);
      }
      return next;
    });
    setLastClickedIdx(displayIdx);
  }, [lastClickedIdx]);

  const rowsToTsv = useCallback((rows: typeof filtered) => {
    const header = 'Package\tVersion\tLicense';
    const lines = rows.map(r => `${r.name}\t${r.version}\t${r.license}`);
    return header + '\n' + lines.join('\n');
  }, []);

  const showCopyFeedback = useCallback((msg: string) => {
    setCopyFeedback(msg);
    setTimeout(() => setCopyFeedback(null), 2000);
  }, []);

  const handleCopyAll = useCallback(() => {
    void navigator.clipboard.writeText(rowsToTsv(filtered)).then(
      () => showCopyFeedback(`Copied ${filtered.length} rows`),
      () => showCopyFeedback('Copy failed'),
    );
  }, [filtered, rowsToTsv, showCopyFeedback]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedRows.size > 0) {
        const rows = [...selectedRows].sort((a, b) => a - b).map(i => filtered[i]).filter(Boolean);
        if (rows.length === 0) return;
        e.preventDefault();
        void navigator.clipboard.writeText(rowsToTsv(rows)).then(
          () => showCopyFeedback(`Copied ${rows.length} row${rows.length !== 1 ? 's' : ''}`),
          () => showCopyFeedback('Copy failed'),
        );
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedRows, filtered, rowsToTsv, showCopyFeedback]);

  useEffect(() => { setSelectedRows(new Set()); setLastClickedIdx(null); }, [filter, sortCol, sortDir]);

  const sortArrow = (col: SortCol) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div className="help-section helpdialog-panel">
      <p className="helpdialog-panel-count">
        {filter
          ? `${filtered.length} of ${sbomSummary.length} packages`
          : `${sbomSummary.length} packages`
        }
      </p>
      <input
        type="text"
        placeholder="Filter packages..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
        className="helpdialog-filter-input"
      />
      <div className="helpdialog-table-wrap">
        <table className="helpdialog-sbom-table">
          <thead>
            <tr className="helpdialog-sbom-thead-row">
              <th
                onClick={() => handleSort('name')}
                className="helpdialog-sbom-th"
              >Package{sortArrow('name')}</th>
              <th
                onClick={() => handleSort('version')}
                className="helpdialog-sbom-th helpdialog-sbom-th-nowrap"
              >Version{sortArrow('version')}</th>
              <th
                onClick={() => handleSort('license')}
                className="helpdialog-sbom-th"
              >License{sortArrow('license')}</th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {filtered.map((row, i) => (
              <tr
                key={row.originalIndex}
                onClick={(e) => handleRowClick(i, e)}
                className="helpdialog-sbom-row"
                // eslint-disable-next-line local/no-inline-style -- row background computed from selection + row parity
                style={{
                  background: selectedRows.has(i) ? 'rgba(var(--accent-rgb, 59,130,246), 0.15)' : i % 2 === 0 ? 'transparent' : 'rgba(128,128,128,0.04)',
                }}
              >
                <td className="helpdialog-sbom-td">{row.name}</td>
                <td className="helpdialog-sbom-td">{row.version}</td>
                <td
                  className="helpdialog-sbom-td-license"
                  title={row.license}
                >{row.license}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={3} className="helpdialog-sbom-empty">No packages match &ldquo;{filter}&rdquo;</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="helpdialog-toolbar">
        <button className="btn btn-sm btn-ghost" onClick={handleCopyAll} title="Copy filtered rows as tab-separated text">
          Copy All as TSV
        </button>
        {copyFeedback && <span className="helpdialog-note-muted">{copyFeedback}</span>}
      </div>
    </div>
  );
}

interface LicenseGroup {
  packages: { name: string; version: string }[];
  licenseType: string;
  licenseText: string;
}
const licenseGroups = (ossData as { groups: LicenseGroup[] }).groups;

function LicensesPanel() {
  const [filter, setFilter] = useState('');
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const filtered = useMemo(() => {
    if (!filter) return licenseGroups;
    const lc = filter.toLowerCase();
    return licenseGroups.filter(g =>
      g.packages.some(p => p.name.toLowerCase().includes(lc)) ||
      g.licenseType.toLowerCase().includes(lc)
    );
  }, [filter]);

  const totalPackages = licenseGroups.reduce((s, g) => s + g.packages.length, 0);

  return (
    <div className="help-section helpdialog-panel">
      <p className="helpdialog-panel-count">
        {totalPackages} open-source packages used in this application.
      </p>
      <input
        type="text"
        placeholder="Filter packages..."
        value={filter}
        onChange={e => { setFilter(e.target.value); setExpandedIdx(null); }}
        className="helpdialog-filter-input"
      />
      <div className="helpdialog-license-list">
        {filtered.map((group, idx) => (
          <div key={idx}>
            <div
              onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
              className="helpdialog-license-group"
              // eslint-disable-next-line local/no-inline-style -- background computed from expanded state
              style={{
                background: expandedIdx === idx ? 'rgba(var(--accent-rgb, 59,130,246), 0.08)' : 'transparent',
              }}
            >
              <span className="helpdialog-license-caret">
                {expandedIdx === idx ? '\u25BC' : '\u25B6'}
              </span>
              <span className="helpdialog-license-names">
                {group.packages.map(p => p.name).join(', ')}
              </span>
              <span className="helpdialog-license-type">
                {group.licenseType}
              </span>
            </div>
            {expandedIdx === idx && (
              <div className="helpdialog-license-detail">
                <table className="helpdialog-license-table">
                  <tbody>
                    {group.packages.map(p => (
                      <tr key={p.name}>
                        <td className="helpdialog-license-pkg-name">{p.name}</td>
                        <td className="helpdialog-license-pkg-version">{p.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <pre className="helpdialog-license-text">
                  {group.licenseText}
                </pre>
              </div>
            )}
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="helpdialog-empty-note">No packages match "{filter}"</p>
        )}
      </div>
    </div>
  );
}

function ChangelogPanel() {
  return (
    <div className="help-section help-changelog">
      <div className="helpdialog-changelog-header">
        <span className="helpdialog-version-badge">
          v{__APP_VERSION__}
        </span>
        <span className="helpdialog-note-muted">Current version</span>
      </div>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{__CHANGELOG_MD__}</ReactMarkdown>
    </div>
  );
}

interface HelpDialogProps {
  onClose: () => void;
  initialTab?: HelpTab;
}

export function HelpDialog({ onClose, initialTab }: HelpDialogProps) {
  const [activeTab, setActiveTab] = useState<HelpTab>(initialTab ?? 'about');
  const [showSupportForm, setShowSupportForm] = useState(false);
  const { unreadCount, fetchCases: fetchSupportCases } = useSupportStore();
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 900, h: 600 });
  const [centered, setCentered] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizing = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  // Center on first render with viewport bounds checking
  useEffect(() => {
    if (centered) {
      const maxW = Math.max(400, window.innerWidth * 0.95);
      const maxH = Math.max(300, window.innerHeight * 0.95);
      const clampedW = Math.min(size.w, maxW);
      const clampedH = Math.min(size.h, maxH);
      const x = Math.max(0, (window.innerWidth - clampedW) / 2);
      const y = Math.max(0, (window.innerHeight - clampedH) / 2);
      setSize({ w: clampedW, h: clampedH });
      setPos({ x, y });
    }
  }, [centered, size.w, size.h]);

  // Fetch support cases on mount for unread badge (web only)
  useEffect(() => {
    if (isWeb) void fetchSupportCases();
  }, [fetchSupportCases]);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, table, ul, p')) return;
    e.preventDefault();
    setCentered(false);
    dragging.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      setPos({
        x: dragging.current.origX + (ev.clientX - dragging.current.startX),
        y: dragging.current.origY + (ev.clientY - dragging.current.startY),
      });
    };
    const onUp = () => { dragging.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [pos]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCentered(false);
    resizing.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      setSize({
        w: Math.max(400, resizing.current.origW + (ev.clientX - resizing.current.startX)),
        h: Math.max(300, resizing.current.origH + (ev.clientY - resizing.current.startY)),
      });
    };
    const onUp = () => { resizing.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [size]);

  const buildDate = new Date(__BUILD_DATE__);
  const formattedDate = buildDate.toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  }) + ' ' + buildDate.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="dialog help-dialog helpdialog-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        // eslint-disable-next-line local/no-inline-style -- width/height/left/top computed from drag + resize state
        style={{
          width: size.w, height: size.h, left: pos.x, top: pos.y,
        }}
      >
        <h3 className="helpdialog-title" onMouseDown={onDragStart}>AI Rosetta Stone Help</h3>

        <div className="helpdialog-body">
          <div className="helpdialog-tabs">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className="helpdialog-tab"
                // eslint-disable-next-line local/no-inline-style -- borderLeft/background/color computed from active tab
                style={{
                  borderLeft: t.id === activeTab ? '2px solid var(--focus-ring)' : '2px solid transparent',
                  background: t.id === activeTab ? 'rgba(var(--accent-rgb, 59,130,246), 0.08)' : 'transparent',
                  color: t.id === activeTab ? 'var(--focus-ring)' : 'var(--text-secondary)',
                }}
              >
                {t.label}
                {t.id === 'my-cases' && unreadCount > 0 && (
                  <span className="helpdialog-tab-badge">
                    {unreadCount}
                  </span>
                )}
              </button>
            ))}
            <div className="helpdialog-tab-sep" />
            <button
              className="helpdialog-tab helpdialog-tab-nav"
              onClick={() => {
                window.location.hash = '#your-activity';
                onClose();
              }}
            >
              Your Activity
            </button>
          </div>
          <div className="helpdialog-content">

        {activeTab === 'about' && (
          <div className="help-section help-about">
            <table className="help-shortcuts">
              <tbody>
                <tr><td className="help-key">Version</td><td>{__APP_VERSION__}</td></tr>
                <tr><td className="help-key">Built</td><td>{formattedDate}</td></tr>
                <tr><td className="help-key">Runtime</td><td>{getRuntime()}</td></tr>
              </tbody>
            </table>
            <p className="helpdialog-about-desc">
              AI Triad Research — multi-perspective research platform for AI policy/safety literature.
              Berkman Klein Center, 2026.
            </p>
            <p className="helpdialog-about-stack">
              Built with Electron 35, React 19, TypeScript, Vite, and Zustand.
              AI backends: Google Gemini, Anthropic Claude, Groq, OpenAI, DeepSeek, Ollama.
            </p>
          </div>
        )}

        {activeTab === 'overview' && (
          <div className="help-section helpdialog-prose">
            <p>
              AI Rosetta Stone manages the AI Triad taxonomy across three perspectives
              (Accelerationist, Safetyist, Skeptic), situations shared
              across perspectives, and documented conflicts between positions.
            </p>

            <h4>Main Tabs</h4>
            <p><strong>Accelerationist / Safetyist / Skeptic</strong> — Each perspective has nodes organized into BDI categories (Beliefs, Desires, Intentions).</p>
            <p><strong>Situations</strong> — Cross-cutting concepts showing how each perspective interprets the same issue.</p>
            <p><strong>Conflicts</strong> — Documented disagreements with source instances and analyst notes.</p>
            <p><strong>Cruxes</strong> — Core disagreements distilled from debate rounds and cross-perspective analysis.</p>
            <p><strong>Summaries</strong> — Document summaries from the ingestion pipeline (Electron only).</p>
            <p><strong>Validation</strong> — Data integrity checks for the taxonomy, surfacing missing fields, orphan nodes, and schema violations.</p>
            <p><strong>Debate</strong> — Multi-agent debates between Accelerationist, Safetyist, and Skeptic characters using a BDI agent architecture. Debates progress through clarification, argumentation rounds, synthesis, and harvest.</p>
            <p><strong>Chat</strong> — POVer Chat with brainstorm, inform, and decide conversation modes for free-form AI-assisted exploration.</p>

            <h4>Toolbar Panels</h4>
            <p><strong>Search</strong> — Full-text search with raw, wildcard, regex, and semantic modes. Scope by perspective and/or BDI category.</p>
            <p><strong>Intellectual Lineage</strong> — Trace the intellectual heritage and influences behind taxonomy nodes.</p>
            <p><strong>Edge Browser</strong> — Browse AIF-aligned typed edges (attack, support, inference) between nodes across the full taxonomy graph.</p>
            <p><strong>Policy Alignment</strong> — Map taxonomy nodes to policy actions from the shared policy registry.</p>
            <p><strong>Policy Dashboard</strong> — Aggregate view of policy action coverage and alignment across perspectives.</p>
            <p><strong>Possible Fallacies</strong> — Identify potential logical fallacies in node claims and debate arguments.</p>
            <p><strong>Vocabulary</strong> — Browse the controlled vocabulary used across the taxonomy.</p>
            <p><strong>Calibration</strong> — Review and calibrate confidence scores and QBAF base scores.</p>
            <p><strong>Console</strong> — Development console for inspecting state and debugging (admin only).</p>
            <p><strong>Prompts</strong> — Inspect AI prompt templates and view prompt diffs between versions.</p>

            <h4>AI &amp; Backends</h4>
            <p>
              Six AI backends are supported: Google Gemini, Anthropic Claude, Groq, OpenAI, DeepSeek, and Ollama (local).
              Models are configured in <code>ai-models.json</code> with per-backend defaults, debate tier assignments, and fallback chains.
              Models without a configured API key are auto-disabled in debate setup.
            </p>
            <p><strong>Fact-checking</strong> — Debate claims can be verified using Gemini's integrated web search (google_search tool).</p>
            <p><strong>Key Sharing</strong> — Share API keys between devices via AES-256-GCM encrypted QR codes (Settings).</p>

            <h4>Diagnostics &amp; Observability</h4>
            <p><strong>Flight Recorder</strong> — Always-on ring buffer capturing system events, errors, and debate telemetry. Dump manually with Ctrl+Alt+D or via named pipe.</p>
            <p><strong>Diagnostics Window</strong> — Detachable window showing debate convergence signals, verification status, document coverage, and real-time debate state.</p>
            <p><strong>Debate Chat</strong> — AI-powered diagnostic sidebar for interrogating debate state (Ctrl+Shift+D to toggle).</p>
            <p><strong>Analytics Dashboard</strong> — Usage analytics and session metrics.</p>

            <h4>General</h4>
            <p><strong>Pin</strong> — Pin any item to compare it side-by-side with the active item.</p>
            <p><strong>Resize</strong> — Drag the border between the list and detail panels to resize.</p>
            <p><strong>Themes</strong> — Light, Dark, BKC, Harvard, and System (auto) color schemes.</p>
            <p><strong>Zoom</strong> — Ctrl+= / Ctrl+- / Ctrl+0 to zoom in, out, or reset.</p>
          </div>
        )}

        {activeTab === 'documentation' && (
          <div className="help-section">
            {DOCS.map((doc) => (
              <p key={doc.path} className="helpdialog-doc-item">
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); void api.openExternal(`${REPO_URL}/blob/main/${doc.path}`); }}
                  className="helpdialog-doc-link"
                >
                  <strong>{doc.title}</strong>
                </a>
                {' — '}{doc.desc}
              </p>
            ))}
          </div>
        )}

        {activeTab === 'methods' && (
          <div className="help-section">
            <p>
              The system uses a <strong>neural-symbolic architecture</strong>: LLMs generate
              content while symbolic components provide structure, verification, and explanation.
            </p>
            <ul className="helpdialog-prose">
              <li><strong>QBAF</strong> — Quantitative Bipolar Argumentation Frameworks with DF-QuAD gradual semantics and BDI-aware base score calibration.
                {' '}<a href="#" onClick={(e) => { e.preventDefault(); void api.openExternal('https://aaai.org/papers/8-12874-discontinuity-free-decision-support-with-quantitative-argumentation-debates/'); }} className="helpdialog-ref-link">Rago et al. (2016)</a>
                {' '}Built on: <a href="#" onClick={(e) => { e.preventDefault(); void api.openExternal('https://www.sciencedirect.com/science/article/pii/000437029400041X'); }} className="helpdialog-ref-link">Dung (1995)</a>
              </li>
              <li><strong>BDI Framework</strong> — Belief-Desire-Intention agent characterization separating empirical claims, normative commitments, and strategic reasoning.
                {' '}<a href="#" onClick={(e) => { e.preventDefault(); void api.openExternal('https://cdn.aaai.org/ICMAS/1995/ICMAS95-042.pdf'); }} className="helpdialog-ref-link">Rao & Georgeff (1995)</a>;
                {' '}<a href="#" onClick={(e) => { e.preventDefault(); void api.openExternal('https://press.uchicago.edu/ucp/books/book/distributed/I/bo3629095.html'); }} className="helpdialog-ref-link">Bratman (1987)</a>
              </li>
              <li><strong>AIF</strong> — Argument Interchange Format vocabulary for typed attack/support relationships and scheme classification.
                {' '}<a href="#" onClick={(e) => { e.preventDefault(); void api.openExternal('https://dl.acm.org/doi/10.1017/S0269888906001044'); }} className="helpdialog-ref-link">Chesñevar et al. (2006)</a>
              </li>
              <li><strong>FIRE</strong> — Confidence-gated Iterative Extraction replacing single-shot claim extraction with per-claim verification.
                {' '}<a href="#" onClick={(e) => { e.preventDefault(); void api.openExternal('https://arxiv.org/abs/2411.00784'); }} className="helpdialog-ref-link">arXiv:2411.00784</a>
              </li>
              <li><strong>4-Stage Pipeline</strong> — Each debate turn: BRIEF → PLAN → DRAFT → CITE with per-stage temperatures</li>
              <li><strong>Adaptive Staging</strong> — Seven convergence diagnostics trigger phase transitions (confrontation → argumentation → concluding)</li>
              <li><strong>13-Scheme Taxonomy</strong> — Derived from Walton's argumentation schemes with scheme-specific critical questions.
                {' '}<a href="#" onClick={(e) => { e.preventDefault(); void api.openExternal('https://www.cambridge.org/core/books/argumentation-schemes/9AE7E4E6ABDE690565442B2BD516A8B6'); }} className="helpdialog-ref-link">Walton, Reed & Macagno (2008)</a>
              </li>
              <li><strong>14-Move Moderator</strong> — Six intervention families governed by pragma-dialectical theory; LLM recommends, engine validates against deterministic constraints.
                {' '}<a href="#" onClick={(e) => { e.preventDefault(); void api.openExternal('https://www.cambridge.org/us/catalogue/catalogue.asp?isbn=9780521537728'); }} className="helpdialog-ref-link">van Eemeren & Grootendorst (2004)</a>
              </li>
              <li><strong>Dialectic Traces</strong> — BFS traversal of the argument network producing human-readable narrative chains</li>
              <li><strong>DOLCE</strong> — Descriptive Ontology for Linguistic and Cognitive Engineering; foundational ontology informing the taxonomy's upper-level categories and cross-cutting situation semantics.
                {' '}<a href="#" onClick={(e) => { e.preventDefault(); void api.openExternal('https://arxiv.org/pdf/2308.01597'); }} className="helpdialog-ref-link">Borgo et al. (2023)</a>
              </li>
              <li><strong>Emotional Register</strong> — Lexicon-based per-statement affect detection (urgency, fear, hope, outrage, empathy) with phase-appropriateness scoring, operationalizing the &ldquo;Emotional Appeal&rdquo; dimension of computational argument-quality assessment.
                {' '}<a href="#" onClick={(e) => { e.preventDefault(); void api.openExternal('https://aclanthology.org/E17-1017/'); }} className="helpdialog-ref-link">Wachsmuth et al. (2017)</a>
              </li>
            </ul>
          </div>
        )}

        {activeTab === 'shortcuts' && (
          <div className="help-section">
            <h4 className="helpdialog-shortcuts-h4">General</h4>
            <table className="help-shortcuts">
              <tbody>
                <tr><td className="help-key">Ctrl + F</td><td>Open / close search</td></tr>
                <tr><td className="help-key">Ctrl + S</td><td>Save changes</td></tr>
                <tr><td className="help-key">Ctrl + =</td><td>Zoom in</td></tr>
                <tr><td className="help-key">Ctrl + -</td><td>Zoom out</td></tr>
                <tr><td className="help-key">Ctrl + 0</td><td>Reset zoom</td></tr>
                <tr><td className="help-key">Arrow Up/Down</td><td>Navigate items in list</td></tr>
                <tr><td className="help-key">Enter</td><td>Next search result</td></tr>
                <tr><td className="help-key">Shift + Enter</td><td>Previous search result</td></tr>
                <tr><td className="help-key">Escape</td><td>Close search / dialogs / navigate back</td></tr>
              </tbody>
            </table>
            <h4>Diagnostics &amp; Debug</h4>
            <table className="help-shortcuts">
              <tbody>
                <tr><td className="help-key">Ctrl + Shift + S</td><td>Capture screenshot (Electron only)</td></tr>
                <tr><td className="help-key">Ctrl + Alt + D</td><td>Dump flight recorder to disk</td></tr>
                <tr><td className="help-key">Ctrl + Shift + D</td><td>Toggle Debate Chat sidebar</td></tr>
                <tr><td className="help-key">Ctrl + L</td><td>Clear diagnostics chat (when input focused)</td></tr>
              </tbody>
            </table>
            <h4>Chat &amp; Comments</h4>
            <table className="help-shortcuts">
              <tbody>
                <tr><td className="help-key">Enter</td><td>Send message (chat / debate chat)</td></tr>
                <tr><td className="help-key">Ctrl + Enter</td><td>Submit comment</td></tr>
                <tr><td className="help-key">Arrow Up/Down</td><td>Browse prompt history (debate chat)</td></tr>
                <tr><td className="help-key">Tab</td><td>Autocomplete slash commands (debate chat)</td></tr>
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'sbom' && <SbomPanel />}

        {activeTab === 'licenses' && <LicensesPanel />}

        {activeTab === 'changelog' && <ChangelogPanel />}

        {activeTab === 'my-cases' && <MyCases />}

          </div>
        </div>

        <div className="dialog-actions">
          {isWeb && (
            <button className="btn btn-ghost" onClick={() => setShowSupportForm(true)}>Report a Problem</button>
          )}
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
        {showSupportForm && <SupportCaseForm onClose={() => setShowSupportForm(false)} />}

        {/* Resize handles: right edge, bottom edge, and corner */}
        <div onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setCentered(false);
          const start = { x: e.clientX, w: size.w };
          const onMove = (ev: MouseEvent) => setSize(s => ({ ...s, w: Math.max(400, start.w + (ev.clientX - start.x)) }));
          const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
        }} className="helpdialog-resize-e" />
        <div onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setCentered(false);
          const start = { y: e.clientY, h: size.h };
          const onMove = (ev: MouseEvent) => setSize(s => ({ ...s, h: Math.max(300, start.h + (ev.clientY - start.y)) }));
          const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
          window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
        }} className="helpdialog-resize-s" />
        <div
          onMouseDown={onResizeStart}
          className="helpdialog-resize-se"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" className="helpdialog-resize-icon">
            <path d="M14 14L8 14M14 14L14 8M14 14L5 5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </div>
      </div>
    </div>
  );
}
