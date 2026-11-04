# Chat Tool: Theory of Operations

## Overview

This document describes how the Chat tool operates — the technical and interaction patterns that enable the Chat component to function as intended in the taxonomy-editor. It covers the system architecture, data flow, and user interaction model.

## System Architecture

### Core Components

- **Chat Interface** — React component in `taxonomy-editor/src/renderer/components/chat/`
- **Message Management** — State management for conversation history, turn tracking
- **Debate Engine Integration** — Connection to `lib/debate/` BDI agents (Accelerationist, Safetyist, Skeptic)
- **Context Provider** — Passes selected taxonomy node(s) to the debate engine
- **Response Renderer** — Formats debate engine output for display

### Data Flow

1. User enters a question in the Chat input
2. Selected taxonomy context (POV, node, claim) is gathered
3. Question + context is sent to the appropriate debate agent
4. Debate engine processes the query using BDI reasoning
5. Response is formatted and displayed in the chat stream
6. User can follow up or switch context

## Interaction Patterns

### POV Switching

Users can ask the same question from different POV perspectives (Accelerationist, Safetyist, Skeptic, Consensus Context) without clearing conversation history. The chat maintains a "current POV" which can be switched via a control.

### Context Switching

When a user selects a different node in the main taxonomy, the Chat tool can update its context to reason about that node. Existing conversation history is preserved.

### Turn Tracking

Each message includes metadata: timestamp, POV, agent role, selected node reference, and reasoning chain (when available).

## User Interaction Model

- **Single Turn:** User asks a question, agent responds
- **Multi-Turn Dialogue:** Follow-up questions without context switching
- **Cross-POV Comparison:** Ask the same question to different agents in sequence
- **Contextual Exploration:** Start at a node, ask related questions, discover connections

## Performance Considerations

- Debate engine response latency should be <2s for 95th percentile
- Chat UI remains responsive during response generation
- Historical context (previous turns) fed to debate engine for coherence
- Response streaming (if supported) should show partial results

---

*This is a placeholder document. Content will be expanded and detailed as the Chat tool implementation progresses.*
