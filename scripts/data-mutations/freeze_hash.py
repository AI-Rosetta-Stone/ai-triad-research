# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

"""Checkout-independent file hashes for data-mutation freezes (t/247).

A freeze that hashes working-tree bytes records CRLF on a Windows checkout with core.autocrlf=true
and LF elsewhere, so the same committed file verifies on one machine and false-mismatches on
another (t/217: 19 of 29 blobs). Hash the canonical form instead: the bytes with every CRLF turned
into LF. That equals what git stores for these text files and is the same on every checkout.

Record HASH_BASIS in the frozen file as `hash_basis`, and verify with the same basis.
FreezeHash.ps1 is the PowerShell twin; both assert the same pinned vectors.
"""

import hashlib
from pathlib import Path

HASH_BASIS = "sha256-lf"


def canonical_bytes(data: bytes) -> bytes:
    """CRLF -> LF. A lone CR is content and is kept; nothing else changes (a BOM stays)."""
    return data.replace(b"\r\n", b"\n")


def freeze_sha256(data_or_path) -> str:
    """sha256 hex of the canonical bytes of a bytes object or a file path."""
    data = data_or_path if isinstance(data_or_path, (bytes, bytearray)) else Path(data_or_path).read_bytes()
    return hashlib.sha256(canonical_bytes(bytes(data))).hexdigest()


def verify_freeze_sha256(data_or_path, expected: str, basis: str) -> bool:
    """True when the hash matches. Refuses an unknown basis instead of guessing (t/247)."""
    if basis != HASH_BASIS:
        raise ValueError(f"unsupported hash_basis {basis!r}; this helper verifies {HASH_BASIS!r} only")
    return freeze_sha256(data_or_path) == expected
