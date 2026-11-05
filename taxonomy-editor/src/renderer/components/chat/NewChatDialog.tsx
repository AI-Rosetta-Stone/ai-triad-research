// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useRef } from 'react';
import { useChatStore } from '../../hooks/useChatStore';
import { useTaxonomyStore, AI_BACKENDS } from '../../hooks/useTaxonomyStore';
import type { AIBackend } from '../../hooks/useTaxonomyStore/slices/settingsSlice';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useTierInfo, isFreeTier } from '../../hooks/useTierInfo';
import { POVER_INFO } from '../../types/debate';
import type { SpeakerId } from '../../types/debate';
import type { ChatMode } from '../../types/chat';
import { CHAT_MODE_INFO } from '../../types/chat';
import { CHAT_MODE_TEMPERATURE } from '../../prompts/chat';
import { AI_POVERS } from '@lib/debate/types';
import type { SeatTag } from '@lib/debate/types/session';
import { checkTagScope } from '@lib/debate/relevanceSelection';
import { backendSelectState, type BackendAvailabilityEntry } from '../shared/backendSelectState';
import { ModelPicker } from '../shared/ModelPicker';
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
  // t/4774 AC3: the slider follows the selected mode's default until the user moves it — a dirty
  // flag, not a derived value, since "follow mode until edited" needs to remember whether the user
  // touched it (a plain `CHAT_MODE_TEMPERATURE[mode]` derivation would also reset an edited value).
  const [temperature, setTemperature] = useState<number>(CHAT_MODE_TEMPERATURE[initialMode ?? 'brainstorm']);
  const [temperatureDirty, setTemperatureDirty] = useState(false);
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
  const [selectedBackend, setSelectedBackend] = useState<AIBackend>(aiBackend);
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

  const handleModeChange = (m: ChatMode) => {
    setMode(m);
    if (!temperatureDirty) setTemperature(CHAT_MODE_TEMPERATURE[m]);
  };

  const handlePoverChange = (id: Exclude<SpeakerId, 'user'>) => {
    setPover(id);
    setChatTag(undefined); // tags are POV-specific
  };

  const handleStart = async () => {
    if (!canStart || creating) return;
    setCreating(true);
    const chatModelOverride = customModel !== globalModel ? customModel : undefined;
    const id = await createChat(mode, pover, topic.trim(), chatModelOverride, chatTag, temperature);
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
                onClick={() => handleModeChange(m)}
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
        <ModelPicker
          idPrefix="new-chat"
          family={selectedBackend}
          model={customModel}
          onFamilyChange={setSelectedBackend}
          onModelChange={setCustomModel}
          // t/4774: no defaultModelId — the "(default)" suffix is already baked into the model's
          // own picker.label from ai-models.json (settingsSlice.ts:217); passing it here double-
          // labelled the default model "(default) (default)" (found live, electron-mcp).
          backendState={(backend) => {
            // t/2036: render every backend (no longer filter out non-tier ones). Free-tier-pool
            // backends are usable without a key (platform key), so keep them plain+selectable;
            // otherwise apply the 3-state helper (no-key -> "(bring your own key)"; tier-forbidden
            // -> disabled "(sign in to use)").
            const freeUsable = freeTier && !!tierInfo?.allowedBackends.includes(backend);
            return freeUsable
              ? { selectable: true, suffix: '' }
              : backendSelectState(availByReason[backend], keyStatus[backend] === true);
          }}
          temperature={{
            value: temperature,
            onChange: (v) => { setTemperature(v); setTemperatureDirty(true); },
            // t/4774 AC3: shows the mode's default, not a fixed "0.8".
            hint: `0 = deterministic, 2 = most varied. ${CHAT_MODE_INFO[mode].label}'s default is ${CHAT_MODE_TEMPERATURE[mode]}.`,
          }}
        />

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
