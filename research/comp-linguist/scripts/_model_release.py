"""Keep trained model weights out of both git repos (t/4154).

Model weights are too large for git: the claim matcher was 90.9 MB, 9 MB under GitHub's 100 MB push limit.
Training scripts therefore write to a gitignored local folder (`LOCAL_MODEL_ROOT`). After training,
`report_release_steps` writes a draft `weights.json` manifest next to each weights file and prints the steps
that publish the weights as a GitHub release asset on ai-triad-data. Nothing here touches either repo; a
person runs the printed commands.

The published layout is the one t/4154 set up for the claim matcher: small config and tokenizer files in
ai-triad-data/research-artifacts/comp-linguist/<name>/best_model/, the weights in a release, and a
weights.json manifest recording the release tag, sha256 and size.
"""
import hashlib
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
RESEARCH_DIR = SCRIPT_DIR.parent

# research/**/fine_tuned_model/ is gitignored in the code repo (.gitignore, two-repo policy).
LOCAL_MODEL_ROOT = RESEARCH_DIR / "fine_tuned_model"

DATA_REPO = "AI-Rosetta-Stone/ai-triad-data"
WEIGHT_SUFFIXES = (".safetensors", ".bin", ".pt", ".onnx")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def report_release_steps(model_dir: Path, artifact_name: str, release_tag: str) -> None:
    """Write weights.json drafts next to each weights file in `model_dir` and print the publish steps.

    `artifact_name` is the folder under research-artifacts/comp-linguist/ (e.g. "fine_tuned_model").
    `release_tag` is the release to create on ai-triad-data (e.g. "comp-linguist-claim-matcher-v2").
    """
    weights = sorted(p for p in model_dir.rglob("*") if p.is_file() and p.suffix in WEIGHT_SUFFIXES)
    if not weights:
        print(f"WARN: no weights file ({', '.join(WEIGHT_SUFFIXES)}) found under {model_dir}; "
              "nothing to publish", file=sys.stderr)
        return

    dest = f"research-artifacts/comp-linguist/{artifact_name}/{model_dir.name}"
    print("\n" + "=" * 60, file=sys.stderr)
    print("PUBLISH STEPS (t/4154): weights go to a release, not git", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    for w in weights:
        manifest = {
            "_comment": f"{w.name} is not stored in git (t/4154). Download it from the release below "
                        "and place it next to this file. Verify the sha256 before use.",
            "file": w.name,
            "repo": DATA_REPO,
            "release_tag": release_tag,
            "asset": w.name,
            "bytes": w.stat().st_size,
            "sha256": _sha256(w),
            "download": f"gh release download {release_tag} -R {DATA_REPO} -p {w.name} -D {dest}",
        }
        manifest_path = w.parent / "weights.json"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"  {w.name}: {manifest['bytes']:,} bytes, sha256 {manifest['sha256']}", file=sys.stderr)
        print(f"  draft manifest: {manifest_path}", file=sys.stderr)

    files = " ".join(f'"{w}"' for w in weights)
    print("\n  1. Create the release and upload the weights:", file=sys.stderr)
    print(f'     gh release create {release_tag} -R {DATA_REPO} --title "{release_tag}" '
          f'--notes "sha256 in weights.json" {files}', file=sys.stderr)
    print(f"  2. Copy everything else in {model_dir} (config, tokenizer, weights.json) to "
          f"ai-triad-data/{dest}/, but NOT the weights files.", file=sys.stderr)
    print("  3. Commit those small files in ai-triad-data (/data-mutation if it replaces a published model).",
          file=sys.stderr)
