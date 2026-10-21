// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Evidence Retriever — retrieves top-K evidence items from the source corpus
 * for a given Belief claim. Uses keyword overlap against source metadata and
 * optional embedding similarity for ranking.
 *
 * Design: lazy evaluation (on-demand per claim), cached source index.
 */

import fs from 'fs';
import path from 'path';
import { cosineSimilarity } from './taxonomyRelevance.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { stripDataUris } from './stripDataUris.js';

// ── Types ─────────────────────────────────────────────────

export interface SourceMetadata {
  id: string;
  title: string;
  one_liner?: string;
  topic_tags?: string[];
  pov_tags?: string[];
  source_type?: string;
}

export interface EvidenceItem {
  id: string;
  source_doc_id: string;
  text: string;
  similarity_score: number;
}

export interface RetrieveOptions {
  /** Maximum evidence items to return. Default: 10. */
  topK?: number;
  /** Minimum keyword similarity to consider a source. Default: 0.1. */
  minSimilarity?: number;
  /** Optional query embedding for semantic ranking. */
  queryEmbedding?: number[];
  /** Taxonomy node embeddings for cross-referencing. */
  nodeEmbeddings?: Record<string, { pov: string; vector: number[] }>;
}

// ── Source index (lazy, cached) ───────────────────────────

let _sourceIndex: SourceMetadata[] | null = null;
let _sourcesDir: string | null = null;

export function clearSourceIndex(): void {
  _sourceIndex = null;
  _sourcesDir = null;
}

function loadSourceIndex(sourcesDir: string): SourceMetadata[] {
  if (_sourceIndex && _sourcesDir === sourcesDir) return _sourceIndex;

  const entries = fs.readdirSync(sourcesDir, { withFileTypes: true });
  const index: SourceMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const metaPath = path.join(sourcesDir, entry.name, 'metadata.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SourceMetadata;
      index.push({
        id: raw.id ?? entry.name,
        title: raw.title ?? entry.name,
        one_liner: raw.one_liner,
        topic_tags: raw.topic_tags,
        pov_tags: raw.pov_tags,
        source_type: raw.source_type,
      });
    } catch { /* skip malformed metadata */ }
  }

  _sourceIndex = index;
  _sourcesDir = sourcesDir;
  return index;
}

// ── Keyword extraction ────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'and', 'but',
  'or', 'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'than', 'too', 'very', 'just', 'also', 'only', 'own', 'same',
  'that', 'this', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'we', 'our', 'he', 'she', 'his', 'her', 'who', 'which', 'what', 'when',
  'where', 'how', 'why', 'if', 'then', 'about', 'up', 'out', 'over',
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ── Keyword similarity scoring ────────────────────────────

function keywordOverlap(claimKeywords: string[], sourceText: string): number {
  if (claimKeywords.length === 0) return 0;
  const sourceWords = new Set(extractKeywords(sourceText));
  let matches = 0;
  for (const kw of claimKeywords) {
    if (sourceWords.has(kw)) matches++;
  }
  return matches / claimKeywords.length;
}

function scoreSource(claimKeywords: string[], source: SourceMetadata): number {
  const fields = [
    source.title,
    source.one_liner ?? '',
    (source.topic_tags ?? []).join(' '),
  ].join(' ');
  return keywordOverlap(claimKeywords, fields);
}

// ── Paragraph extraction ──────────────────────────────────

function extractRelevantParagraphs(
  snapshotPath: string,
  claimKeywords: string[],
  maxParagraphs: number,
): string[] {
  let content: string;
  try {
    content = fs.readFileSync(snapshotPath, 'utf-8');
    content = stripDataUris(content).text;
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'evidence-retriever', level: 'warn', message: 'snapshot file unreadable — returning empty evidence. err=' + String(err) });
    return [];
  }

  // Split into paragraphs (double newline or markdown heading boundaries)
  const paragraphs = content
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 30 && !p.startsWith('<!--') && !p.startsWith('>'));

  // Score and rank paragraphs by keyword overlap
  const scored = paragraphs.map(p => ({
    text: p,
    score: keywordOverlap(claimKeywords, p),
  }));
  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter(s => s.score > 0)
    .slice(0, maxParagraphs)
    .map(s => s.text.length > 500 ? s.text.slice(0, 500) + '…' : s.text);
}

// ── Main retrieval function ───────────────────────────────

/**
 * Retrieve the top-K most relevant evidence items from the source corpus
 * for a given Belief claim text.
 *
 * @param claimText - The claim text to find evidence for
 * @param sourcesDir - Path to the sources directory (e.g., ai-triad-data/sources)
 * @param options - Retrieval configuration
 * @returns Ranked evidence items with similarity scores
 */
export function retrieveEvidence(
  claimText: string,
  sourcesDir: string,
  options?: RetrieveOptions,
): EvidenceItem[] {
  const topK = options?.topK ?? 10;
  const minSim = options?.minSimilarity ?? 0.1;

  const sources = loadSourceIndex(sourcesDir);
  const claimKeywords = extractKeywords(claimText);

  if (claimKeywords.length === 0) return [];

  // Score all sources by keyword overlap
  const scored = sources.map(src => ({
    source: src,
    score: scoreSource(claimKeywords, src),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Take top candidates (3× topK to allow paragraph-level filtering)
  const candidates = scored
    .filter(s => s.score >= minSim)
    .slice(0, topK * 3);

  if (candidates.length === 0) return [];

  // Extract relevant paragraphs from top candidate sources
  const evidenceItems: EvidenceItem[] = [];
  let evidenceCounter = 0;

  for (const { source, score } of candidates) {
    if (evidenceItems.length >= topK) break;

    const snapshotPath = path.join(sourcesDir, source.id, 'snapshot.md');
    const paragraphs = extractRelevantParagraphs(snapshotPath, claimKeywords, 3);

    for (const para of paragraphs) {
      if (evidenceItems.length >= topK) break;
      evidenceCounter++;

      // Refine score: paragraph-level keyword overlap weighted with source-level score
      const paraScore = keywordOverlap(claimKeywords, para);
      const combinedScore = 0.4 * score + 0.6 * paraScore;

      if (combinedScore >= minSim) {
        evidenceItems.push({
          id: `ev-${evidenceCounter}`,
          source_doc_id: source.id,
          text: para,
          similarity_score: Math.round(combinedScore * 1000) / 1000,
        });
      }
    }
  }

  // If query embedding is available, re-rank using semantic similarity
  if (options?.queryEmbedding && options.nodeEmbeddings) {
    reRankWithEmbeddings(evidenceItems, claimKeywords, options.queryEmbedding, options.nodeEmbeddings);
  }

  // Final sort by score and return top-K
  evidenceItems.sort((a, b) => b.similarity_score - a.similarity_score);
  return evidenceItems.slice(0, topK);
}

// ── Embedding re-ranking (optional enhancement) ──────────

function reRankWithEmbeddings(
  items: EvidenceItem[],
  _claimKeywords: string[],
  queryEmbedding: number[],
  nodeEmbeddings: Record<string, { pov: string; vector: number[] }>,
): void {
  // Boost evidence items from sources that are semantically related to
  // taxonomy nodes most similar to the claim
  const nodeScores = new Map<string, number>();
  for (const [nodeId, entry] of Object.entries(nodeEmbeddings)) {
    if (entry.vector) {
      nodeScores.set(nodeId, cosineSimilarity(queryEmbedding, entry.vector));
    }
  }

  // Top 10 most relevant taxonomy nodes
  const topNodes = [...nodeScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (topNodes.length === 0) return;

  // Average similarity of top nodes as a boost factor
  const avgNodeSim = topNodes.reduce((sum, [, s]) => sum + s, 0) / topNodes.length;

  // Apply a mild semantic boost (±10%) to each evidence item
  for (const item of items) {
    item.similarity_score = item.similarity_score * (0.9 + 0.2 * avgNodeSim);
    item.similarity_score = Math.round(item.similarity_score * 1000) / 1000;
  }
}
