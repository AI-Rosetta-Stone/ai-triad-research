// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useMemo } from 'react';
import type { Organization, OrganizationEdge, OrganizationEdgeType, PovStance, PovAlignmentTier } from '../../bridge/types';
import type { KeyFigure, ExternalLink } from '@lib/organizations/types';
import { TypeBadge, ExternalLinkRow, extractDomain } from '../shared/DetailPrimitives';
import './OrganizationDetail.css';

const TIER_TO_SCORE: Record<PovAlignmentTier, number> = {
  opposes: -1.0, leans_against: -0.5, mixed_or_silent: 0, leans_toward: 0.5, champions: 1.0,
};
function tierScore(stance: PovStance): number { return TIER_TO_SCORE[stance.tier] ?? 0; }

const TIER_CHIP_COLORS: Record<PovAlignmentTier, { bg: string; fg: string }> = {
  opposes:          { bg: '#fecaca', fg: '#991b1b' },
  leans_against:    { bg: '#fed7aa', fg: '#9a3412' },
  mixed_or_silent:  { bg: '#e2e8f0', fg: '#475569' },
  leans_toward:     { bg: '#bbf7d0', fg: '#166534' },
  champions:        { bg: '#86efac', fg: '#14532d' },
};
const TIER_LABELS: Record<PovAlignmentTier, string> = {
  opposes: 'Opposes', leans_against: 'Leans Against', mixed_or_silent: 'Mixed or Silent',
  leans_toward: 'Leans Toward', champions: 'Champions',
};
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useOrganizationStore } from '../../hooks/useOrganizationStore';
import { groupVisibleEdges } from './organizationEdgeGroups';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';

const INITIALS_PALETTE = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6',
  '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#06b6d4',
];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function isUrl(str: string): boolean {
  return /^https?:\/\//i.test(str);
}

export function OrgLogo({ name, url, size = 24 }: { name: string; url?: string; size?: number }) {
  const [imgFailed, setImgFailed] = useState(false);
  const domain = url ? extractDomain(url) : null;
  const faviconUrl = domain && !imgFailed
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size * 2}`
    : null;

  if (faviconUrl) {
    return (
      <img
        src={faviconUrl}
        alt=""
        width={size}
        height={size}
        className="org-logo-img"
        onError={() => setImgFailed(true)}
      />
    );
  }

  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const bg = INITIALS_PALETTE[hashName(name) % INITIALS_PALETTE.length];

  return (
    <span
      className="org-logo-initials"
      /* eslint-disable-next-line local/no-inline-style -- size/bg are per-instance dynamic values passed as CSS custom properties */
      style={{ '--size': `${size / 16}em`, '--font-size': `${(size * 0.4) / 16}em`, '--bg': bg } as React.CSSProperties}
    >
      {initials}
    </span>
  );
}

function PersonAvatar({ name, size = 24 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const bg = INITIALS_PALETTE[hashName(name) % INITIALS_PALETTE.length];
  return (
    <span
      className="person-avatar"
      /* eslint-disable-next-line local/no-inline-style -- size/bg are per-instance dynamic values passed as CSS custom properties */
      style={{ '--size': `${size / 16}em`, '--font-size': `${(size * 0.4) / 16}em`, '--bg': bg } as React.CSSProperties}
    >
      {initials}
    </span>
  );
}

const POV_COLORS: Record<string, string> = {
  accelerationist: '#f97316',
  safetyist: '#22c55e',
  skeptic: '#a855f7',
};

const POV_LABELS: Record<string, string> = {
  accelerationist: 'Acc',
  safetyist: 'Saf',
  skeptic: 'Skp',
};

function PovAlignmentBar({ alignment }: { alignment?: Organization['pov_alignment'] }) {
  if (!alignment) return <span className="od-muted-075">No alignment data</span>;
  const povs = ['accelerationist', 'safetyist', 'skeptic'] as const;
  return (
    <div className="od-flex-col-6">
      {povs.map((pov) => {
        const stance = alignment[pov];
        if (!stance) return null;
        const score = tierScore(stance);
        const absScore = Math.abs(score);
        const color = POV_COLORS[pov] ?? 'var(--text-muted)';
        const chipColors = TIER_CHIP_COLORS[stance.tier] ?? TIER_CHIP_COLORS.mixed_or_silent;
        return (
          <div key={pov} className="od-flex-col-2">
            <div className="od-pov-row-header">
              {/* eslint-disable-next-line local/no-inline-style -- per-POV color computed from POV_COLORS, passed as CSS custom property */}
              <span className="od-pov-label" style={{ '--pov-color': color } as React.CSSProperties}>{POV_LABELS[pov]}</span>
              <span className="od-pov-scale-label">−1</span>
              <div className="od-pov-track">
                <div
                  className="od-pov-fill"
                  /* eslint-disable-next-line local/no-inline-style -- fill position/width/color computed from stance score, passed as CSS custom properties */
                  style={{
                    '--left': score < 0 ? `${50 - absScore * 50}%` : '50%',
                    '--width': `${absScore * 50}%`,
                    '--fill-color': color,
                  } as React.CSSProperties}
                />
                <div className="od-pov-center-line" />
              </div>
              <span className="od-pov-scale-label">+1</span>
              <span
                className="od-pov-tier-chip"
                /* eslint-disable-next-line local/no-inline-style -- tier chip colors computed from TIER_CHIP_COLORS, passed as CSS custom properties */
                style={{ '--chip-bg': chipColors.bg, '--chip-fg': chipColors.fg } as React.CSSProperties}
              >
                {TIER_LABELS[stance.tier] ?? stance.tier}
              </span>
            </div>
            {stance.behavioral_notes && (
              <div className="od-pov-notes">
                {stance.behavioral_notes}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const EDGE_GROUP_LABELS: Partial<Record<OrganizationEdgeType, string>> = {
  ALLIED_WITH: 'Allies',
  COMPETES_WITH: 'Competitors',
  FUNDS: 'Funders / Funded',
  ADVOCATES_FOR: 'Advocates For',
  OPPOSES: 'Opposes',
  SUPPORTS_POLICY: 'Supports Policy',
  OPPOSES_POLICY: 'Opposes Policy',
  ENGAGED_WITH: 'Engaged With',
  PUBLISHED: 'Published',
};

export function RelationshipSection({ orgId, onSelectOrg }: { orgId: string; onSelectOrg?: (id: string) => void }) {
  const [edges, setEdges] = useState<OrganizationEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const allOrgs = useOrganizationStore((s) => s.organizations);

  const orgNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of allOrgs) map.set(o.id, o.name);
    return map;
  }, [allOrgs]);

  useEffect(() => {
    setLoading(true);
    api.getOrganizationEdges(orgId)
      .then(setEdges)
      .catch((err: unknown) => {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'org-relationships', level: 'error',
          message: 'Failed to load organization edges',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setEdges([]);
      })
      .finally(() => setLoading(false));
  }, [orgId]);

  if (loading) return <span className="od-muted-075">Loading relationships...</span>;
  // t/298: rejected edges are dropped and proposed ones marked Unreviewed (Design p/25#140).
  const grouped = groupVisibleEdges(edges, orgId);
  if (grouped.size === 0) return null;

  return (
    <div className="od-flex-col-8">
      {[...grouped.entries()].map(([type, peers]) => (
        <div key={type}>
          <div className="od-rel-group-header">
            {EDGE_GROUP_LABELS[type] ?? type} ({peers.length})
          </div>
          <div className="od-flex-col-4">
            {peers.map((peer, i) => (
              // Index in the key: an org can hold two edges of one type to the same peer.
              <div key={`${peer.id}-${i}`} className="od-text-078">
                <div className="od-row-baseline-6">
                  <button
                    className="btn-xs btn-ghost od-rel-link-btn"
                    style={{ '--cursor': onSelectOrg ? 'pointer' : 'default' } as React.CSSProperties}
                    onClick={() => onSelectOrg?.(peer.id)}
                    disabled={!onSelectOrg}
                    title={peer.id}
                  >
                    {orgNameMap.get(peer.id) ?? peer.id}
                    {peer.unreviewed && <>{' '}<span className="od-status od-edge-unreviewed">Unreviewed</span></>}
                  </button>
                </div>
                {peer.rationale && (
                  <div className="od-note-072">{peer.rationale}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function OrganizationDetail({ org, onSelectOrg }: { org: Organization; onSelectOrg?: (id: string) => void }) {
  const policyRegistry = useTaxonomyStore((s) => s.policyRegistry);
  const situations = useTaxonomyStore((s) => s.situations);

  const policyNameMap = useMemo(() => {
    const map = new Map<string, string>();
    if (policyRegistry) {
      for (const p of policyRegistry) map.set(p.id, p.action);
    }
    return map;
  }, [policyRegistry]);

  const situationNameMap = useMemo(() => {
    const map = new Map<string, string>();
    if (situations?.nodes) {
      for (const n of situations.nodes) map.set(n.id, n.label);
    }
    return map;
  }, [situations]);

  const linkTitleByUrl = useMemo(() => {
    const map = new Map<string, string>();
    if (org.external_links) {
      for (const el of org.external_links) {
        if (typeof el !== 'string' && el.title) map.set(el.url, el.title);
      }
    }
    return map;
  }, [org.external_links]);

  return (
    <div className="org-detail">
      {/* Header */}
      <div>
        <div className="od-header-row">
          <OrgLogo name={org.name} url={org.url} size={32} />
          <h2 className="od-title">{org.name}</h2>
          <TypeBadge type={org.type} />
          {org.status && org.status !== 'active' && (
            <span className="od-status">{org.status}</span>
          )}
        </div>
        {org.short_name && org.short_name !== org.name && (
          <div className="od-short-name">{org.short_name}</div>
        )}
        <div className="od-meta-row">
          {org.headquarters && <span>{org.headquarters}</span>}
          {org.founded && <span>Founded {org.founded}</span>}
          {org.url && (
            <button
              className="btn-xs btn-ghost od-website-link"
              onClick={() => { void api.openExternal(org.url!).catch((err: unknown) => {
                getGlobalRecorder()?.record({
                  type: 'system.error', component: 'org-detail', level: 'error',
                  message: 'Failed to open external URL',
                  error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
                });
              }); }}
            >
              Website
            </button>
          )}
        </div>
      </div>

      {/* Description */}
      {org.description && (
        <div>
          <h3 className="od-section-h3">About</h3>
          <p className="od-description">{org.description}</p>
        </div>
      )}

      {/* POV Alignment */}
      <div>
        <h3 className="od-section-h3-md">POV Alignment</h3>
        <PovAlignmentBar alignment={org.pov_alignment} />
      </div>

      {/* Topic Engagement */}
      {org.topic_engagement && org.topic_engagement.length > 0 && (
        <div>
          <h3 className="od-section-h3">Topic Engagement</h3>
          <div className="od-flex-col-6">
            {org.topic_engagement.map((te, i) => {
              const label = situationNameMap.get(te.topic_ref);
              return (
                <div key={i} className="od-text-078">
                  <div className="od-row-baseline-6">
                    <span className="od-item-label">{label ?? te.topic_ref}</span>
                    {te.stance && (
                      <span className="od-stance-badge">
                        {te.stance}
                      </span>
                    )}
                    <span className="od-ref-mono">{te.topic_ref}</span>
                  </div>
                  {te.description && (
                    <div className="od-note-072">{te.description}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Policy Engagement */}
      {org.policy_engagement && org.policy_engagement.length > 0 && (
        <div>
          <h3 className="od-section-h3">Policy Engagement</h3>
          <div className="od-flex-col-6">
            {org.policy_engagement.map((pe, i) => {
              const label = policyNameMap.get(pe.policy_ref);
              return (
                <div key={i} className="od-text-078">
                  <div className="od-row-baseline-6">
                    <span className="od-item-label">{label ?? pe.policy_ref}</span>
                    <span
                      className="od-policy-stance-badge"
                      style={{
                        '--stance-bg': pe.stance === 'supports' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                        '--stance-fg': pe.stance === 'supports' ? '#22c55e' : '#ef4444',
                      } as React.CSSProperties}
                    >
                      {pe.stance}
                    </span>
                    <span className="od-ref-mono">{pe.policy_ref}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Relationships */}
      <div>
        <h3 className="od-section-h3-md">Relationships</h3>
        <RelationshipSection orgId={org.id} onSelectOrg={onSelectOrg} />
      </div>

      {/* Key Figures */}
      {org.key_figures && org.key_figures.length > 0 && (
        <div>
          <h3 className="od-section-h3-md">Key Figures</h3>
          <div className="od-figures-grid">
            {org.key_figures.map((kf, i) => {
              if (typeof kf === 'string') {
                return (
                  <div key={i} className="od-figure-row">
                    <PersonAvatar name={kf} />
                    <span className="od-figure-name">{kf}</span>
                  </div>
                );
              }
              const fig = kf as KeyFigure;
              if (!fig.name) return null;
              return (
                <div key={i} className="od-figure-row-start">
                  <PersonAvatar name={fig.name} />
                  <div className="od-figure-body">
                    <div className="od-figure-name">
                      {fig.name}
                      {fig.role && <span className="od-figure-role">{' · '}{fig.role}</span>}
                    </div>
                    {fig.relevance && (
                      <div
                        title={fig.relevance}
                        className="od-figure-relevance"
                      >
                        {fig.relevance}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* External Links */}
      {org.external_links && org.external_links.length > 0 && (
        <div>
          <h3 className="od-section-h3">External Links</h3>
          <div className="od-flex-col-2">
            {org.external_links.map((link, i) => {
              const url = typeof link === 'string' ? link : link.url;
              const title = typeof link === 'string' ? undefined : link.title;
              const type = typeof link === 'string' ? undefined : link.type;
              if (!url) return null;
              return <ExternalLinkRow key={i} url={url} title={title} type={type} orgUrl={org.url} />;
            })}
          </div>
        </div>
      )}

      {/* Sources */}
      {org.source_refs && org.source_refs.length > 0 && (
        <div>
          <h3 className="od-section-h3">Sources</h3>
          <div className="od-flex-col-2">
            {org.source_refs.map((ref, i) => {
              if (isUrl(ref)) {
                return <ExternalLinkRow key={i} url={ref} title={linkTitleByUrl.get(ref)} orgUrl={org.url} />;
              }
              return (
                <span key={i} title={ref} className="od-ref-chip">
                  {ref}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Tags */}
      {org.tags && org.tags.length > 0 && (
        <div className="od-tags-row">
          {org.tags.map((tag, i) => (
            <span key={i} className="od-tag-chip">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* ID + timestamps */}
      <div className="od-footer">
        <span className="od-footer-id">{org.id}</span>
        {org.created_at && <span className="od-footer-spaced">Created: {new Date(org.created_at).toLocaleDateString()}</span>}
        {org.last_modified && <span className="od-footer-spaced">Modified: {new Date(org.last_modified).toLocaleDateString()}</span>}
      </div>
    </div>
  );
}
