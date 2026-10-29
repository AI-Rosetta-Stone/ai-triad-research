"""t/4278 C6 check (TL, t/4278#10): no survivor is itself superseded, and no
`superseded_by` target is itself superseded -- i.e. the supersession graph has
no chains, only direct node -> survivor edges.

Reads ONLY frozen_list.json (never re-derives groups). Checks the MECHANICAL
set (each group's `retire_mechanical` list against its `survivor`); items in
`totals.held_editorial` are excluded on purpose -- they are not yet assigned
a survivor by this list; the PI's editorial pass covers them separately, and
a re-run of this check against that outcome applies before that write too.

Exit 0 and prints "C6 PASS" if the mechanical set has no chains. Exit 2 with
a REFUSE line naming the violation otherwise.

Usage:
    python check_c6_no_chains.py <frozen_list.json path>
"""
import json
import sys


def fail(msg):
    print(f"REFUSE: {msg}")
    sys.exit(2)


def main():
    if not sys.argv[1:]:
        print(__doc__)
        sys.exit(1)
    frozen = json.load(open(sys.argv[1], encoding="utf-8"))

    survivors = {}   # retired_id -> survivor_id
    all_survivors = set()
    all_retired = set()

    for g in frozen["groups"]:
        survivor = g["survivor"]
        all_survivors.add(survivor)
        for retired in g.get("retire_mechanical", []):
            if retired in survivors:
                fail(f"{retired} appears in retire_mechanical for more than one group "
                     f"(already mapped to {survivors[retired]!r}, now also {survivor!r})")
            survivors[retired] = survivor
            all_retired.add(retired)

    # C6a: no survivor is itself in the retired set (would make it superseded).
    chained_survivors = all_survivors & all_retired
    if chained_survivors:
        fail(f"{len(chained_survivors)} node(s) are BOTH a survivor and retired "
             f"elsewhere -- would create a supersession chain: {sorted(chained_survivors)}")

    # C6b: every retired node's designated survivor is not itself retired
    # (same invariant, checked directly per-edge for a clearer failure message).
    for retired, survivor in survivors.items():
        if survivor in all_retired:
            fail(f"{retired} -> {survivor}, but {survivor} is ALSO retired "
                 f"(into {survivors[survivor]!r}) -- chain, not a direct edge")

    held = frozen.get("totals", {}).get("held_editorial", [])
    print(f"C6 PASS: {len(survivors)} mechanical retire->survivor edges, 0 chains.")
    print(f"  survivors: {sorted(all_survivors)}")
    print(f"  retired:   {sorted(all_retired)}")
    print(f"  held_editorial (excluded from this check, PI pass pending): {held}")


if __name__ == "__main__":
    main()
