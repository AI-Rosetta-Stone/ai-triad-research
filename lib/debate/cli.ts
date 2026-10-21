#!/usr/bin/env npx tsx
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * CLI entry point for the headless debate runner.
 * Reads config from --config <path>, runs a full debate, writes output files.
 * Prints result JSON to stdout for PowerShell cmdlet consumption.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCLIAdapter } from './aiAdapter.js';
import { resolveRepoRoot, resolveDataRoot, loadTaxonomy, loadSourceContent, fetchUrlContent, loadConflicts, loadVocabulary } from './taxonomyLoader.js';
import { DebateEngine } from './debateEngine.js';
import type { DebateConfig } from './debateEngine.js';
import { runHeadlessDebate } from './headlessRunner.js';
import type { DebateSourceType, SpeakerId, DebateAudience } from './types.js';
import { POVER_INFO, DEBATE_AUDIENCES, POV_KEYS } from './types.js';
import { formatSituationDebateContext } from './prompts.js';
import { FlightRecorder, getGlobalRecorder, setGlobalRecorder, RECORDER_CAPACITY_DEFAULT } from '../flight-recorder/index.js';
import { generateSlug, formatDebateMarkdown, buildDiagnosticsOutput, buildHarvestOutput } from './formatters.js';
import { ActionableError } from './errors.js';
import { runExploreFirstPipeline } from './explorationPreset.js';
import { resolvePoverInfo } from './soulDocLoader.js';
import { validateSeatTagsConfig, loadSoulOverrides, buildSoulOverrideResolver, validateNoSeatConflict, type CLISeatTags, type CLISoulOverrides } from './cli.helpers.js';
import { safeSerialize, atomicWriteSync, sweepOrphanedTempFiles } from './persistence.js';
import { recordLockHolder } from './lockHolder.js';
import { computeQualityScore } from './qualityScore.js';

// ── CLI Config schema ────────────────────────────────────

interface CLIConfig {
  topic?: string;
  name?: string;
  docPath?: string;
  url?: string;
  situationId?: string;
  activePovers?: string[];
  model?: string;
  evaluatorModel?: string;
  rounds?: number;
  responseLength?: string;
  protocolId?: string;
  enableClarification?: boolean;
  enableProbing?: boolean;
  probingInterval?: number;
  outputDir?: string;
  outputFormat?: string;
  slug?: string;
  apiKey?: string;
  temperature?: number;
  audience?: string;
  moderatorMode?: 'standard' | 'talmudic' | 'socratic';
  talmudicReferences?: {
    enabled: boolean;
    corpusPath: string;
    maxCandidates?: number;
    maxReferencesPerRound?: number;
    minScore?: number;
  };
  useAdaptiveStaging?: boolean;
  pacing?: 'tight' | 'moderate' | 'thorough';
  maxTotalRounds?: number;
  allowEarlyTermination?: boolean;
  phaseBoundsOverride?: { maxConfrontationRounds?: number; maxArgumentationRounds?: number; maxConcludingRounds?: number };
  throttleMs?: number;
  perturbation?: {
    inject_at_turn: number;
    prompt: string;
    measure_recovery_window?: number;
  };
  salienceBeacon?: boolean;
  stageModels?: { brief?: string; plan?: string; draft?: string; cite?: string; evaluator?: string; scope?: string; summary?: string; moderator?: string; crux?: string };
  /** @deprecated Use stageModels instead. */
  utilityModels?: { summary?: string; scope?: string; moderator?: string; crux?: string };
  exploreFirst?: boolean;
  exploreModel?: string;
  excludeGreatestHits?: boolean;
  breadthAwareSituationSelection?: boolean;
  /** Moderator voices each camp's story before the openings (h3 experiment). */
  narrativeVoicing?: boolean;
  /**
   * Per-seat POV-tag assignment for the tag pilot (t/3963).
   * Keys are speaker ids (accelerationist / safetyist / skeptic).
   * Each entry is validated against the POV-tag registry at load time.
   * Wired to engineConfig.seat_tags.
   */
  seatTags?: CLISeatTags;
  /**
   * Per-seat soul document overrides (t/4305).
   * Values are file paths (repo-relative or absolute) to JSON soul files.
   * Each file is read, validated against SoulDocumentSchema, and loaded at startup.
   * When present, the CLI wraps the default soulResolver so overridden seats return the
   * pre-loaded soul; non-overridden seats call through to resolvePoverInfo.
   */
  soulOverrides?: CLISoulOverrides;
}

interface GoldenFixtureConfig extends CLIConfig {
  quality_floor: number;
}

// ── Main ─────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[debate-cli] ${msg}\n`);
}

interface ParsedArgs {
  configPath: string;
  disableTurnValidation: boolean;
  maxTurnRetries?: 0 | 1 | 2;
  perturbationPrompt?: string;
  perturbationTurn?: number;
  exploreFirst: boolean;
  exploreModel?: string;
  resumePath?: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);

  let configPath: string | undefined;
  const cfgIdx = args.indexOf('--config');
  if (cfgIdx >= 0 && args[cfgIdx + 1]) configPath = args[cfgIdx + 1];
  else if (args.includes('--stdin')) configPath = '-';

  let resumePath: string | undefined;
  const resumeIdx = args.indexOf('--resume');
  if (resumeIdx >= 0 && args[resumeIdx + 1]) resumePath = args[resumeIdx + 1];

  if (!configPath) {
    console.error('Usage: npx tsx lib/debate/cli.ts --config <path.json> [--no-turn-validation] [--max-turn-retries 0|1|2] [--perturbation <prompt> --perturbation-turn <N>] [--explore-first [--explore-model <model>]] [--resume <partial-path>]');
    process.exit(1);
  }

  const disableTurnValidation = args.includes('--no-turn-validation');
  const exploreFirst = args.includes('--explore-first');

  let maxTurnRetries: 0 | 1 | 2 | undefined;
  const retryIdx = args.indexOf('--max-turn-retries');
  if (retryIdx >= 0 && args[retryIdx + 1]) {
    const raw = args[retryIdx + 1];
    const n = Number(raw);
    if (n !== 0 && n !== 1 && n !== 2) {
      console.error(`--max-turn-retries must be 0, 1, or 2 (got '${raw}').`);
      process.exit(1);
    }
    maxTurnRetries = n as 0 | 1 | 2;
  }

  let perturbationPrompt: string | undefined;
  const pertIdx = args.indexOf('--perturbation');
  if (pertIdx >= 0 && args[pertIdx + 1]) perturbationPrompt = args[pertIdx + 1];

  let perturbationTurn: number | undefined;
  const pertTurnIdx = args.indexOf('--perturbation-turn');
  if (pertTurnIdx >= 0 && args[pertTurnIdx + 1]) perturbationTurn = parseInt(args[pertTurnIdx + 1], 10);

  let exploreModel: string | undefined;
  const emIdx = args.indexOf('--explore-model');
  if (emIdx >= 0 && args[emIdx + 1]) exploreModel = args[emIdx + 1];

  return { configPath, disableTurnValidation, maxTurnRetries, perturbationPrompt, perturbationTurn, exploreFirst, exploreModel, resumePath };
}

function resolvePerturbationConfig(
  config: CLIConfig,
  cliPrompt?: string,
  cliTurn?: number,
): import('./types.js').PerturbationConfig | undefined {
  // CLI flags override config file
  if (cliPrompt) {
    return {
      inject_at_turn: cliTurn ?? 2,
      prompt: cliPrompt,
      measure_recovery_window: 3,
    };
  }
  return config.perturbation
    ? {
      inject_at_turn: config.perturbation.inject_at_turn,
      prompt: config.perturbation.prompt,
      measure_recovery_window: config.perturbation.measure_recovery_window ?? 3,
    }
    : undefined;
}

// Extracted from `main` to keep `main` within the complexity baseline (t/4305).
function resolveSessionSouls(config: CLIConfig, repoRoot: string) {
  const resolvedSeatTags = config.seatTags
    ? validateSeatTagsConfig(config.seatTags)
    : undefined;

  if (config.seatTags && config.soulOverrides) {
    validateNoSeatConflict(config.seatTags, config.soulOverrides);
  }

  const soulOverrideMap = config.soulOverrides
    ? loadSoulOverrides(config.soulOverrides, repoRoot)
    : undefined;
  const effectiveSoulResolver = soulOverrideMap && Object.keys(soulOverrideMap).length > 0
    ? buildSoulOverrideResolver(soulOverrideMap, resolvePoverInfo)
    : resolvePoverInfo;

  if (soulOverrideMap) {
    log(`Soul overrides loaded for seats: ${Object.keys(soulOverrideMap).join(', ')}`);
  }

  return { resolvedSeatTags, effectiveSoulResolver };
}

async function main(): Promise<void> {
  const { configPath, disableTurnValidation, maxTurnRetries, perturbationPrompt, perturbationTurn, exploreFirst: cliExploreFirst, exploreModel: cliExploreModel, resumePath } = parseArgs();
  let configText: string;

  if (configPath === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    configText = Buffer.concat(chunks).toString('utf-8');
  } else {
    const resolvedConfig = path.resolve(configPath);
    if (!fs.existsSync(resolvedConfig)) {
      throw new ActionableError({
        goal: 'Load debate configuration',
        problem: `Config file not found: ${resolvedConfig}`,
        location: 'cli.main',
        nextSteps: [
          'Provide a valid JSON config file path via --config <path>',
          `Verify the file exists at: ${resolvedConfig}`,
          'Check for typos in the file path',
        ],
      });
    }
    try {
      configText = fs.readFileSync(resolvedConfig, 'utf-8');
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'state.error', component: 'cli', level: 'error', message: `Failed to read config file ${resolvedConfig}`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new ActionableError({
        goal: 'Load debate configuration',
        problem: `Failed to read config file ${resolvedConfig}: ${errMsg}`,
        location: 'cli.main',
        nextSteps: [
          'Check that you have read permissions on the file',
          `Verify the file is not locked by another process`,
        ],
        innerError: err,
      });
    }
  }

  let config: CLIConfig;
  try {
    config = JSON.parse(configText);
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'state.error', component: 'cli', level: 'error', message: 'Config file contains invalid JSON', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new ActionableError({
      goal: 'Parse debate configuration',
      problem: `Config file contains invalid JSON: ${errMsg}`,
      location: 'cli.main',
      nextSteps: [
        'Validate the config file with a JSON linter (e.g. jsonlint or VS Code)',
        `Check the first 200 chars for syntax errors: ${configText.slice(0, 200)}`,
        'Ensure no trailing commas, unquoted keys, or missing brackets',
      ],
      innerError: err,
    });
  }
  if (config.pacing != null && !config.useAdaptiveStaging) {
    throw new ActionableError({
      goal: 'Run headless debate',
      problem: `'pacing' is set to '${config.pacing}' but 'useAdaptiveStaging' is not enabled — pacing has no effect in fixed-round mode`,
      location: 'cli.main',
      nextSteps: [
        "Set 'useAdaptiveStaging: true' to enable adaptive staging with the specified pacing.",
        "Or remove 'pacing' from the config to run fixed rounds (use 'rounds' to control the count).",
      ],
    });
  }
  const startTime = Date.now();

  // Resolve repo root
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveRepoRoot(__dirname);
  log(`Repo root: ${repoRoot}`);

  // Load taxonomy
  log('Loading taxonomy...');
  const taxonomy = loadTaxonomy(repoRoot);
  log(`Loaded: ${taxonomy.accelerationist.nodes.length} acc, ${taxonomy.safetyist.nodes.length} saf, ${taxonomy.skeptic.nodes.length} skp, ${taxonomy.situations.nodes.length} sit nodes`);

  // Load vocabulary for standardized term enforcement
  const vocab = loadVocabulary(repoRoot);
  log(`Vocabulary: ${vocab.standardized.length} standardized, ${vocab.colloquial.length} colloquial terms`);

  // Resolve topic source
  let topic = config.topic ?? '';
  let sourceType: DebateSourceType = 'topic';
  let sourceRef = '';
  let sourceContent = '';

  if (config.docPath) {
    sourceType = 'document';
    sourceRef = config.docPath;
    sourceContent = await loadSourceContent(config.docPath);
    if (!topic) topic = `Debate grounded in: ${path.basename(config.docPath)}`;
    log(`Loaded document: ${config.docPath} (${sourceContent.length} chars)`);
  } else if (config.url) {
    sourceType = 'url';
    sourceRef = config.url;
    sourceContent = await fetchUrlContent(config.url);
    if (!topic) topic = `Debate grounded in: ${config.url}`;
    log(`Fetched URL: ${config.url} (${sourceContent.length} chars)`);
  } else if (config.situationId) {
    sourceType = 'situations';
    sourceRef = config.situationId;
    const sitNode = taxonomy.situations.nodes.find(n => n.id === config.situationId);
    if (!sitNode) throw new ActionableError({
      goal: 'Load situation node for debate',
      problem: `Situation node not found: ${config.situationId}`,
      location: 'cli.main',
      nextSteps: [
        `Verify the situationId '${config.situationId}' exists in the taxonomy situations data`,
        'List available situation IDs with: jq ".[].id" <data-root>/taxonomy/situations.json',
        'Check for typos in the situationId field of your config',
      ],
    });

    // Build situation context
    const conflicts = loadConflicts(repoRoot);
    const conflictSummaries = conflicts
      .filter(c => c.linked_taxonomy_nodes?.includes(config.situationId!))
      .map(c => `${c.claim_label}: ${c.description}`)
      .slice(0, 5);

    const linkedNodeDescriptions: string[] = [];
    for (const linkedId of (sitNode.linked_nodes ?? []).slice(0, 10)) {
      for (const pov of POV_KEYS) {
        const node = taxonomy[pov].nodes.find(n => n.id === linkedId);
        if (node) linkedNodeDescriptions.push(`[${node.id}] ${node.label}: ${node.description.slice(0, 150)}`);
      }
    }

    sourceContent = formatSituationDebateContext({
      id: sitNode.id,
      label: sitNode.label,
      description: sitNode.description,
      interpretations: sitNode.interpretations,
      assumes: sitNode.graph_attributes?.assumes,
      steelmanVulnerability: typeof sitNode.graph_attributes?.steelman_vulnerability === 'string'
        ? sitNode.graph_attributes.steelman_vulnerability : undefined,
      linkedNodeDescriptions,
      conflictSummaries,
    });

    if (!topic) topic = `Situation: ${sitNode.label}`;
    log(`Loaded situation node: ${sitNode.id} — ${sitNode.label}`);
  }

  if (!topic) throw new ActionableError({
    goal: 'Determine debate topic',
    problem: 'No topic specified',
    location: 'cli.main',
    nextSteps: [
      'Add a "topic" field to your config JSON with the debate question or thesis',
      'Alternatively, provide "docPath", "url", or "situationId" to derive the topic from a source',
    ],
  });

  // Validate debaters
  const activePovers = (config.activePovers ?? ['accelerationist', 'safetyist', 'skeptic']) as Exclude<SpeakerId, 'user'>[];
  if (activePovers.length < 1) throw new ActionableError({
    goal: 'Validate debate configuration',
    problem: `At least 1 debater required, but none specified`,
    location: 'cli.main',
    nextSteps: [
      'Add at least 1 entry to the "activePovers" array in your config',
      'Valid debaters: accelerationist, safetyist, skeptic',
    ],
  });
  for (const p of activePovers) {
    if (!POVER_INFO[p]) throw new ActionableError({
      goal: 'Validate debate configuration',
      problem: `Unknown debater: ${p}`,
      location: 'cli.main',
      nextSteps: [
        `Replace '${p}' with one of: accelerationist, safetyist, skeptic`,
        'Check the "activePovers" array in your config for typos',
      ],
    });
  }

  // Initialize flight recorder + named pipe listener
  if (!getGlobalRecorder()) {
    const recorder = new FlightRecorder({ capacity: RECORDER_CAPACITY_DEFAULT, dumpOnError: true });
    recorder.intern('component', 'cli');
    recorder.intern('component', 'ai-adapter');
    recorder.intern('component', 'debate-engine');
    setGlobalRecorder(recorder);
  }
  const recorder = getGlobalRecorder()!;
  recorder.startPipeListener(process.pid);
  process.on('SIGINT', () => { recorder.stopPipeListener(); process.exit(130); });
  recorder.record({ type: 'state.init', component: 'cli', level: 'info', message: `CLI debate starting: PID ${process.pid}` });

  // Create adapter
  // Validate audience
  const validAudienceIds = DEBATE_AUDIENCES.map(a => a.id);
  const audience = config.audience
    ? (validAudienceIds.includes(config.audience as DebateAudience) ? config.audience as DebateAudience : (() => {
      throw new ActionableError({
        goal: 'Validate debate configuration',
        problem: `Unknown audience: ${config.audience}`,
        location: 'cli.main',
        nextSteps: [
          `Replace '${config.audience}' with one of: ${validAudienceIds.join(', ')}`,
          'Check the "audience" field in your config for typos',
        ],
      });
    })())
    : undefined;

  const adapter = createCLIAdapter(repoRoot, config.apiKey);
  const model = config.model ?? process.env.AI_MODEL ?? 'gemini-2.5-flash';
  log(`Model: ${model}`);

  const moderatorMode = config.moderatorMode ?? 'standard';
  if (moderatorMode !== 'standard' && moderatorMode !== 'talmudic' && moderatorMode !== 'socratic') {
    throw new ActionableError({
      goal: 'Validate debate configuration',
      problem: `Unknown moderator mode: ${moderatorMode}`,
      location: 'cli.main',
      nextSteps: [
        'Set "moderatorMode" to "standard", "talmudic", or "socratic"',
        'Remove the field to use standard moderation',
      ],
    });
  }
  const talmudicReferences = config.talmudicReferences
    ? {
      ...config.talmudicReferences,
      corpusPath: path.resolve(repoRoot, config.talmudicReferences.corpusPath),
    }
    : undefined;
  if (talmudicReferences?.enabled && moderatorMode !== 'talmudic') {
    throw new ActionableError({
      goal: 'Validate source-grounded moderation configuration',
      problem: 'talmudicReferences.enabled requires moderatorMode to be "talmudic"',
      location: 'cli.main',
      nextSteps: [
        'Set "moderatorMode": "talmudic"',
        'Or set "talmudicReferences.enabled": false',
      ],
    });
  }
  if (talmudicReferences?.enabled) {
    log(`Talmudic references: source-grounded (${talmudicReferences.corpusPath})`);
  } else if (moderatorMode === 'talmudic') {
    log('Talmudic references: method-only');
  }

  // Validate seatTags and load soul overrides (extracted to resolveSessionSouls for complexity budget).
  const { resolvedSeatTags, effectiveSoulResolver } = resolveSessionSouls(config, repoRoot);

  // Build engine config
  const engineConfig: DebateConfig = {
    soulResolver: effectiveSoulResolver,
    topic,
    name: config.name,
    sourceType,
    sourceRef,
    sourceContent,
    activePovers,
    protocolId: config.protocolId ?? 'structured',
    model,
    evaluatorModel: config.evaluatorModel, // deprecated — constructor migrates to stageModels.evaluator
    rounds: config.rounds ?? 3,
    responseLength: (config.responseLength ?? 'medium') as 'brief' | 'medium' | 'detailed',
    enableClarification: config.enableClarification,
    enableProbing: config.enableProbing,
    probingInterval: config.probingInterval ?? 2,
    temperature: config.temperature,
    turnValidation: {
      enabled: !disableTurnValidation,
      ...(maxTurnRetries !== undefined ? { maxRetries: maxTurnRetries } : {}),
    },
    // eslint-disable-next-line local/require-warn-on-degraded-catch-return -- best-effort version read; undefined appVersion is observable in config output
    appVersion: (() => { try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../taxonomy-editor/package.json'), 'utf-8')).version; } catch { return undefined; } })(),
    audience,
    moderatorMode,
    talmudicReferences,
    vocabulary: vocab.standardized.length > 0
      ? { standardizedTerms: vocab.standardized as import('../dictionary/types.js').StandardizedTerm[], colloquialTerms: vocab.colloquial as import('../dictionary/types.js').ColloquialTerm[] }
      : undefined,
    useAdaptiveStaging: config.useAdaptiveStaging,
    pacing: config.pacing,
    maxTotalRounds: config.maxTotalRounds,
    allowEarlyTermination: config.allowEarlyTermination,
    phaseBoundsOverride: config.phaseBoundsOverride,
    throttleMs: config.throttleMs,
    perturbation: resolvePerturbationConfig(config, perturbationPrompt, perturbationTurn),
    salienceBeacon: config.salienceBeacon,
    stageModels: config.stageModels,
    utilityModels: config.utilityModels,
    excludeGreatestHits: config.excludeGreatestHits,
    breadthAwareSituationSelection: config.breadthAwareSituationSelection,
    narrativeVoicing: config.narrativeVoicing,
    seat_tags: resolvedSeatTags,
  };

  // Prepare output paths early so the snapshot callback can write partial files
  const slug = config.slug ?? generateSlug(config.name ?? topic);
  const dataRoot = resolveDataRoot(repoRoot);
  const outputDir = path.resolve(config.outputDir ?? path.join(dataRoot, 'debates'));
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (mkdirErr) {
    getGlobalRecorder()?.record({ type: 'state.error', component: 'cli', level: 'error', message: `Failed to create output directory '${outputDir}'`, error: { name: (mkdirErr as Error).name ?? 'Error', message: String(mkdirErr), stack: (mkdirErr as Error).stack } });
    const errMsg = mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr);
    throw new ActionableError({
      goal: 'Create debate output directory',
      problem: `Failed to create output directory '${outputDir}': ${errMsg}`,
      location: 'cli.main',
      nextSteps: [
        `Check that the parent directory of '${outputDir}' exists`,
        'Verify you have write permissions to the target location',
        'Try specifying a different "outputDir" in your config',
      ],
      innerError: mkdirErr,
    });
  }

  // Mirror the CLI's cal-log isolation into the engine so both write paths use the same root (t/2219).
  // Recover any .tmp/.tmp2 orphans left by a previously interrupted write (t/2555).
  sweepOrphanedTempFiles(outputDir);

  engineConfig.calibrationDataRoot = config.outputDir != null ? outputDir : dataRoot;

  const partialPath = path.join(outputDir, `${slug}-partial.json`);
  engineConfig.onSnapshot = (session, trigger) => {
    fs.writeFileSync(partialPath, JSON.stringify(session, null, 2), 'utf-8');
    log(`[snapshot] Wrote ${trigger} recovery file: ${partialPath}`);
  };

  // Run debate — resume, explore-first, or direct
  const useExploreFirst = cliExploreFirst || config.exploreFirst;
  let session: import('./types.js').DebateSession;
  let explorationSession: import('./types.js').DebateSession | null = null;
  let activeDebateId: string | undefined;
  recorder.setContextProvider(() => ({ active_debate_id: activeDebateId }));

  if (resumePath) {
    const resolvedResume = path.resolve(resumePath);
    if (!fs.existsSync(resolvedResume)) {
      throw new ActionableError({
        goal: 'Resume debate from checkpoint',
        problem: `Checkpoint file not found: ${resolvedResume}`,
        location: 'cli.main',
        nextSteps: [
          `Verify the partial file exists at: ${resolvedResume}`,
          'Look for *-partial.json files in your output directory',
        ],
      });
    }
    log(`Resuming debate from checkpoint: ${resolvedResume}`);
    const checkpoint = JSON.parse(fs.readFileSync(resolvedResume, 'utf-8')) as import('./types.js').DebateSession;
    session = await DebateEngine.resume(checkpoint, engineConfig, adapter, taxonomy, (p) => {
      log(`[resume:${p.phase}] ${p.speaker ? `${p.speaker}: ` : ''}${p.message}`);
    });
    log(`Resume complete: ${session.transcript.length} transcript entries`);
  } else if (useExploreFirst) {
    const resolvedExploreModel = cliExploreModel ?? config.exploreModel ?? 'groq-openai-gpt-oss-120b';
    log(`Explore-first pipeline: "${topic.slice(0, 80)}..." with ${activePovers.join(', ')}`);
    const result = await runExploreFirstPipeline(
      engineConfig, adapter, taxonomy, resolvedExploreModel, log,
      (p) => { log(`[${p.phase}] ${p.speaker ? `${p.speaker}: ` : ''}${p.message}`); },
    );
    explorationSession = result.exploration;
    session = result.production;
  } else {
    log(`Starting debate: "${topic.slice(0, 80)}..." with ${activePovers.join(', ')}, ${engineConfig.useAdaptiveStaging ? `adaptive (${config.pacing ?? 'moderate'})` : `${engineConfig.rounds} rounds`}`);
    ({ session } = await runHeadlessDebate(engineConfig, adapter, taxonomy, (p) => {
      log(`[${p.phase}] ${p.speaker ? `${p.speaker}: ` : ''}${p.message}`);
    }));
  }
  activeDebateId = session.id;

  // Stamp origin metadata
  session.origin = {
    mode: 'cli',
    command: `npx tsx lib/debate/cli.ts --config ${configPath}${disableTurnValidation ? ' --no-turn-validation' : ''}${maxTurnRetries !== undefined ? ` --max-turn-retries ${maxTurnRetries}` : ''}${useExploreFirst ? ' --explore-first' : ''}${cliExploreModel ? ` --explore-model ${cliExploreModel}` : ''}`,
    config_summary: {
      ...(config.topic ? { topic: config.topic } : {}),
      ...(config.docPath ? { docPath: config.docPath } : {}),
      ...(config.url ? { url: config.url } : {}),
      ...(config.name ? { name: config.name } : {}),
      model: config.model ?? model,
      protocol: config.protocolId ?? 'structured',
      audience: config.audience,
      activePovers: config.activePovers,
      responseLength: config.responseLength ?? 'medium',
      ...(config.temperature != null ? { temperature: config.temperature } : {}),
      ...(config.useAdaptiveStaging ? { adaptiveStaging: true, pacing: config.pacing ?? 'moderate' } : { adaptiveStaging: false, rounds: config.rounds ?? 3 }),
    },
  };

  // Generate outputs — slug/outputDir already computed above for snapshot callback
  const outputFormat = config.outputFormat ?? 'json';

  function writeOutput(filePath: string, content: string, description: string): void {
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      log(`Wrote ${description}: ${filePath}`);
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'state.error', component: 'cli', level: 'error', message: `Failed to write ${description} to '${filePath}'`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new ActionableError({
        goal: 'Write debate output file',
        problem: `Failed to write ${description} to '${filePath}': ${errMsg}`,
        location: 'cli.writeOutput',
        nextSteps: [
          'Check available disk space',
          `Verify write permissions on '${outputDir}'`,
          `The debate completed successfully (ID: ${session.id}, ${session.transcript.length} entries) — re-run to regenerate output`,
        ],
        innerError: err,
      });
    }
  }

  // Write structured session JSON FIRST via safe-serialize + atomic write —
  // this is the durable anchor for both formats. Partial stays on disk until
  // this write succeeds, so a crash before here is always recoverable.
  const { json: sessionJson, hadError, errorMessage } = safeSerialize(session);
  if (hadError) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'cli', level: 'error',
      message: `Session serialization required fallback: ${errorMessage}`,
    });
    log(`[WARNING] Session serialization used fallback replacer: ${errorMessage}`);
  }

  const jsonPath = path.join(outputDir, `${slug}-debate.json`);
  try {
    atomicWriteSync(jsonPath, sessionJson, recordLockHolder);
    log(`Wrote debate JSON (atomic): ${jsonPath}`);
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'state.error', component: 'cli', level: 'error', message: `Failed to write debate JSON to '${jsonPath}'`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new ActionableError({
      goal: 'Write debate output file',
      problem: `Failed to write debate JSON to '${jsonPath}': ${errMsg}`,
      location: 'cli.writeOutput',
      nextSteps: [
        'Check available disk space',
        `Verify write permissions on '${outputDir}'`,
        `The debate completed successfully (ID: ${session.id}, ${session.transcript.length} entries) — re-run to regenerate output`,
      ],
      innerError: err,
    });
  }

  // Structured session JSON is now durable — safe to delete the partial checkpoint
  try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch { /* best-effort cleanup */ }

  // Write markdown (always, as a secondary artifact — derivable from session)
  const markdownPath = path.join(outputDir, `${slug}-debate.md`);
  writeOutput(markdownPath, formatDebateMarkdown(session), 'debate markdown');

  // Write diagnostics
  const diagPath = path.join(outputDir, `${slug}-diagnostics.json`);
  writeOutput(diagPath, JSON.stringify(buildDiagnosticsOutput(session), null, 2), 'diagnostics');

  // Write harvest
  const allNodeIds = new Set<string>();
  const nodeLabels = new Map<string, string>();
  for (const pov of POV_KEYS) {
    for (const n of taxonomy[pov].nodes) { allNodeIds.add(n.id); nodeLabels.set(n.id, n.label); }
  }
  for (const n of taxonomy.situations.nodes) { allNodeIds.add(n.id); nodeLabels.set(n.id, n.label); }
  const getNodeLabel = (id: string) => nodeLabels.get(id) ?? null;

  const harvestPath = path.join(outputDir, `${slug}-harvest.json`);
  writeOutput(harvestPath, JSON.stringify(buildHarvestOutput(session, getNodeLabel, allNodeIds), null, 2), 'harvest');

  // Write exploration outputs if explore-first was used
  if (explorationSession) {
    const explorationDebatePath = path.join(outputDir, `${slug}-exploration.json`);
    writeOutput(explorationDebatePath, JSON.stringify(explorationSession, null, 2), 'exploration debate JSON');
    const explorationDiagPath = path.join(outputDir, `${slug}-exploration-diagnostics.json`);
    writeOutput(explorationDiagPath, JSON.stringify(buildDiagnosticsOutput(explorationSession), null, 2), 'exploration diagnostics');
  }

  // Calibration data is written by the engine (debateEngine.ts) using calibrationDataRoot.
  // The CLI previously wrote a second identical copy here (t/2716); removed — one write per debate.

  // Dump flight recorder to output directory
  const recorderDump = recorder.dumpToFile(path.join(outputDir, `${slug}-flight-recorder.jsonl`));
  log(`Flight recorder: ${recorderDump.event_count} events → ${recorderDump.path}`);

  const elapsed = Date.now() - startTime;

  // Output result JSON to stdout
  const result = {
    success: true,
    debateId: session.id,
    name: session.title,
    slug,
    topic: session.topic.final,
    files: {
      debate: jsonPath,
      transcript: jsonPath,
      diagnostics: diagPath,
      harvest: harvestPath,
      markdown: markdownPath,
    },
    stats: {
      rounds: engineConfig.rounds,
      entries: session.transcript.length,
      apiCalls: session.diagnostics?.overview.total_ai_calls ?? 0,
      totalTimeMs: elapsed,
      claimsAccepted: session.diagnostics?.overview.claims_accepted ?? 0,
      claimsRejected: session.diagnostics?.overview.claims_rejected ?? 0,
    },
    ...(session.perturbation_result ? { perturbation: session.perturbation_result } : {}),
  };

  console.log(JSON.stringify(result, null, 2));
}

async function runCiGolden(): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveRepoRoot(__dirname);
  const goldenDir = path.join(repoRoot, 'evals', 'golden');

  if (!fs.existsSync(goldenDir)) {
    console.error(`Golden fixtures directory not found: ${goldenDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(goldenDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.error('No golden fixture files found in evals/golden/');
    process.exit(1);
  }

  log(`CI Golden: ${files.length} fixtures in ${goldenDir}`);
  log('Loading taxonomy...');
  const taxonomy = loadTaxonomy(repoRoot);
  const vocab = loadVocabulary(repoRoot);

  if (!getGlobalRecorder()) {
    const recorder = new FlightRecorder({ capacity: 2000, dumpOnError: false });
    setGlobalRecorder(recorder);
  }

  const { extractCalibrationData } = await import('./calibrationLogger.js');

  const results: Array<{
    fixture: string;
    debateId: string;
    score: number;
    tier: string;
    quality_floor: number;
    passed: boolean;
    error?: string;
  }> = [];

  for (const file of files) {
    const fixturePath = path.join(goldenDir, file);
    log(`Running fixture: ${file}`);

    try {
      const config: GoldenFixtureConfig = JSON.parse(
        fs.readFileSync(fixturePath, 'utf-8'),
      );

      const adapter = createCLIAdapter(repoRoot, config.apiKey);
      const model = config.model ?? 'gemini-3.5-flash-lite';
      const activePovers = (config.activePovers ?? ['accelerationist', 'safetyist', 'skeptic']) as Exclude<SpeakerId, 'user'>[];
      const qualityFloor = config.quality_floor ?? 30;

      const engineConfig: DebateConfig = {
        soulResolver: resolvePoverInfo,
        topic: config.topic ?? '',
        sourceType: 'topic',
        sourceRef: '',
        sourceContent: '',
        activePovers,
        protocolId: config.protocolId ?? 'structured',
        model,
        rounds: config.rounds ?? 1,
        responseLength: (config.responseLength ?? 'brief') as 'brief' | 'medium' | 'detailed',
        turnValidation: { enabled: true },
        moderatorMode: config.moderatorMode,
        talmudicReferences: config.talmudicReferences ? {
          ...config.talmudicReferences,
          corpusPath: path.resolve(repoRoot, config.talmudicReferences.corpusPath),
        } : undefined,
        vocabulary: vocab.standardized.length > 0
          ? { standardizedTerms: vocab.standardized as import('../dictionary/types.js').StandardizedTerm[], colloquialTerms: vocab.colloquial as import('../dictionary/types.js').ColloquialTerm[] }
          : undefined,
      };

      const { session } = await runHeadlessDebate(engineConfig, adapter, taxonomy, (p) => {
        log(`  [${p.phase}] ${p.speaker ? `${p.speaker}: ` : ''}${p.message}`);
      });

      const dataPoint = extractCalibrationData(session, 'ci-golden');
      const scoreResult = computeQualityScore(dataPoint);
      const passed = scoreResult.score >= qualityFloor;

      results.push({
        fixture: file,
        debateId: session.id,
        score: scoreResult.score,
        tier: scoreResult.tier,
        quality_floor: qualityFloor,
        passed,
      });

      log(`  Score: ${scoreResult.score} (${scoreResult.tier}), floor: ${qualityFloor} → ${passed ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getGlobalRecorder()?.record({ type: 'state.error', component: 'cli', level: 'error', message: `Golden fixture ${file} failed`, error: { name: (err as Error).name ?? 'Error', message: msg, stack: (err as Error).stack } });
      results.push({
        fixture: file,
        debateId: '',
        score: 0,
        tier: 'Error',
        quality_floor: 30,
        passed: false,
        error: msg,
      });
      log(`  ERROR: ${msg}`);
    }
  }

  const overall = results.every(r => r.passed);
  console.log(JSON.stringify({ results, overall }, null, 2));
  process.exit(overall ? 0 : 1);
}

if (process.argv.includes('--ci-golden')) {
  runCiGolden().catch(err => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`FATAL: ${msg}`);
    getGlobalRecorder()?.record({ type: 'system.error', component: 'cli', level: 'error', message: 'Fatal CI golden error', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    console.log(JSON.stringify({ results: [], overall: false, error: msg }, null, 2));
    process.exit(1);
  });
} else {
  main()
    .then(() => {
      // t/1824: main() finishes with every artifact written, but the flight-recorder named-pipe
      // listener started in main() (recorder.startPipeListener) is a live net.Server handle that
      // keeps Node's event loop alive. cli.ts previously released it ONLY on SIGINT, so a clean
      // batch run — stdout piped/redirected, no signal — hung until an external watchdog killed the
      // process and never produced exit code 0 (batch harnesses keying on returncode read success
      // as failure). Release it here so the loop drains and the process exits 0 on the clean path.
      // (The error path below force-exits, so the handle dies with the process there.)
      getGlobalRecorder()?.stopPipeListener();
    })
    .catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      log(`FATAL: ${msg}`);
      getGlobalRecorder()?.record({ type: 'system.error', component: 'cli', level: 'error', message: 'Fatal unhandled error', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      console.log(JSON.stringify({ success: false, error: msg }));
      process.exit(1);
    });
}
