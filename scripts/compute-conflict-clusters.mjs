#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pre-compute semantic clusters for conflict files.
 *
 * Reads all conflict JSON files, computes embeddings + agglomerative clustering
 * in Python (scikit-learn), labels clusters via Gemini, and writes
 * _conflict-clusters.json to the data directory.
 *
 * Usage:
 *   node scripts/compute-conflict-clusters.mjs
 *   node scripts/compute-conflict-clusters.mjs --max-clusters 12
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.AI_TRIAD_DATA_ROOT || path.resolve(__dirname, '..', '..', 'ai-triad-data');
const CONFLICTS_DIR = path.join(DATA_ROOT, 'conflicts');
const OUTPUT_FILE = path.join(DATA_ROOT, 'conflicts', '_conflict-clusters.json');

// Parse args
const args = process.argv.slice(2);
const maxClustersArg = args.indexOf('--max-clusters');
const MAX_CLUSTERS = maxClustersArg >= 0 ? parseInt(args[maxClustersArg + 1], 10) : 15;

// ── Load conflicts ──────────────────────────────────────────────

function loadConflicts() {
  const conflictsFile = path.join(CONFLICTS_DIR, 'conflicts.json');
  if (!fs.existsSync(conflictsFile)) {
    console.warn(`  conflicts.json not found at ${conflictsFile}`);
    return [];
  }
  try {
    const wrapper = JSON.parse(fs.readFileSync(conflictsFile, 'utf-8'));
    const entries = wrapper.conflicts || [];
    return entries.map(c => ({
      claim_id: c.claim_id,
      claim_label: c.claim_label || '',
      description: c.description || '',
      status: c.status || 'open',
    })).sort((a, b) => a.claim_label.localeCompare(b.claim_label));
  } catch (err) {
    console.error(`  Error reading ${conflictsFile}: ${err.message}`);
    return [];
  }
}

// ── Compute embeddings + clustering in Python ───────────────────

function embedAndCluster(texts, ids, maxClusters) {
  // Create a private, randomly-named temp dir (0700) rather than writing
  // predictable filenames into the shared os.tmpdir() — the latter lets another
  // local user pre-create/symlink these paths and hijack what Python executes
  // (CodeQL js/insecure-temporary-file). mkdtempSync gives an unguessable dir.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-cluster-'));
  const inputFile = path.join(tmpDir, 'input.json');
  const outputFile = path.join(tmpDir, 'output.json');
  const scriptFile = path.join(tmpDir, 'cluster.py');

  fs.writeFileSync(inputFile, JSON.stringify({ texts, ids, max_clusters: maxClusters }));
  fs.writeFileSync(scriptFile, `
import json
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.cluster import AgglomerativeClustering

with open(${JSON.stringify(inputFile.replace(/\\/g, '/'))}) as f:
    data = json.load(f)

texts = data['texts']
ids = data['ids']
max_clusters = data['max_clusters']

print(f"Encoding {len(texts)} texts...")
model = SentenceTransformer('all-MiniLM-L6-v2', trust_remote_code=False)
embeddings = model.encode(texts, show_progress_bar=True)

print(f"Clustering into max {max_clusters} clusters...")
from sklearn.preprocessing import normalize
from sklearn.metrics.pairwise import cosine_distances
embeddings_norm = normalize(embeddings)

# Average-linkage cosine — matches Get-EmbeddingClusters.ps1 reference impl
# Use distance_threshold = 1 - min_similarity (0.55) for natural clustering,
# then cap at max_clusters by iterative merging if needed
min_similarity = 0.55
dist_matrix = cosine_distances(embeddings_norm)

clustering = AgglomerativeClustering(
    n_clusters=None,
    distance_threshold=1 - min_similarity,
    metric='precomputed',
    linkage='average',
)
labels = clustering.fit_predict(dist_matrix)

# Cap at max_clusters: if too many, fall back to fixed n_clusters
if len(set(labels)) > max_clusters:
    clustering = AgglomerativeClustering(
        n_clusters=max_clusters,
        metric='precomputed',
        linkage='average',
    )
    labels = clustering.fit_predict(dist_matrix)

# Group IDs by cluster label
clusters = {}
for idx, label in enumerate(labels):
    label = int(label)
    if label not in clusters:
        clusters[label] = []
    clusters[label].append(ids[idx])

result = list(clusters.values())
print(f"Formed {len(result)} clusters")

with open(${JSON.stringify(outputFile.replace(/\\/g, '/'))}, 'w') as f:
    json.dump(result, f)
print("Done.")
`);

  console.log(`  Computing embeddings + clustering for ${texts.length} texts...`);
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  execSync(`${pythonCmd} "${scriptFile}"`, {
    maxBuffer: 1024 * 1024 * 200,
    encoding: 'utf-8',
    stdio: 'inherit',
  });

  const result = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));

  // Cleanup — remove the private temp dir and everything in it.
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return result;
}

// ── Label clusters via Gemini ───────────────────────────────────

async function labelClusters(clusters, labelMap) {
  const multiClusters = clusters.filter(c => c.length > 1);
  if (multiClusters.length === 0) return clusters.map(() => 'Other');

  const prompt = `You are labeling groups of conflicting claims about AI policy.
For each numbered group below, provide a short (2-5 word) topical label.
Return a JSON array of strings, one label per group. No markdown fences.

${multiClusters.map((c, i) => {
    const labels = c.slice(0, 8).map(id => labelMap.get(id) || id);
    return `Group ${i + 1} (${c.length} items): ${labels.join('; ')}`;
  }).join('\n')}`;

  // Try Gemini API
  const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
  if (!apiKey) {
    console.warn('  No GEMINI_API_KEY — using generic labels');
    return clusters.map((c, i) => c.length > 1 ? `Cluster ${i + 1}` : 'Other');
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
      }),
    });
    const rawText = await resp.text();
    let data;
    try { data = JSON.parse(rawText); } catch {
      console.warn('  Gemini response not valid JSON, raw:', rawText.slice(0, 200));
      throw new Error('Invalid JSON response');
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) {
      console.warn('  Gemini returned empty text. Full response:', JSON.stringify(data).slice(0, 500));
      throw new Error('Empty Gemini response');
    }
    console.log('  Gemini raw labels:', text.slice(0, 200));
    const cleaned = text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    const labels = JSON.parse(cleaned);

    // Map back to all clusters
    const result = [];
    let multiIdx = 0;
    for (const c of clusters) {
      if (c.length > 1) {
        result.push(labels[multiIdx] || `Cluster ${multiIdx + 1}`);
        multiIdx++;
      } else {
        result.push('');
      }
    }
    return result;
  } catch (err) {
    console.warn(`  Gemini labeling failed: ${err.message}`);
    return clusters.map((c, i) => c.length > 1 ? `Cluster ${i + 1}` : 'Other');
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('Loading conflicts...');
  const conflicts = loadConflicts();
  console.log(`  ${conflicts.length} conflicts loaded`);

  if (conflicts.length === 0) {
    console.log('No conflicts found.');
    return;
  }

  // Build embedding texts
  const texts = conflicts.map(c =>
    `[conflict] ${c.claim_label}\n${c.description}`.slice(0, 512)
  );
  const ids = conflicts.map(c => c.claim_id);
  const labelMap = new Map(conflicts.map(c => [c.claim_id, c.claim_label]));

  // Compute embeddings + cluster in Python (fast with sklearn)
  const dynamicMax = Math.max(8, Math.min(MAX_CLUSTERS, Math.ceil(conflicts.length / 50)));
  const rawClusters = embedAndCluster(texts, ids, dynamicMax);
  console.log(`  ${rawClusters.length} clusters formed`);

  // Label
  console.log('Labeling clusters...');
  const labels = await labelClusters(rawClusters, labelMap);

  // Build output
  const multiClusters = [];
  const singletonIds = [];

  for (let i = 0; i < rawClusters.length; i++) {
    if (rawClusters[i].length > 1) {
      const nodeIds = rawClusters[i].sort((a, b) =>
        (labelMap.get(a) || '').localeCompare(labelMap.get(b) || '')
      );
      multiClusters.push({ label: labels[i] || `Cluster ${i + 1}`, nodeIds });
    } else {
      singletonIds.push(...rawClusters[i]);
    }
  }

  // Sort clusters alphabetically
  multiClusters.sort((a, b) => a.label.localeCompare(b.label));

  // Append Other bucket
  if (singletonIds.length > 0) {
    singletonIds.sort((a, b) =>
      (labelMap.get(a) || '').localeCompare(labelMap.get(b) || '')
    );
    multiClusters.push({ label: 'Other', nodeIds: singletonIds });
  }

  const output = {
    generated_at: new Date().toISOString(),
    conflict_count: conflicts.length,
    cluster_count: multiClusters.length,
    clusters: multiClusters,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${OUTPUT_FILE}`);
  console.log(`  ${multiClusters.length} clusters, ${conflicts.length} total conflicts`);
  for (const c of multiClusters) {
    console.log(`  ${c.label}: ${c.nodeIds.length} items`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
