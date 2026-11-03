#!/usr/bin/env python3
"""
Populate provenance and resolved_url fields in ai-triad-sources metadata.json files.

Pass 1: Regex extraction from filenames + snapshot headers (arXiv, DOI, SSRN, existing URLs)
Pass 2: API verification via Crossref and arXiv (promotes extracted → verified)
Pass 3: Tavily web search for remaining unresolved sources (--tavily flag)
Fallback: Google Scholar/Search URLs for still-unresolved sources

Usage:
    python3 scripts/populate_provenance.py [--dry-run] [--skip-api] [--tavily] [--sources-root PATH]
"""

import os
import re
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

DRY_RUN = '--dry-run' in sys.argv
SKIP_API = '--skip-api' in sys.argv
USE_TAVILY = '--tavily' in sys.argv
SOURCES_ROOT = None
for i, arg in enumerate(sys.argv):
    if arg == '--sources-root' and i + 1 < len(sys.argv):
        SOURCES_ROOT = sys.argv[i + 1]

if not SOURCES_ROOT:
    # Default: sibling repo
    script_dir = Path(__file__).resolve().parent.parent
    SOURCES_ROOT = str(script_dir.parent / 'ai-triad-sources')

if not os.path.isdir(SOURCES_ROOT):
    print(f'ERROR: Sources root not found: {SOURCES_ROOT}')
    sys.exit(1)

# ── Regex patterns ────────────────────────────────────────

ARXIV_PATTERN = re.compile(r'\b(\d{4}\.\d{4,5})(v\d+)?\b')
DOI_PATTERN = re.compile(r'\b(10\.\d{4,9}/[^\s")\]>]+)')
SSRN_PATTERN = re.compile(r'ssrn[- ]?(\d{6,8})', re.IGNORECASE)

# ── API helpers ───────────────────────────────────────────

def verify_arxiv(arxiv_id: str, title: str) -> Optional[dict]:
    """Check arXiv API. Returns verified provenance entry or None."""
    clean_id = arxiv_id.replace('arXiv:', '')
    url = f'https://export.arxiv.org/api/query?id_list={clean_id}&max_results=1'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'AITriadResearch/1.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode('utf-8')
        # Simple check: does the response contain a <title> that isn't "Error"?
        if '<title>Error' not in body and '<entry>' in body:
            return {'scheme': 'arxiv', 'id': f'arXiv:{clean_id}', 'confidence': 'verified'}
    except Exception:
        pass
    return None

def verify_doi(doi: str, title: str) -> Optional[dict]:
    """Check Crossref API. Returns verified provenance entry or None."""
    url = f'https://api.crossref.org/works/{urllib.parse.quote(doi, safe="")}'
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'AITriadResearch/1.0 (mailto:research@berkman.harvard.edu)',
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        if data.get('status') == 'ok':
            return {'scheme': 'doi', 'id': f'doi:{doi}', 'confidence': 'verified'}
    except Exception:
        pass
    return None

# ── Tavily web search (Tier 3) ────────────────────────────

TAVILY_API_KEY = os.environ.get('TAVILY_API_KEY', '')

ACADEMIC_DOMAINS = {
    'arxiv.org': 'arxiv',
    'doi.org': 'doi',
    'ssrn.com': 'ssrn',
    'semanticscholar.org': 'url',
    'acm.org': 'url',
    'ieee.org': 'url',
    'nature.com': 'url',
    'sciencedirect.com': 'url',
    'springer.com': 'url',
    'wiley.com': 'url',
    'tandfonline.com': 'url',
    'jstor.org': 'url',
    'pubmed.ncbi.nlm.nih.gov': 'url',
    'nber.org': 'url',
    'brookings.edu': 'url',
    'rand.org': 'url',
}

# t/4658 issue 2: Tavily Pass 3 had no host filtering, so a social/aggregator URL could be
# written as a source's resolved provenance with no signal it wasn't a publisher/academic host.
# Soft-flag rather than reject (Quality design review, p/678#216): legitimate social-sourced
# docs may exist, so a flagged match is still written, just marked for human review.
SOCIAL_AGGREGATOR_HOSTS = {
    'linkedin.com', 'x.com', 'medium.com', 'substack.com',
    'reddit.com', 'facebook.com', 'instagram.com', 'tiktok.com',
}


def is_social_aggregator_host(url: str) -> bool:
    """True when url's host is a known social/aggregator domain (soft-flag, not a hard reject)."""
    return any(host in url for host in SOCIAL_AGGREGATOR_HOSTS)


def tavily_search(title: str, first_author: str) -> Optional[list]:
    """Search Tavily for a source by title + author. Returns list of result dicts or None."""
    if not TAVILY_API_KEY:
        return None

    query = f'"{title}"'
    if first_author:
        query += f' {first_author}'

    try:
        payload = json.dumps({
            'api_key': TAVILY_API_KEY,
            'query': query,
            'search_depth': 'basic',
            'max_results': 3,
            'include_answer': False,
        }).encode('utf-8')

        req = urllib.request.Request(
            'https://api.tavily.com/search',
            data=payload,
            headers={'Content-Type': 'application/json', 'User-Agent': 'AITriadResearch/1.0'},
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return data.get('results', [])
    except Exception as e:
        print(f'    Tavily error: {e}', file=sys.stderr)
        return None


def match_academic_url(results: list) -> Optional[dict]:
    """From Tavily results, find the best academic URL and classify it."""
    if not results:
        return None

    for r in results:
        url = r.get('url', '')
        if not url:
            continue

        # Check against known academic domains
        for domain, scheme in ACADEMIC_DOMAINS.items():
            if domain in url:
                # Try to extract specific identifiers
                if scheme == 'arxiv':
                    m = ARXIV_PATTERN.search(url)
                    if m:
                        return {'scheme': 'arxiv', 'id': f'arXiv:{m.group(0)}', 'url': url}
                elif scheme == 'doi':
                    m = DOI_PATTERN.search(url)
                    if m:
                        return {'scheme': 'doi', 'id': f'doi:{m.group(1).rstrip(".,;")}', 'url': url}
                elif scheme == 'ssrn':
                    m = SSRN_PATTERN.search(url)
                    if m:
                        return {'scheme': 'ssrn', 'id': f'SSRN:{m.group(1)}', 'url': url}
                else:
                    return {'scheme': 'url', 'id': url, 'url': url}

        # Check for DOI in any URL
        m = DOI_PATTERN.search(url)
        if m:
            return {'scheme': 'doi', 'id': f'doi:{m.group(1).rstrip(".,;")}', 'url': url}

    # No academic match — return best URL as fallback
    best = results[0].get('url', '')
    if best:
        match = {'scheme': 'url', 'id': best, 'url': best}
        if is_social_aggregator_host(best):
            match['flagged_host'] = True
            print(f'    WARN: Tavily fallback match is a social/aggregator host, soft-flagging: {best}', file=sys.stderr)
        return match
    return None


# ── Resolver URL builders ─────────────────────────────────

def resolve_url(provenance: list, meta: dict) -> Optional[str]:
    """Pick the best resolved_url from provenance entries and metadata."""
    for entry in provenance:
        scheme = entry.get('scheme', '')
        eid = entry.get('id', '')
        if scheme == 'doi':
            doi_val = eid.replace('doi:', '')
            return f'https://doi.org/{doi_val}'
        elif scheme == 'arxiv':
            arxiv_val = eid.replace('arXiv:', '')
            return f'https://arxiv.org/abs/{arxiv_val}'
        elif scheme == 'ssrn':
            ssrn_val = eid.replace('SSRN:', '')
            return f'https://papers.ssrn.com/sol3/papers.cfm?abstract_id={ssrn_val}'
        elif scheme == 'url' and eid.startswith('http'):
            return eid

    # Fallback to existing url field
    existing_url = meta.get('url', '')
    if existing_url and existing_url.startswith('http'):
        return existing_url

    return None

def google_fallback_url(title: str, authors: list, is_academic: bool) -> str:
    """Build a Google Scholar or Google search fallback URL."""
    query = title
    if authors and len(authors) <= 3:
        query += ' ' + ' '.join(authors[:2])
    encoded = urllib.parse.quote(query)
    if is_academic:
        return f'https://scholar.google.com/scholar?q={encoded}'
    else:
        return f'https://www.google.com/search?q=%22{urllib.parse.quote(title)}%22'

def guess_academic(meta: dict) -> bool:
    """Heuristic: is this source likely academic?"""
    if meta.get('source_type') != 'pdf':
        return False
    authors = meta.get('authors', [])
    if len(authors) >= 2:
        return True
    title = meta.get('title', '').lower()
    # Academic signals
    if any(w in title for w in ['arxiv', 'proceedings', 'journal', 'conference', 'ieee', 'acm', 'workshop']):
        return True
    return False

# ── Main processing ───────────────────────────────────────

def process_source(dir_name: str) -> dict:
    """Process a single source directory. Returns stats."""
    meta_path = os.path.join(SOURCES_ROOT, dir_name, 'metadata.json')
    if not os.path.exists(meta_path):
        return {'status': 'skip', 'reason': 'no metadata.json'}

    with open(meta_path, 'r', encoding='utf-8') as f:
        meta = json.load(f)

    provenance = meta.get('provenance', [])
    if provenance:
        # Already has provenance — skip unless resolved_url is missing
        if meta.get('resolved_url'):
            return {'status': 'skip', 'reason': 'already populated'}

    # ── Pass 1: Extract identifiers from local files ──

    new_provenance = list(provenance)  # preserve existing

    # Check raw filenames
    raw_dir = os.path.join(SOURCES_ROOT, dir_name, 'raw')
    if os.path.isdir(raw_dir):
        for fname in os.listdir(raw_dir):
            m = ARXIV_PATTERN.search(fname)
            if m and not any(e['scheme'] == 'arxiv' for e in new_provenance):
                arxiv_id = m.group(0)
                new_provenance.append({'scheme': 'arxiv', 'id': f'arXiv:{arxiv_id}', 'confidence': 'extracted'})

            m = SSRN_PATTERN.search(fname)
            if m and not any(e['scheme'] == 'ssrn' for e in new_provenance):
                ssrn_id = m.group(1)
                new_provenance.append({'scheme': 'ssrn', 'id': f'SSRN:{ssrn_id}', 'confidence': 'extracted'})

    # Check snapshot header for DOI and arXiv
    snap_path = os.path.join(SOURCES_ROOT, dir_name, 'snapshot.md')
    if os.path.exists(snap_path):
        with open(snap_path, 'r', errors='ignore') as f:
            head = f.read(8000)

        m = DOI_PATTERN.search(head)
        if m and not any(e['scheme'] == 'doi' for e in new_provenance):
            doi = m.group(1).rstrip('.,;')
            new_provenance.append({'scheme': 'doi', 'id': f'doi:{doi}', 'confidence': 'extracted'})

        m = ARXIV_PATTERN.search(head)
        if m and not any(e['scheme'] == 'arxiv' for e in new_provenance):
            arxiv_id = m.group(0)
            new_provenance.append({'scheme': 'arxiv', 'id': f'arXiv:{arxiv_id}', 'confidence': 'extracted'})

    # Add existing url as provenance entry if not already there
    existing_url = meta.get('url', '')
    if existing_url and existing_url.startswith('http') and not any(e['scheme'] == 'url' for e in new_provenance):
        new_provenance.append({'scheme': 'url', 'id': existing_url, 'confidence': 'extracted'})

    # ── Pass 2: API verification ──

    title = meta.get('title', '')
    if not SKIP_API:
        for entry in new_provenance:
            if entry['confidence'] != 'extracted':
                continue
            if entry['scheme'] == 'arxiv':
                result = verify_arxiv(entry['id'], title)
                if result:
                    entry['confidence'] = 'verified'
                time.sleep(0.3)  # polite rate limit
            elif entry['scheme'] == 'doi':
                result = verify_doi(entry['id'].replace('doi:', ''), title)
                if result:
                    entry['confidence'] = 'verified'
                time.sleep(0.1)

    # ── Pass 3: Tavily web search for unresolved ──

    if USE_TAVILY and TAVILY_API_KEY and not any(
        e['confidence'] in ('verified', 'extracted') for e in new_provenance
    ):
        authors = meta.get('authors', [])
        first_author = authors[0] if authors else ''
        results = tavily_search(title, first_author)
        if results:
            match = match_academic_url(results)
            if match:
                # Verify if we got an arXiv or DOI
                verified = False
                if match['scheme'] == 'arxiv' and not SKIP_API:
                    v = verify_arxiv(match['id'], title)
                    if v:
                        match['confidence'] = 'verified'
                        verified = True
                    time.sleep(0.3)
                elif match['scheme'] == 'doi' and not SKIP_API:
                    v = verify_doi(match['id'].replace('doi:', ''), title)
                    if v:
                        match['confidence'] = 'verified'
                        verified = True
                    time.sleep(0.1)

                if not verified:
                    # Academic domain match but not API-verifiable
                    match['confidence'] = 'search'

                if not any(e['scheme'] == match['scheme'] and e['id'] == match['id'] for e in new_provenance):
                    new_entry = {
                        'scheme': match['scheme'],
                        'id': match['id'],
                        'confidence': match.get('confidence', 'search'),
                    }
                    if match.get('flagged_host'):
                        new_entry['flagged_host'] = True
                    new_provenance.append(new_entry)
        time.sleep(1)  # polite rate limiting for Tavily

    # ── Sort provenance: strongest scheme first ──

    scheme_priority = {'doi': 0, 'arxiv': 1, 'ssrn': 2, 'pubmed': 3, 'url': 10}
    new_provenance.sort(key=lambda e: scheme_priority.get(e['scheme'], 5))

    # ── Resolve URL ──

    resolved_url = resolve_url(new_provenance, meta)
    if not resolved_url and title:
        is_acad = guess_academic(meta)
        resolved_url = google_fallback_url(title, meta.get('authors', []), is_acad)

    # ── Determine provenance_status ──

    if any(e['confidence'] == 'verified' for e in new_provenance):
        prov_status = 'verified'
    elif any(e['confidence'] == 'extracted' for e in new_provenance):
        prov_status = 'extracted'
    elif any(e['confidence'] == 'search' for e in new_provenance):
        prov_status = 'extracted'  # search-found is promoted to extracted level
    elif new_provenance:
        prov_status = 'partial'
    else:
        prov_status = 'unresolved'

    # ── Write back ──

    meta['provenance'] = new_provenance
    meta['provenance_status'] = prov_status
    if resolved_url:
        meta['resolved_url'] = resolved_url
    # Also update top-level url if it was empty and we have a direct URL (not search fallback)
    if not meta.get('url') and resolved_url and 'google.com' not in resolved_url and 'scholar.google' not in resolved_url:
        meta['url'] = resolved_url

    if not DRY_RUN:
        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)
            f.write('\n')

    return {
        'status': 'updated',
        'provenance_count': len(new_provenance),
        'provenance_status': prov_status,
        'resolved_url': resolved_url,
        'schemes': [e['scheme'] for e in new_provenance],
    }

# ── Run ───────────────────────────────────────────────────

def main():
    dirs = sorted([
        d for d in os.listdir(SOURCES_ROOT)
        if os.path.isdir(os.path.join(SOURCES_ROOT, d)) and not d.startswith('.')
    ])
    print(f'Processing {len(dirs)} source directories in {SOURCES_ROOT}')
    if DRY_RUN:
        print('DRY RUN — no files will be modified')
    if SKIP_API:
        print('Skipping API verification (Pass 2)')
    if USE_TAVILY:
        if TAVILY_API_KEY:
            print('Tavily web search enabled (Pass 3)')
        else:
            print('WARNING: --tavily specified but TAVILY_API_KEY not set — Pass 3 skipped')

    stats = {'updated': 0, 'skip': 0, 'error': 0}
    status_counts = {'verified': 0, 'extracted': 0, 'partial': 0, 'unresolved': 0}
    scheme_counts = {}
    has_resolved_url = 0

    for i, d in enumerate(dirs):
        try:
            result = process_source(d)
            stats[result['status']] = stats.get(result['status'], 0) + 1
            if result['status'] == 'updated':
                status_counts[result['provenance_status']] = status_counts.get(result['provenance_status'], 0) + 1
                if result.get('resolved_url'):
                    has_resolved_url += 1
                for s in result.get('schemes', []):
                    scheme_counts[s] = scheme_counts.get(s, 0) + 1
            if (i + 1) % 50 == 0:
                print(f'  [{i+1}/{len(dirs)}] {stats["updated"]} updated, {stats["skip"]} skipped')
        except Exception as e:
            stats['error'] += 1
            print(f'  ERROR {d}: {e}')

    print(f'\n=== Results ===')
    print(f'Updated:  {stats["updated"]}')
    print(f'Skipped:  {stats["skip"]}')
    print(f'Errors:   {stats["error"]}')
    print(f'\nProvenance status:')
    for k, v in sorted(status_counts.items()):
        print(f'  {k}: {v}')
    print(f'\nSchemes found:')
    for k, v in sorted(scheme_counts.items(), key=lambda x: -x[1]):
        print(f'  {k}: {v}')
    print(f'\nHas resolved_url: {has_resolved_url}/{stats["updated"]}')

if __name__ == '__main__':
    main()
