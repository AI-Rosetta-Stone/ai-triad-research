// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Barrel for the inquiry result contract (t/3574). Consumers import schemas, inferred types, and the
// shared `parseInquiryResult` from `lib/inquiry`. Per ADR-0002 §1 the dependency points FROM
// lib/debate INTO lib/inquiry, never the reverse — lib/inquiry must not import debate-engine logic.
// (parse.ts imports the ActionableError leaf-utility from lib/debate/errors, matching lib/ai-client's
// existing use of the same primitive; flagged to TL for a possible future extract to lib/errors.ts.)

export * from './schema.js';
export { parseInquiryResult } from './parse.js';
// Job-status vocabulary + truncation derivation, hoisted from server/inquiryJobs.ts (t/3609) so the
// server, Electron main, and renderer bridge all consume ONE definition instead of three copies.
export { isTerminalStatus, deriveTruncation, TRUNCATION_REASONS } from './jobStatus.js';
export type { InquiryJobStatus, InquiryPipelineStage } from './jobStatus.js';
// Answer export formatters (t/3624, epic t/3618) — JSON/MD/print-HTML, mirroring @lib/chat + @lib/debate.
export { inquiryToJson, inquiryToMarkdown, inquiryToPrintHtml, inquiryExportFilename } from './inquiryExport.js';
export type { InquiryExportOptions } from './inquiryExport.js';
// Field-classification matrix (t/3648) — single source of truth for the 3 exposure surfaces + fail-closed gate.
export { CLASSIFICATION, includedFields, dispositionFor } from './fieldClassification.js';
export type { Surface, Disposition, FieldPath } from './fieldClassification.js';
// Public no-login share projection (t/3648 part 2) — separate schema + constructive projector.
export { PublicInquiryShareSchema, PublicInquiryShareReadSchema, PUBLIC_INQUIRY_SHARE_VERSION, toPublicInquiryShare } from './publicShare.js';
export type { PublicInquiryShare, PublicInquiryShareRead } from './publicShare.js';
// Inquiry duration estimation (t/4751) — p50/p90 wall-clock estimate by fidelity + debater model.
export { estimateInquiryDuration } from './durationEstimate.js';
export type { InquiryFidelity, DurationEstimate } from './durationEstimate.js';
