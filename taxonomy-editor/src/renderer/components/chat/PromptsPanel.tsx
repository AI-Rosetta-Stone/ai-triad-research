// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById } from '../../hooks/useTaxonomyStore/superseded';
import { PROMPT_CATALOG, type PromptCatalogEntry, type PromptGroup } from '../../data/promptCatalog';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { SearchWithHistory } from '../shared/SearchWithHistory';

const GROUP_LABELS: Record<PromptGroup, string> = {
  'debate-setup': 'Debate Setup',
  'debate-turns': 'Debate Turns',
  'debate-analysis': 'Debate Analysis',
  'moderator': 'Moderator',
  'chat': 'Chat',
  'taxonomy': 'Taxonomy',
  'research': 'Research',
  'powershell': 'PowerShell Backend',
  'oped': 'Op-Ed',
};
import { PromptInspector } from './PromptInspector';
import './PromptsPanel.css';

interface PromptsPanelProps {
  onSelectPrompt: (entry: PromptCatalogEntry | null) => void;
  onInspectorToggle?: (active: boolean) => void;
}

type PromptsPanelTab = 'catalog' | 'inspector';

export function PromptsPanel({ onSelectPrompt, onInspectorToggle }: PromptsPanelProps) {
  const [panelTab, setPanelTab] = useState<PromptsPanelTab>('catalog');

  const switchTab = (tab: PromptsPanelTab) => {
    setPanelTab(tab);
    onInspectorToggle?.(tab === 'inspector');
  };
  const selectedNode: { id: string; label: string; description: string } | null = useTaxonomyStore(
    (s) => {
      const nodeId = s.selectedNodeId;
      if (!nodeId) return null;
      // t/4359 — state.<pov>.nodes holds only selectable nodes post-t/4355; a cited/selected id
      // may be superseded, so look it up across the full set (superseded included), not the
      // selectable list. Situations aren't held aside, so they stay a plain array lookup.
      const node = allNodesById(s).get(nodeId);
      if (node) return node;
      return s.situations?.nodes.find(n => n.id === nodeId) ?? null;
    },
  );

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectionTick, setSelectionTick] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const { entries, matchFields } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return { entries: PROMPT_CATALOG, matchFields: new Map<string, string[]>() };
    const matched: PromptCatalogEntry[] = [];
    const fields = new Map<string, string[]>();
    for (const entry of PROMPT_CATALOG) {
      const hits: string[] = [];
      if (entry.title.toLowerCase().includes(q)) hits.push('title');
      if (entry.description.toLowerCase().includes(q)) hits.push('description');
      if (entry.template.toLowerCase().includes(q)) hits.push('template');
      if (entry.purpose?.toLowerCase().includes(q)) hits.push('purpose');
      if (hits.length > 0) {
        matched.push(entry);
        fields.set(entry.id, hits);
      }
    }
    return { entries: matched, matchFields: fields };
  }, [searchQuery]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, entries.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      }
    };
    const el = listRef.current;
    el?.addEventListener('keydown', handler);
    return () => el?.removeEventListener('keydown', handler);
  }, [entries.length]);

  // Notify parent of selection (selectionTick forces re-fire on re-click)
  // Only fire when catalog tab is active — inspector doesn't need prompt selection
  useEffect(() => {
    if (panelTab !== 'catalog') return;
    const entry = entries[selectedIndex] ?? null;
    onSelectPrompt(entry);
  }, [selectedIndex, selectionTick, entries, onSelectPrompt, panelTab]);

  // Auto-focus
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  return (
    <div className="prompts-panel" ref={listRef} tabIndex={0}>
      <div className="prompts-panel-header">
        <div className="prompts-panel-tabs">
          <button
            className={`prompts-panel-tab ${panelTab === 'catalog' ? 'prompts-panel-tab-active' : ''}`}
            onClick={() => switchTab('catalog')}
          >Catalog</button>
          <button
            className={`prompts-panel-tab ${panelTab === 'inspector' ? 'prompts-panel-tab-active' : ''}`}
            onClick={() => switchTab('inspector')}
          >Inspector</button>
        </div>
        <span className="prompts-panel-count">{searchQuery ? `${entries.length}/${PROMPT_CATALOG.length}` : entries.length}</span>
      </div>
      {panelTab === 'inspector' ? (
        <PromptInspector />
      ) : (
      <>
      <div className="prompts-panel-search-wrap">
        <SearchWithHistory
          area="prompts"
          inputRef={searchRef}
          placeholder="Search prompt text..."
          value={searchQuery}
          onChange={(v) => { setSearchQuery(v); setSelectedIndex(0); }}
          className="search-panel-text-input"
        />
      </div>
      {selectedNode && !searchQuery && (
        <div className="prompts-panel-context">
          Selected: <strong>{selectedNode.label}</strong>
        </div>
      )}
      <div className="prompts-panel-list">
        {(() => {
          let lastGroup: PromptGroup | null = null;
          return entries.map((entry, i) => {
            const showHeader = entry.group !== lastGroup;
            lastGroup = entry.group;
            return (
              <div key={entry.id}>
                {showHeader && (
                  <div className="prompts-panel-group-header">{GROUP_LABELS[entry.group]}</div>
                )}
                <div
                  className={`prompts-panel-item${i === selectedIndex ? ' selected' : ''}${entry.id === 'research' ? ' prompts-panel-research' : ''}`}
                  onClick={() => { setSelectedIndex(i); setSelectionTick(t => t + 1); }}
                >
                  <span className="prompts-panel-item-title">{entry.title}</span>
                  <span className="prompts-panel-item-source">{entry.source}</span>
                  {matchFields.has(entry.id) && (
                    <span className="prompts-panel-item-match">
                      {matchFields.get(entry.id)!.join(', ')}
                    </span>
                  )}
                </div>
              </div>
            );
          });
        })()}
      </div>
      </>
      )}
    </div>
  );
}

interface PromptDetailPanelProps {
  entry: PromptCatalogEntry | null;
}

export function PromptDetailPanel({ entry }: PromptDetailPanelProps) {
  const selectedNodeId = useTaxonomyStore((s) => s.selectedNodeId);
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    const s = useTaxonomyStore.getState();
    // t/4359 — same fix as PromptsPanel's selector above: look up across the full node set
    // (superseded included), not just the selectable state.<pov>.nodes list.
    const node = allNodesById(s).get(selectedNodeId);
    if (node) return node;
    return s.situations?.nodes.find(n => n.id === selectedNodeId) ?? null;
  }, [selectedNodeId]);

  const [editText, setEditText] = useState('');
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Generate prompt text based on entry and selected node
  const generatePromptText = useCallback(() => {
    if (!entry) return '';
    if (entry.id === 'research') {
      if (!selectedNode) return '(Select a taxonomy node first, then select Research to generate a prompt)';
      return entry.generate!(selectedNode.label, selectedNode.description);
    }
    if (entry.generate && selectedNode) {
      return entry.generate(selectedNode.label, selectedNode.description);
    }
    return entry.template;
  }, [entry, selectedNode]);

  // Update edit text when entry or node changes; auto-copy & focus for Research
  useEffect(() => {
    const text = generatePromptText();
    setEditText(text);
    setCopied(false);
    // Auto-copy and focus textarea when Research generates a real prompt
    if (entry?.id === 'research' && selectedNode && text && !text.startsWith('(')) {
      api.clipboardWriteText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }).catch((err) => {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'prompts-panel', level: 'debug', message: 'Auto-copy to clipboard failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      });
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [generatePromptText]);

  const handleCopy = async () => {
    try {
      await api.clipboardWriteText(editText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'prompts-panel',
        level: 'debug',
        message: 'Failed to write prompt text to clipboard',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  };

  if (!entry) {
    return <div className="detail-panel-empty">Select a prompt to view</div>;
  }

  return (
    <div className="prompt-detail">
      <div className="prompt-detail-header">
        <h2 className="prompt-detail-title">{entry.title}</h2>
        <div className="prompt-detail-actions">
          <button
            className={`btn btn-sm${copied ? '' : ' btn-ghost'}`}
            onClick={handleCopy}
          >
            {copied ? '\u2713 Copied!' : 'Copy'}
          </button>
        </div>
      </div>
      <div className="prompt-detail-desc">{entry.description}</div>
      <div className="prompt-detail-editor">
        <textarea
          ref={textareaRef}
          className="prompt-detail-textarea"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
