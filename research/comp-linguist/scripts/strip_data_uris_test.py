"""Tests for build_training_corpus.strip_data_uris (t/4385): base64 never becomes a training passage.

Run: python research/comp-linguist/scripts/strip_data_uris_test.py   (or under pytest)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_training_corpus import strip_data_uris  # noqa: E402


def test_markdown_image_and_bare_uri_removed_prose_kept():
    text = ("Intro text.\n\n![](data:image/png;base64," + "A" * 18000 + "==)\n\n"
            "Real prose data:text/plain;base64,QUJD after it.\n")
    out, removed = strip_data_uris(text)
    assert "base64" not in out
    assert "Intro text." in out and "Real prose" in out and "after it." in out
    assert removed == len(text) - len(out) > 18000


def test_bare_uri_stops_at_whitespace():
    out, _ = strip_data_uris("a data:image/svg+xml;base64,PHN2Zz4= b c")
    assert out == "a  b c"


def test_no_data_uri_is_unchanged():
    text = "Plain text with a link [x](https://example.org) and no images."
    assert strip_data_uris(text) == (text, 0)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("ok")
