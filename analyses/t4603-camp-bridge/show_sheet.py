"""Print the blind sheet for labelling, with a verbatim-in-snapshot check.
The key is used only to find the item's snapshot; arm and doc tag are never printed."""
import json, re, sys
SRC = sys.argv[1]
sheet = json.load(open('label_sheet.json', encoding='utf-8'))
key = json.load(open('label_key.json', encoding='utf-8'))
flat = lambda t: ' '.join(map(str, t)) if isinstance(t, list) else (t or '')  # verbatim is a str or a list of spans
norm = lambda t: re.sub(r'\W+', ' ', flat(t).lower()).strip()
snaps = {}
lo, hi = int(sys.argv[2]), int(sys.argv[3])
for it in sheet[lo:hi]:
    d = key[it['id']]['doc']
    if d not in snaps:
        snaps[d] = norm(open(f'{SRC}/{d}/snapshot.md', encoding='utf-8', errors='replace').read())
    v = norm(it['verbatim'])
    found = 'Y' if v and v[:120] in snaps[d] else ('partial' if v and v[:40] in snaps[d] else 'N')
    print(f"{it['id']} [{it['camp'][:3]}] node={it['node']} ({it['node_label']})\n  P: {it['point']}\n  V[{found}]: {flat(it['verbatim'])[:260]}\n")
