"""t/4471: find key_points whose canonical_proposition dropped a named referent present in verbatim.

Draws a fixed sample of 24 (seed 44711) into elide_sample.json.
Usage:  python elide.py <ai-triad-data>
"""
import json,glob,re,random,os,sys
HERE=os.path.dirname(os.path.abspath(__file__))
D=os.path.join(sys.argv[1],'summaries')
NAME=re.compile(r"\b(?:[A-Z][a-z]+(?:\s+(?:of|the|on|for|and)\s+)?){1,4}(?:Act|Council|Commission|Agency|Court|Administration|Directive|Regulation|Order|Bill|Office|Department|Institute)\b|\b(?:EU|U\.S\.|US|UK|California|New York|Texas|China|FTC|NIST|OECD|DSA|GDPR|Colorado)\b")
out=[]
for f in sorted(glob.glob(D+'/*.json')):
    d=json.load(open(f,encoding='utf-8'))
    for camp,b in (d.get('pov_summaries') or {}).items():
        if not isinstance(b,dict): continue
        for k in b.get('key_points') or []:
            cp=(k.get('canonical_proposition') or '').strip(); nid=k.get('taxonomy_node_id')
            v=k.get('verbatim'); v=' '.join(v) if isinstance(v,list) else (v or '')
            if not cp or not nid: continue
            names={m.group(0).strip() for m in NAME.finditer(v)}
            missing=[n for n in names if n.lower() not in cp.lower()]
            if missing: out.append(dict(doc=d['doc_id'],camp=camp,cat=k.get('category'),node=nid,cp=cp,missing=sorted(missing),vb=v[:350]))
print('candidates',len(out))
random.seed(44711); s=random.sample(out,24)
json.dump(s,open(os.path.join(HERE,'elide_sample.json'),'w',encoding='utf-8'),indent=1,ensure_ascii=False)
for i,x in enumerate(s): print(f"E{i:02d} {x['node']} missing={x['missing']}\n   CP: {x['cp']}\n   VB: {x['vb'][:260]}")
