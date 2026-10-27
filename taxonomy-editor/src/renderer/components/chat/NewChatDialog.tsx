// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useRef } from 'react';
import { useChatStore } from '../../hooks/useChatStore';
import { useTaxonomyStore, MODELS_BY_BACKEND, AI_BACKENDS } from '../../hooks/useTaxonomyStore';
import type { AIBackend } from '../../hooks/useTaxonomyStore/slices/settingsSlice';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useTierInfo, isFreeTier } from '../../hooks/useTierInfo';
import { POVER_INFO } from '../../types/debate';
import type { SpeakerId } from '../../types/debate';
import type { ChatMode } from '../../types/chat';
import { CHAT_MODE_INFO } from '../../types/chat';
import { AI_POVERS } from '@lib/debate/types';
import type { SeatTag } from '@lib/debate/types/session';
import { checkTagScope } from '@lib/debate/relevanceSelection';
import { backendSelectState, type BackendAvailabilityEntry } from '../shared/backendSelectState';
import { ChatTagPicker, tagBlockedReason } from './ChatTagPicker';
import './NewChatDialog.css';

interface NewChatDialogProps {
  onClose: () => void;
  /** Called with the new chat ID instead of opening a popout window. */
  onCreated?: (id: string) => void;
  /** Starter-chip prefill (t/4536): seeds mode + topic. When set, focus lands on the "Talk to"
   *  POVer choice instead of the topic textarea, since the topic is already filled in. */
  initialMode?: ChatMode;
  initialTopic?: string;
}
const MODES: ChatMode[] = ['brainstorm', 'inform', 'decide'];

const MODE_ICONS: Record<ChatMode, string> = {
  brainstorm: '\u2728', // sparkles
  inform: '\u{1F4D6}',  // open book
  decide: '\u2696\uFE0F',  // scales
};

export function NewChatDialog({ onClose, onCreated, initialMode, initialTopic }: NewChatDialogProps) {
  const { createChat } = useChatStore();
  const [mode, setMode] = useState<ChatMode>(initialMode ?? 'brainstorm');
  const [pover, setPover] = useState<Exclude<SpeakerId, 'user'>>('accelerationist');
  const [chatTag, setChatTag] = useState<SeatTag | undefined>(undefined);
  const [topic, setTopic] = useState(initialTopic ?? '');
  const [creating, setCreating] = useState(false);
  const firstPoverRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialTopic) firstPoverRef.current?.focus();
  }, [initialTopic]);
  const { aiBackend, geminiModel } = useTaxonomyStore();
  const globalModel = geminiModel;
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [selectedBackend, setSelectedBackend] = useState<AIBackend>(aiBackend);
  const availableModels = MODELS_BY_BACKEND[selectedBackend] || [];
  const [customModel, setCustomModel] = useState<string>(globalModel);
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});
  // t/2036: per-backend availability with `reason` (no_key #2 vs tier_restricted #3),
  // replacing the tierAvailable Set that conflated no-key with tier-blocked.
  const [availByReason, setAvailByReason] = useState<Record<string, BackendAvailabilityEntry>>({});
  const { tier: tierInfo } = useTierInfo();
  const freeTier = isFreeTier(tierInfo);

  useEffect(() => {
    const check = async () => {
      const status: Record<string, boolean> = {};
      for (const b of AI_BACKENDS) {
        try { status[b.value] = await api.hasApiKey(b.value); }
        catch (err) { status[b.value] = false; getGlobalRecorder()?.record({ type: 'system.error', component: 'new-chat-dialog', level: 'warn', message: `Failed to check API key for ${b.value}`, error: { name: (err as Error).name ?? 'Error', message: String(err) } }); }
      }
      setKeyStatus(status);
    };
    void check();
    void api.getAvailableBackends()
      .then(backends => setAvailByReason(Object.fromEntries(backends.map(b => [b.id, { available: b.available, reason: b.reason }]))))
      .catch((err) => { getGlobalRecorder()?.record({ type: 'system.error', component: 'new-chat-dialog', level: 'warn', message: 'Failed to load available backends', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); });
  }, []);

  const povNodes = useTaxonomyStore.getState()[pover]?.nodes ?? [];
  const tagScope = chatTag ? checkTagScope(povNodes, { tag: chatTag.pov_tag, mode: chatTag.tag_mode }) : null;
  const tagBlocked = !!tagBlockedReason(tagScope, chatTag?.tag_mode);
  const canStart = topic.trim().length > 0 && !tagBlocked;

  const handlePoverChange = (id: Exclude<SpeakerId, 'user'>) => {
    setPover(id);
    setChatTag(undefined); // tags are POV-specific
  };

  const handleStart = async () => {
    if (!canStart || creating) return;
    setCreating(true);
    const chatModelOverride = useCustomModel && customModel !== globalModel ? customModel : undefined;
    const id = await createChat(mode, pover, topic.trim(), chatModelOverride, chatTag);
    if (onCreated) {
      onCreated(id);
    } else {
      void api.openChatWindow(id, 'my');
    }
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog new-chat-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>New Chat</h2>

        <label className="new-chat-label">Mode</label>
        <div className="new-chat-modes">
          {MODES.map((m) => {
            const info = CHAT_MODE_INFO[m];
            return (
              <button
                key={m}
                className={`new-chat-mode-card${mode === m ? ' selected' : ''}`}
                data-mode={m}
                onClick={() => setMode(m)}
              >
                <span className="new-chat-mode-icon">{MODE_ICONS[m]}</span>
                <span className="new-chat-mode-label">{info.label}</span>
                <span className="new-chat-mode-desc">{info.description}</span>
              </button>
            );
          })}
        </div>

        <label className="new-chat-label">Talk to</label>
        <div className="new-chat-povers">
          {AI_POVERS.map((id, i) => {
            const info = POVER_INFO[id];
            return (
              <label
                key={id}
                className={`new-chat-pover-option${pover === id ? ' selected' : ''}`}
              >
                <input
                  ref={i === 0 ? firstPoverRef : undefined}
                  type="radio"
                  name="chatPover"
                  checked={pover === id}
                  onChange={() => handlePoverChange(id)}
                />
                <span
                  className="new-chat-pover-name"
                  // eslint-disable-next-line local/no-inline-style -- dynamic POVer color
                  style={{ color: info.color }}
                >
                  {info.label}
                </span>
                <span className="new-chat-pover-desc">{info.personality}</span>
              </label>
            );
          })}
        </div>
        <ChatTagPicker pov={pover} seatTag={chatTag} onChange={setChatTag} />

        <label className="new-chat-label">Topic</label>
        <textarea
          className="new-chat-topic"
          placeholder={CHAT_MODE_INFO[mode].placeholder}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          rows={3}
          autoFocus={!initialTopic}
        />

        <label className="new-chat-label">AI Model</label>
        <div className="new-chat-model-row">
          <label className="new-chat-model-toggle">
            <input
              type="checkbox"
              checked={useCustomModel}
              onChange={(e) => setUseCustomModel(e.target.checked)}
            />
            Use a different model for this chat
          </label>
          {useCustomModel && (
            <div className="new-chat-model-fields">
              <select
                className="new-chat-model-select"
                value={selectedBackend}
                onChange={(e) => {
                  const backend = e.target.value as AIBackend;
                  setSelectedBackend(backend);
                  const models = MODELS_BY_BACKEND[backend] || [];
                  if (models.length > 0) setCustomModel(models[0].value);
                }}
              >
                {AI_BACKENDS.map((b) => {
                  // t/2036: render every backend (no longer filter out non-tier ones).
                  // Free-tier-pool backends are usable without a key (platform key), so
                  // keep them plain+selectable; otherwise apply the 3-state helper
                  // (no-key→"(bring your own key)"; tier-forbidden→disabled "(sign in to use)").
                  const freeUsable = freeTier && !!tierInfo?.allowedBackends.includes(b.value);
                  const state = freeUsable
                    ? { selectable: true, suffix: '' }
                    : backendSelectState(availByReason[b.value], keyStatus[b.value] === true);
                  return (
                    <option key={b.value} value={b.value} disabled={!state.selectable}>
                      {b.label}{state.suffix}
                    </option>
                  );
                })}
              </select>
              <select
                className="new-chat-model-select"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
              >
                {availableModels.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          )}
          {!useCustomModel && (
            <span className="new-chat-model-info">Using global: {globalModel}</span>
          )}
        </div>

        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleStart} disabled={!canStart || creating}>
            {creating ? 'Creating...' : 'Start Chat'}
          </button>
        </div>
      </div>
    </div>
  );
}
