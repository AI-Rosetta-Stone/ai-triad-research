// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { create } from 'zustand';
import type {
  ChatSession,
  ChatSessionSummary,
  ChatMode,
  ChatEntry,
} from '../types/chat';
import type { SpeakerId, TaxonomyRef } from '../types/debate';
import type { PovNode, CrossCuttingNode as SituationNode } from '../types/taxonomy';
import { useTaxonomyStore, getStoredModel } from './useTaxonomyStore';
import { extractHttpUrls } from '../../../../lib/url-fetch/extractHttpUrls';
import { mapErrorToUserMessage } from '../utils/errorMessages';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { api } from '@bridge';
import type { UrlContextMetadata } from '@lib/ai-client/index';
import { formatTaxonomyContext } from '../utils/taxonomyContext';
import type { TaxonomyContext, FormatContextConfig } from '../utils/taxonomyContext';
import { applyTagSelection, checkTagScope } from '@lib/debate/relevanceSelection';
import type { SeatTag, TagSelection } from '@lib/debate/types/session';
import { resolvePoverInfo } from '@lib/debate/tagSoulRegistry';
import type { PovInfo } from '@lib/debate/types';
import {
  chatSystemPrompt,
  chatOpeningPrompt,
  chatContinuationPrompt,
  CHAT_MODE_TEMPERATURE,
} from '../prompts/chat';

function generateId(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

function getConfiguredModel(): string {
  // eslint-disable-next-line @typescript-eslint/no-use-before-define -- store defined below, safe at call-time
  const chatModel = useChatStore.getState().chatModel;
  if (chatModel) return chatModel;
  return getStoredModel();
}

function isUrlContextMetadata(payload: unknown): payload is UrlContextMetadata {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.urlMetadata)) return false;
  return (p.urlMetadata as unknown[]).every(
    (e) => typeof e === 'object' && e !== null &&
      typeof (e as Record<string, unknown>).retrievedUrl === 'string' &&
      typeof (e as Record<string, unknown>).urlRetrievalStatus === 'string',
  );
}

async function streamChatWithProgress(
  systemInstruction: string,
  messages: { role: 'user' | 'model'; content: string }[],
  model: string,
  temperature: number,
  activity: string,
  set: (partial: Partial<ChatStore>) => void,
  onChunk: (chunk: string) => void,
  urlContext?: boolean,
  chatSessionId?: string,
): Promise<{ text: string; urlContextMetadata?: UrlContextMetadata }> {
  set({ chatActivity: activity, chatStreamingText: null });
  let urlContextMetadata: UrlContextMetadata | undefined;
  const unsubChunk = api.onChatStreamChunk(onChunk);
  const unsubMeta = api.onChatStreamUrlMetadata?.((payload) => {
    if (isUrlContextMetadata(payload)) {
      urlContextMetadata = payload;
      getGlobalRecorder()?.record({
        type: 'chat.url-context-result',
        component: 'chat-store',
        level: 'info',
        message: 'URL context metadata received',
        data: {
          entry_count: payload.urlMetadata.length,
          success_count: payload.urlMetadata.filter(e => e.urlRetrievalStatus === 'SUCCESS').length,
        },
      });
    } else {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-store', level: 'debug', message: 'onChatStreamUrlMetadata payload did not match UrlContextMetadata shape', error: { name: 'TypeError', message: 'Non-conforming url-context metadata', stack: '' } });
    }
  });
  try {
    const text = await api.startChatStream(systemInstruction, messages, model, temperature, urlContext, chatSessionId ? { chatSessionId } : undefined);
    return { text, urlContextMetadata };
  } finally {
    unsubChunk();
    unsubMeta?.();
    set({ chatStreamingText: null, chatActivity: null });
  }
}

function stripCodeFences(text: string): string {
  return text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
}

const CHAT_CONTEXT_CONFIG: FormatContextConfig = { maxNodes: 9999, maxDesires: 9999 };

/** The soul the chat's POVer speaks as: the tag soul when the chat is tagged (spec §1: it replaces the POV
 *  soul), else the base soul. Browser-safe tagSoulRegistry, never soulDocLoader. Throws if the tag has no
 *  soul, so a tagged chat never silently speaks in the base voice (t/3995). */
export function chatSoul(chat: Pick<ChatSession, 'pover' | 'pov_tag' | 'tag_mode'>): PovInfo {
  return resolvePoverInfo(chat.pover, chatTagSelection(chat)).soul;
}

/** The chat's tag selection, or undefined when untagged (t/3995). */
export function chatTagSelection(chat: Pick<ChatSession, 'pov_tag' | 'tag_mode'>): TagSelection | undefined {
  return chat.pov_tag && chat.tag_mode ? { tag: chat.pov_tag, mode: chat.tag_mode } : undefined;
}

/** The taxonomy a chat is given. Chat has no relevance ranking: every POV node is sent, except that a
 *  Scope-tagged chat is given only its tagged nodes (t/3995). Prioritize keeps every node; its ordering is
 *  applied by chatTaxonomyBlock through formatTaxonomyContext (t/3996). */
function getTaxonomyContext(pov: string, chat: Pick<ChatSession, 'id' | 'pov_tag' | 'tag_mode'>): TaxonomyContext {
  const state = useTaxonomyStore.getState();
  const povFile = state[pov as 'accelerationist' | 'safetyist' | 'skeptic'];
  const povNodes: PovNode[] = povFile?.nodes ?? [];
  const situationNodes: SituationNode[] = state.situations?.nodes ?? [];
  const tagSelection = chatTagSelection(chat);
  if (tagSelection?.mode === 'scope') {
    const { inScope, excluded, sufficient } = checkTagScope(povNodes, tagSelection);
    // Setup refuses a Scope tag below the minimum (t/3959), but tags can change after a chat starts. Per
    // TL t/3957#7 B(b), run time narrows only: WARN and continue with the scoped set, never widen or throw.
    if (!sufficient) {
      getGlobalRecorder()?.record({
        type: 'state.change', component: 'chat-store', level: 'warn',
        message: 'Scope-tagged chat is below the tag minimum; continuing with the scoped nodes only',
        data: { chat_session_id: chat.id, pov, tag: tagSelection.tag, in_scope: inScope.length, excluded: excluded.length },
      });
    }
    return { povNodes: inScope, situationNodes };
  }
  return { povNodes, situationNodes };
}

/** The formatted taxonomy block for a chat turn. A Prioritize chat passes its tagged ids (the shared
 *  applyTagSelection boost set) to formatTaxonomyContext, which sorts them first within each BDI category
 *  and marks them ▲ (t/3996). Scope was already narrowed by getTaxonomyContext. */
function chatTaxonomyBlock(pov: string, chat: Pick<ChatSession, 'id' | 'pov_tag' | 'tag_mode'>): string {
  const ctx = getTaxonomyContext(pov, chat);
  const tagSelection = chatTagSelection(chat);
  if (tagSelection?.mode !== 'prioritize') return formatTaxonomyContext(ctx, pov, undefined, CHAT_CONTEXT_CONFIG);
  const { boostIds } = applyTagSelection(ctx.povNodes, tagSelection);
  // Setup refuses a Prioritize tag with no tagged nodes (t/3959), but tags can change after a chat starts.
  if (boostIds.length === 0) {
    getGlobalRecorder()?.record({
      type: 'state.change', component: 'chat-store', level: 'warn',
      message: 'Prioritize-tagged chat has no tagged nodes left; nothing is ordered first',
      data: { chat_session_id: chat.id, pov, tag: tagSelection.tag },
    });
  }
  return formatTaxonomyContext(ctx, pov, undefined, {
    ...CHAT_CONTEXT_CONFIG,
    tagSelection: { taggedIds: new Set(boostIds), mode: 'prioritize' },
  });
}

/** Remove reasoning-model `<think>…</think>` / `<thinking>…</thinking>` blocks that
 *  DeepSeek/Groq prepend before their JSON, so they never leak into user-visible
 *  content (t/2453 — production bug: the raw think dump was rendered in chat). */
function stripThinkingBlocks(text: string): string {
  return text.replace(/<think(?:ing)?[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
}

/** Parse the POVer's JSON response into content + taxonomy refs */
export function parseChatResponse(text: string, model?: string): { response: string; taxonomyRefs: TaxonomyRef[] } {
  const stripped = stripThinkingBlocks(text);
  // Observability (t/2454): a stripped-vs-input difference means a reasoning model
  // (DeepSeek/Groq) emitted a <think> block. Record it so thinking-model incidents are
  // diagnosable from a flight-recorder dump without a live repro. Silent otherwise.
  if (stripped !== text.trim()) {
    getGlobalRecorder()?.record({
      type: 'chat.thinking-stripped',
      component: 'chat-store',
      level: 'debug',
      message: 'Stripped thinking block from model response',
      data: { model: model ?? null, blockLength: text.length - stripped.length },
    });
  }
  try {
    const parsed = JSON.parse(stripCodeFences(stripped));
    const response = parsed.response || stripped;
    // t/4675: the model sometimes returns a label-slugged id (e.g. "sit-153-ensuring-ai-
    // alignment-and-control" instead of "sit-153") that passes the string-shape check below but
    // never resolves in the taxonomy lookup, so the ref permanently shows "not found" to the
    // user. Mirror lib/debate/inquirySynthesis.ts's resolveNodeRefs: exact-match against the
    // known ids and drop+WARN on mismatch, rather than passing an unresolvable id downstream.
    const getLabelForId = useTaxonomyStore.getState().getLabelForId;
    const taxonomyRefs: TaxonomyRef[] = Array.isArray(parsed.taxonomy_refs)
      ? parsed.taxonomy_refs
        .filter((r: Record<string, unknown>) => r.node_id && typeof r.node_id === 'string')
        .map((r: Record<string, unknown>) => ({
          node_id: r.node_id as string,
          relevance: (r.relevance as string) || '',
        }))
        .filter((ref) => {
          const resolves = getLabelForId(ref.node_id) !== '';
          if (!resolves) {
            getGlobalRecorder()?.record({
              type: 'system.error',
              component: 'chat-store',
              level: 'warn',
              message: `Chat response cited an unresolvable taxonomy id, dropped: '${ref.node_id}'`,
            });
          }
          return resolves;
        })
      : [];
    return { response, taxonomyRefs };
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-store', level: 'debug', message: 'Chat response JSON parse failed, using raw text', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return { response: stripped, taxonomyRefs: [] };
  }
}

/** Build transcript text for context window */
function formatTranscriptForContext(transcript: ChatEntry[], poverLabel: string): string {
  if (transcript.length === 0) return '';
  const lines: string[] = [];
  for (const entry of transcript) {
    const speaker = entry.speaker === 'user' ? 'You' : entry.speaker === 'system' ? 'System' : poverLabel;
    lines.push(`${speaker}: ${entry.content}`);
  }
  return lines.join('\n\n');
}

function createChatGuard(get: () => { activeChatId: string | null }): () => boolean {
  const capturedId = get().activeChatId;
  return () => {
    if (capturedId !== get().activeChatId) {
      console.warn(`[chat] Active chat changed during async operation`);
      return false;
    }
    return true;
  };
}

// ── Store interface ──────────────────────────────────────

interface ChatStore {
  sessions: ChatSessionSummary[];
  sessionsLoading: boolean;

  activeChatId: string | null;
  activeChat: ChatSession | null;
  chatLoading: boolean;
  chatGenerating: boolean;
  chatError: string | null;
  chatStreamingText: string | null;
  chatActivity: string | null;
  chatModel: string | null;

  // Actions
  loadSessions: () => Promise<void>;
  /** `tag`: the chat's POV tag (t/3995); omit for an untagged chat. */
  createChat: (mode: ChatMode, pover: Exclude<SpeakerId, 'user'>, topic: string, chatModel?: string, tag?: SeatTag) => Promise<string>;
  loadChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  renameChat: (id: string, newTitle: string) => Promise<void>;
  changeMode: (mode: ChatMode) => Promise<void>;
  saveChat: () => Promise<void>;
  appendStreamingText: (chunk: string) => void;
  sendMessage: (message: string) => Promise<void>;
  generateOpening: () => Promise<void>;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: [],
  sessionsLoading: false,
  activeChatId: null,
  activeChat: null,
  chatLoading: false,
  chatGenerating: false,
  chatError: null,
  chatStreamingText: null,
  chatActivity: null,
  chatModel: null,

  loadSessions: async () => {
    set({ sessionsLoading: true });
    try {
      const raw = await api.listChatSessions();
      set({ sessions: raw as ChatSessionSummary[] });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-store', level: 'error', message: 'Failed to load chat sessions', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    } finally {
      set({ sessionsLoading: false });
    }
  },

  createChat: async (mode, pover, topic, chatModel, tag) => {
    const id = generateId();
    const now = nowISO();
    const session: ChatSession = {
      id,
      title: topic.length > 60 ? topic.slice(0, 57) + '...' : topic,
      created_at: now,
      updated_at: now,
      mode,
      topic,
      pover,
      transcript: [],
      chat_model: chatModel,
      // Absent (not undefined-valued) when untagged, so untagged sessions serialize as before.
      ...(tag ? { pov_tag: tag.pov_tag, tag_mode: tag.tag_mode } : {}),
    };
    await api.saveChatSession(session);
    api.trackEvent('chat_start', 'chat', { mode, pover });
    const sessions = await api.listChatSessions();
    set({ sessions: sessions as ChatSessionSummary[] });
    return id;
  },

  loadChat: async (id) => {
    set({ chatLoading: true, chatError: null, chatGenerating: false });
    try {
      const raw = await api.loadChatSession(id);
      const session = raw as ChatSession;
      set({
        activeChatId: session.id,
        activeChat: session,
        chatModel: session.chat_model || null,
      });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-store', level: 'error', message: 'Failed to load chat session', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ chatError: `Failed to load chat: ${err}` });
    } finally {
      set({ chatLoading: false });
    }
  },

  deleteChat: async (id) => {
    try {
      await api.deleteChatSession(id);
      const { activeChatId } = get();
      if (activeChatId === id) {
        set({ activeChatId: null, activeChat: null, chatModel: null });
      }
      const sessions = await api.listChatSessions();
      set({ sessions: sessions as ChatSessionSummary[] });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-store', level: 'error', message: 'Failed to delete chat session', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ chatError: `Failed to delete chat: ${err}` });
    }
  },

  renameChat: async (id, newTitle) => {
    const { activeChat, sessions } = get();
    if (activeChat && activeChat.id === id) {
      const updated = { ...activeChat, title: newTitle, updated_at: nowISO() };
      set({ activeChat: updated });
      await api.saveChatSession(updated);
    } else {
      // Load, rename, save
      try {
        const raw = await api.loadChatSession(id);
        const session = raw as ChatSession;
        session.title = newTitle;
        session.updated_at = nowISO();
        await api.saveChatSession(session);
      } catch (err) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-store', level: 'error', message: 'Failed to rename chat session', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      }
    }
    // Update session list
    set({
      sessions: sessions.map(s => s.id === id ? { ...s, title: newTitle, updated_at: nowISO() } : s),
    });
  },

  changeMode: async (mode) => {
    const { activeChat } = get();
    if (!activeChat) return;
    const updated = { ...activeChat, mode, updated_at: nowISO() };
    set({ activeChat: updated });
    await api.saveChatSession(updated);
    // Update session list
    const sessions = await api.listChatSessions();
    set({ sessions: sessions as ChatSessionSummary[] });
  },

  saveChat: async () => {
    const { activeChat } = get();
    if (!activeChat) return;
    const updated = { ...activeChat, updated_at: nowISO() };
    set({ activeChat: updated });
    await api.saveChatSession(updated);
  },

  appendStreamingText: (chunk) => {
    set((state) => ({ chatStreamingText: (state.chatStreamingText ?? '') + chunk }));
  },

  generateOpening: async () => {
    const { activeChat, saveChat, chatGenerating } = get();
    if (!activeChat || activeChat.transcript.length > 0 || chatGenerating) return;

    const isStillValid = createChatGuard(get);
    set({ chatGenerating: true, chatError: null, chatStreamingText: null });

    try {
      const info = chatSoul(activeChat);
      const taxonomyBlock = chatTaxonomyBlock(info.pov, activeChat);
      const model = getConfiguredModel();
      const temperature = CHAT_MODE_TEMPERATURE[activeChat.mode];

      const systemInstruction = chatSystemPrompt(
        info.label, info.pov, info.personality,
        activeChat.mode, activeChat.topic, taxonomyBlock,
      );
      const userContent = chatOpeningPrompt(activeChat.mode, activeChat.topic);

      const { text: fullText } = await streamChatWithProgress(
        systemInstruction,
        [{ role: 'user', content: userContent }],
        model,
        temperature,
        `${info.label} is thinking...`,
        set,
        (chunk) => get().appendStreamingText(chunk),
        undefined,
        activeChat.id,
      );

      if (!isStillValid()) return;

      const { response, taxonomyRefs } = parseChatResponse(fullText, model);

      const entry: ChatEntry = {
        id: generateId(),
        timestamp: nowISO(),
        speaker: activeChat.pover,
        content: response,
        taxonomy_refs: taxonomyRefs,
      };

      const updated = {
        ...get().activeChat!,
        transcript: [...get().activeChat!.transcript, entry],
        updated_at: nowISO(),
      };
      set({ activeChat: updated });
      await api.saveChatSession(updated);

      // Update session list
      const sessions = await api.listChatSessions();
      set({ sessions: sessions as ChatSessionSummary[] });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-store', level: 'error', message: 'Failed to generate opening message', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ chatError: `Failed to start conversation: ${mapErrorToUserMessage(err)}`, chatStreamingText: null });
      // createChat pre-saved an empty session before generation; the opening never landed, so remove
      // it from storage + the sidebar list rather than leaving a stale empty chat (t/2491). Cleanup
      // failures must not mask the original error, so they're swallowed after being recorded.
      try {
        await api.deleteChatSession(activeChat.id);
        const sessions = await api.listChatSessions();
        set({ sessions: sessions as ChatSessionSummary[] });
      } catch (cleanupErr) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-store', level: 'warn', message: 'Failed to clean up empty chat session after opening failure', error: { name: (cleanupErr as Error).name ?? 'Error', message: String(cleanupErr), stack: (cleanupErr as Error).stack } });
      }
    } finally {
      set({ chatGenerating: false });
    }
  },

  sendMessage: async (message) => {
    const { activeChat, chatGenerating } = get();
    if (!activeChat || !message.trim() || chatGenerating) return;

    const isStillValid = createChatGuard(get);
    set({ chatGenerating: true, chatError: null, chatStreamingText: null });

    // Add user message to transcript
    const userEntry: ChatEntry = {
      id: generateId(),
      timestamp: nowISO(),
      speaker: 'user',
      content: message.trim(),
      taxonomy_refs: [],
    };

    const withUserMsg = {
      ...activeChat,
      transcript: [...activeChat.transcript, userEntry],
      updated_at: nowISO(),
    };
    set({ activeChat: withUserMsg });

    getGlobalRecorder()?.record({
      type: 'chat.user-message',
      component: 'chat-store',
      level: 'info',
      message: 'User sent chat message',
      data: {
        message_text: message.trim().slice(0, 500),
        chat_session_id: activeChat.id,
        pover: activeChat.pover,
        transcript_length: withUserMsg.transcript.length,
      },
    });

    try {
      const info = chatSoul(activeChat);
      const taxonomyBlock = chatTaxonomyBlock(info.pov, activeChat);
      const model = getConfiguredModel();
      const temperature = CHAT_MODE_TEMPERATURE[activeChat.mode];

      const detectedUrls = extractHttpUrls(message.trim());
      const urlDetected = detectedUrls.length > 0;
      const urlContext = urlDetected;
      getGlobalRecorder()?.record({
        type: 'chat.url-context-decision',
        component: 'chat-store',
        level: 'info',
        message: 'URL context gating decision',
        data: {
          url_detected: urlDetected,
          url_context_enabled: urlContext,
          gating_reason: !urlDetected ? 'no-url' : 'enabled',
          ingestion_path: urlContext ? 'provider' : 'none',
          model,
        },
      });
      const systemInstruction = chatSystemPrompt(
        info.label, info.pov, info.personality,
        activeChat.mode, activeChat.topic, taxonomyBlock,
        urlContext,
      );
      const transcriptText = formatTranscriptForContext(
        withUserMsg.transcript, info.label,
      );
      // PQ-7: Extract prior claims from POVer's responses for consistency tracking
      const priorClaims = withUserMsg.transcript
        .filter(e => e.speaker !== 'user' && e.content.length > 20)
        .map(e => {
          // Take the first substantive sentence as a claim summary
          const firstSentence = e.content.match(/^[^.!?]+[.!?]/)?.[0] ?? e.content.slice(0, 120);
          return firstSentence.trim();
        })
        .filter(Boolean);
      const userContent = chatContinuationPrompt(message.trim(), transcriptText, priorClaims);

      const activity = urlContext
        ? `Fetching page for ${info.label}…`
        : `${info.label} is thinking…`;
      const { text: fullText, urlContextMetadata } = await streamChatWithProgress(
        systemInstruction,
        [{ role: 'user', content: userContent }],
        model,
        temperature,
        activity,
        set,
        (chunk) => get().appendStreamingText(chunk),
        urlContext,
        activeChat.id,
      );

      if (!isStillValid()) return;

      const { response, taxonomyRefs } = parseChatResponse(fullText, model);

      const poverEntry: ChatEntry = {
        id: generateId(),
        timestamp: nowISO(),
        speaker: activeChat.pover,
        content: response,
        taxonomy_refs: taxonomyRefs,
        ...(urlContextMetadata && { url_context_metadata: urlContextMetadata }),
      };

      const updated = {
        ...get().activeChat!,
        transcript: [...get().activeChat!.transcript, poverEntry],
        updated_at: nowISO(),
      };
      set({ activeChat: updated });
      await api.saveChatSession(updated);

      // Update session list
      const sessions = await api.listChatSessions();
      set({ sessions: sessions as ChatSessionSummary[] });
    } catch (err) {
      if (!isStillValid()) return;
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-store', level: 'error', message: 'Failed to send chat message', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      set({ chatError: `Response failed: ${mapErrorToUserMessage(err)}`, chatStreamingText: null });
    } finally {
      set({ chatGenerating: false });
    }
  },
}));
