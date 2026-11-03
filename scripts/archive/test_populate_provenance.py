#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""Unit tests for populate_provenance.py's social/aggregator host soft-flag (t/4658).

Pass 3 (Tavily web search) had no host filtering, so a social/aggregator URL (e.g.
linkedin.com, x.com, medium.com) could be written into a source's provenance with no
signal that it wasn't a publisher/academic host. Quality's design review (p/678#216)
chose a SOFT flag over a hard reject -- legitimate social-sourced docs may exist -- so
match_academic_url() sets flagged_host: true on the match instead of discarding it.

Runnable under pytest or standalone: `python test_populate_provenance.py`.
"""

import importlib.util
import sys
import tempfile
from pathlib import Path

_DIR = Path(__file__).resolve().parent


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# populate_provenance.py validates SOURCES_ROOT at import time (sys.exit(1) if missing),
# so point --sources-root at a scratch dir that exists before loading the module.
_scratch_root = tempfile.mkdtemp(prefix='populate-provenance-test-')
sys.argv = [sys.argv[0], '--dry-run', '--skip-api', '--sources-root', _scratch_root]
populate_provenance = _load('populate_provenance', _DIR / 'populate_provenance.py')


def test_social_aggregator_host_is_soft_flagged():
    results = [{'url': 'https://www.linkedin.com/pulse/some-policy-essay'}]
    match = populate_provenance.match_academic_url(results)
    assert match is not None
    assert match['scheme'] == 'url'
    assert match.get('flagged_host') is True


def test_legitimate_academic_host_is_not_flagged():
    results = [{'url': 'https://arxiv.org/abs/2401.12345'}]
    match = populate_provenance.match_academic_url(results)
    assert match is not None
    assert match['scheme'] == 'arxiv'
    assert 'flagged_host' not in match


def test_legitimate_non_academic_host_is_not_flagged():
    # A fallback match (no ACADEMIC_DOMAINS hit) on a host that isn't a social/aggregator
    # host either -- should pass through unflagged, same as before t/4658.
    results = [{'url': 'https://www.example-publisher.com/report'}]
    match = populate_provenance.match_academic_url(results)
    assert match is not None
    assert match['scheme'] == 'url'
    assert 'flagged_host' not in match


def test_is_social_aggregator_host_helper():
    assert populate_provenance.is_social_aggregator_host('https://x.com/some/post') is True
    assert populate_provenance.is_social_aggregator_host('https://medium.com/@author/post') is True
    assert populate_provenance.is_social_aggregator_host('https://arxiv.org/abs/2401.12345') is False


if __name__ == '__main__':
    test_social_aggregator_host_is_soft_flagged()
    test_legitimate_academic_host_is_not_flagged()
    test_legitimate_non_academic_host_is_not_flagged()
    test_is_social_aggregator_host_helper()
    print('All tests passed.')
