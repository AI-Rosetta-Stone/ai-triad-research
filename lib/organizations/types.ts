export type Pov = 'accelerationist' | 'safetyist' | 'skeptic';

export type PovAlignmentTier =
  | 'opposes'
  | 'leans_against'
  | 'mixed_or_silent'
  | 'leans_toward'
  | 'champions';

export type PovStance = { tier: PovAlignmentTier; rationale: string; behavioral_notes?: string | null };
export interface TopicEngagement { topic_ref: string; stance?: string; description?: string }
export interface PolicyEngagement { policy_ref: string; stance: 'supports' | 'opposes' }

export interface PovAlignmentDerivedPerCamp {
  advocates: number;
  opposes: number;
  n: number;
  net_ratio: number | null;
}

export interface PovAlignmentDerivedProvenance {
  computed_at: string;
  cmdlet_version: string;
  input_edges_sha: string;
  included_status_filter: string[];
  edge_count: number;
}

export interface PovAlignmentDerived {
  acc: PovAlignmentDerivedPerCamp;
  saf: PovAlignmentDerivedPerCamp;
  skp: PovAlignmentDerivedPerCamp;
  provenance: PovAlignmentDerivedProvenance;
}

export interface KeyFigure { name: string; role?: string; relevance?: string }
export interface ExternalLink { type?: string; url: string; title?: string }

export interface Organization {
  id: string;
  name: string;
  short_name?: string;
  type?: string;
  description?: string;
  url?: string;
  headquarters?: string;
  founded?: number;
  status?: string;
  pov_alignment?: Partial<Record<Pov, PovStance>>;
  pov_alignment_derived?: PovAlignmentDerived;
  topic_engagement?: TopicEngagement[];
  policy_engagement?: PolicyEngagement[];
  key_figures?: (KeyFigure | string)[];
  external_links?: (ExternalLink | string)[];
  source_refs?: string[];
  tags?: string[];
  created_at?: string;
  last_modified?: string;
}

export type OrganizationEdgeType =
  | 'ADVOCATES_FOR' | 'OPPOSES' | 'SUPPORTS_POLICY' | 'OPPOSES_POLICY'
  | 'ENGAGED_WITH' | 'PUBLISHED' | 'ALLIED_WITH' | 'COMPETES_WITH' | 'FUNDS';

export interface OrganizationEdge {
  source: string;
  target: string;
  type: OrganizationEdgeType;
  rationale?: string;
  source_refs?: string[];
  status?: string;
  discovered_at?: string;
}
