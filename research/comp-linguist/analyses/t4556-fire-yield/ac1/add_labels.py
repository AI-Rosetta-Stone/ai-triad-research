"""Append one doc's blind labels: python add_labels.py <doc> '<json {id:[label,cluster]}>' '<json {cluster:desc}>'."""
import json, os, sys
p = 'labels.json'
L = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {'labels': {}, 'clusters': {}}
L['labels'].update(json.loads(sys.argv[2])); L['clusters'][sys.argv[1]] = json.loads(sys.argv[3])
json.dump(L, open(p, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print(len(L['labels']), 'labels total')
