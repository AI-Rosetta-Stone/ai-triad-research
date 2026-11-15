#!/usr/bin/env python3

# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""Tests for scripts/data-mutations/freeze_hash.py (t/247). Runnable under pytest or standalone.

The vectors are pinned here and in tests/FreezeHash.Tests.ps1, so the Python and PowerShell
helpers can't drift apart. The regression test freezes one committed doc from a CRLF checkout and
from an LF checkout and requires the same hash, which equals the committed blob's.
"""

import importlib.util
import shutil
import subprocess
import tempfile
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "freeze_hash", Path(__file__).resolve().parent / "data-mutations" / "freeze_hash.py")
fh = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(fh)

VECTORS = {
    "crlf": (b'{\r\n  "a": 1\r\n}\r\n', "5e36b6560513586ced65eca0e8b025fe88edbcab82ba2cb67a5fcb2d7b202383"),
    "lf": (b'{\n  "a": 1\n}\n', "5e36b6560513586ced65eca0e8b025fe88edbcab82ba2cb67a5fcb2d7b202383"),
    "lone-cr": (b"a\rb\r\n", "367d1c77eadc1495a7db4200f46a8b90ea1fa926282722d308c05a65098a4112"),
    "bom": (b"\xef\xbb\xbfx\r\n", "dc79faf9efbee8e42b42346da7a977c74a27581ae8f3465f431176f43e521415"),
    "empty": (b"", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
}


def test_pinned_vectors():
    for name, (data, expected) in VECTORS.items():
        assert fh.freeze_sha256(data) == expected, name


def test_crlf_and_lf_forms_hash_the_same_and_raw_sha256_does_not():
    import hashlib
    crlf, lf = VECTORS["crlf"][0], VECTORS["lf"][0]
    assert fh.freeze_sha256(crlf) == fh.freeze_sha256(lf)
    assert hashlib.sha256(crlf).hexdigest() != hashlib.sha256(lf).hexdigest()  # the t/217 trap


def test_verify_refuses_an_unknown_basis():
    try:
        fh.verify_freeze_sha256(b"x", fh.freeze_sha256(b"x"), "sha256-raw")
    except ValueError as exc:
        assert "sha256-lf" in str(exc)
        return
    raise AssertionError("expected ValueError for an unknown hash_basis")


def _git(cwd, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd,
                          check=True, capture_output=True).stdout


def test_one_doc_frozen_from_a_crlf_and_an_lf_checkout_gives_one_hash():
    """t/247 regression: core.autocrlf=true writes CRLF, false writes LF; the freeze hash of both
    working copies equals the freeze hash (and the raw sha256) of the committed LF blob."""
    if not shutil.which("git"):
        import pytest
        pytest.skip("git not available")
    with tempfile.TemporaryDirectory() as tmp:
        origin = Path(tmp) / "origin"
        origin.mkdir()
        _git(origin, "init", "-q")
        (origin / ".gitattributes").write_text("*.json text\n", encoding="utf-8")
        (origin / "metadata.json").write_bytes(VECTORS["lf"][0])
        _git(origin, "add", ".")
        _git(origin, "commit", "-q", "-m", "seed")
        blob = _git(origin, "show", "HEAD:metadata.json")
        hashes = {}
        # A Windows checkout with autocrlf=true writes CRLF; eol=lf is what a Linux checkout writes.
        for key, cfg in (("true", ["-c", "core.autocrlf=true"]), ("false", ["-c", "core.autocrlf=false", "-c", "core.eol=lf"])):
            clone = Path(tmp) / f"clone-{key}"
            _git(tmp, *cfg, "clone", "-q", str(origin), str(clone))
            hashes[key] = (clone / "metadata.json").read_bytes()
        assert b"\r\n" in hashes["true"] and b"\r\n" not in hashes["false"], "the checkouts must differ in bytes"
        assert fh.freeze_sha256(hashes["true"]) == fh.freeze_sha256(hashes["false"]) == fh.freeze_sha256(blob)
        import hashlib
        assert fh.freeze_sha256(blob) == hashlib.sha256(blob).hexdigest(), "the basis equals the committed blob"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
