"""t/4880: build judge inputs for a label sheet (default: the t/4742 sheet, 88 items).

Reads the sheet and the live taxonomy node descriptions. Writes items.json with the
rendered prompt per item. The reference labels are NOT included here; score.py joins them.
Usage: python build_items.py <prompt.md> <out.json> [sheet.json]
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TAX = os.environ.get('AI_TRIAD_TAXONOMY_DIR', r'C:\Users\jsnov\repos\ai-triad-data\taxonomy\Origin')
SPAN_CHARS = 600

prompt_path, out_path = sys.argv[1], sys.argv[2]
with open(prompt_path, encoding='utf-8') as f:
    template = f.read()

nodes = {}
for name in ('accelerationist.json', 'safetyist.json', 'skeptic.json', 'situations.json'):
    with open(os.path.join(TAX, name), encoding='utf-8') as f:
        d = json.load(f)
    for n in (d['nodes'] if isinstance(d, dict) else d):
        nodes[n['id']] = (n.get('label') or '', n.get('description') or '')

sheet_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, '..', 'label_sheet.json')
with open(sheet_path, encoding='utf-8') as f:
    sheet = json.load(f)

flat = lambda t: ' '.join(map(str, t)) if isinstance(t, list) else (t or '')
items = []
for it in sheet:
    label, desc = nodes.get(it['node'], (it.get('node_label') or 'none', '(no node: judge against the camp alone)'))
    values = {
        'camp': it['camp'], 'node_label': label, 'node_description': desc,
        'point': it['point'], 'verbatim': flat(it['verbatim'])[:SPAN_CHARS],
    }
    prompt = template
    for k, v in values.items():
        prompt = prompt.replace('{{' + k + '}}', v)
    assert '{{' not in prompt, f"unrendered placeholder in {it['id']}"
    items.append({'id': it['id'], 'prompt': prompt})

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(items, f, ensure_ascii=False, indent=1)
print(f'{len(items)} items -> {out_path}')
