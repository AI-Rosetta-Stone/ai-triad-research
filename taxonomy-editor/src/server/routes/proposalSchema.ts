// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/641 (t/629 follow-up; TL p/50#187, Security p/228#36, SO p/269#14): PUT /api/proposals/:filename commits its body to
// the root of the PUBLIC data repo, so the body is validated against the taxonomy-proposal file shape first:
//   - known fields only (anything else is dropped, never committed);
//   - every string has a length cap, and the proposals list has a count cap;
//   - the serialized file has a byte cap;
//   - no string may look like an email address (a personal identifier has no place in a public proposal file).
// The shape is the one the proposal pipeline writes and ProposalReviewDialog edits (status is the field a review changes).

import { z } from 'zod';

export const PROPOSAL_FILE_MAX_BYTES = 256 * 1024;
export const PROPOSAL_MAX_COUNT = 500;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const text = (max: number) => z.string().max(max).refine(s => !EMAIL.test(s), { message: 'must not contain an email address' });
const id = z.string().regex(/^[a-z0-9-]{1,64}$/);

// A SPLIT child or a DEPTH_EXPAND sub-group (Invoke-ProposalApply.ps1 reads suggested_id, label, description, an optional
// category, and for a sub-group the assigned_children it re-parents).
const ChildSchema = z.object({
  suggested_id: id,
  label: text(200),
  description: text(2000),
  category: z.string().regex(/^[A-Za-z /-]{1,48}$/).nullable().optional(),
  pov: z.string().regex(/^[a-z-]{1,32}$/).nullable().optional(),
  assigned_children: z.array(id).max(200).optional(),
}).strip();

// t/641 (Security p/93#98): every field Invoke-ProposalApply needs is KEPT. A status-only save from the review dialog
// must not drop children, merge_node_ids, surviving_node_id or new_parent_id, or SPLIT, MERGE, REORDER and
// DEPTH_EXPAND proposals would become unappliable without an error. Shape checked against taxonomy-proposal.prompt
// and the real files in taxonomy/proposals/ (category is null on situation proposals; status is absent until reviewed).
const ProposalSchema = z.object({
  action: z.enum(['NEW', 'SPLIT', 'MERGE', 'RELABEL', 'REORDER', 'DEPTH_EXPAND', 'WIDTH_EXPAND']),
  target_node_id: id.nullable(),
  suggested_id: id.nullable(),
  pov: z.string().regex(/^[a-z-]{1,32}$/),
  category: z.string().regex(/^[A-Za-z /-]{1,48}$/).nullable(),
  label: text(200).nullable(), // null on MERGE/REORDER proposals in real files
  description: text(2000).nullable(),
  rationale: text(4000),
  evidence_doc_ids: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,128}$/)).max(200),
  evidence_count: z.number().int().min(0).max(100_000),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  children: z.array(ChildSchema).max(50).nullable().optional(),
  merge_node_ids: z.array(id).max(50).nullable().optional(),
  surviving_node_id: id.nullable().optional(),
  new_parent_id: id.nullable().optional(),
  density_signal: text(500).nullable().optional(),
  vocabulary_terms: z.array(text(100)).max(100).nullable().optional(),
}).strip();

const ProposalFileSchema = z.object({
  generated_at: z.string().max(40),
  model: z.string().regex(/^[A-Za-z0-9._:/-]{1,80}$/),
  taxonomy_version: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
  summary_count: z.number().int().min(0).max(1_000_000),
  proposals: z.array(ProposalSchema).max(PROPOSAL_MAX_COUNT),
}).strip();

export type ProposalFile = z.infer<typeof ProposalFileSchema>;

/** The body to commit, with unknown fields dropped, or the reason it is refused. */
export function validateProposalFile(body: unknown): { ok: true; value: ProposalFile } | { ok: false; reason: string } {
  const parsed = ProposalFileSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `${first.path.join('.') || 'body'}: ${first.message}` };
  }
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data, null, 2), 'utf8');
  if (bytes > PROPOSAL_FILE_MAX_BYTES) return { ok: false, reason: `proposal file is ${bytes} bytes; the limit is ${PROPOSAL_FILE_MAX_BYTES}` };
  return { ok: true, value: parsed.data };
}
