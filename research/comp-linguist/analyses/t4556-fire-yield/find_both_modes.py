import subprocess,json,collections,sys
R="C:/Users/jsnov/repos/ai-triad-data"
log=subprocess.run(["git","-C",R,"log","--format=%H %ad","--date=short","origin/main","--","summaries"],capture_output=True,text=True).stdout.split("\n")
commits=[l.split() for l in log if l.strip()]
print("commits",len(commits),file=sys.stderr)
blobs=collections.defaultdict(dict)  # file -> blob -> date
for h,d in commits:
    t=subprocess.run(["git","-C",R,"ls-tree",h,"summaries/"],capture_output=True,text=True).stdout
    for l in t.split("\n"):
        if not l.endswith(".json"): continue
        meta,path=l.split("\t"); b=meta.split()[2]
        blobs[path].setdefault(b,d)
multi={p:v for p,v in blobs.items() if len(v)>1}
print("files",len(blobs),"multi-version",len(multi),file=sys.stderr)
allb=[b for v in multi.values() for b in v]
inp="\n".join(allb)+"\n"
out=subprocess.run(["git","-C",R,"cat-file","--batch"],input=inp.encode(),capture_output=True).stdout
info={};i=0
while i<len(out):
    nl=out.index(b"\n",i); hdr=out[i:nl].split(); size=int(hdr[2]); body=out[nl+1:nl+1+size]; i=nl+1+size+1
    try: s=json.loads(body)
    except Exception: continue
    mi=s.get("model_info") or {}
    n=sum(len((b or {}).get("key_points") or []) for b in (s.get("pov_summaries") or {}).values() if isinstance(b,dict))
    info[hdr[0].decode()]=(mi.get("extraction_mode") or s.get("extraction_mode"),n,len(s.get("factual_claims") or []),mi.get("model"))
res=[]
for p,v in multi.items():
    modes={info[b][0] for b in v if b in info}
    if "fire" in modes and "single_shot" in modes:
        res.append((p,[(d,)+info[b] for b,d in v.items() if b in info]))
json.dump(res,open(sys.argv[1],"w"),indent=1)
print("docs with both modes:",len(res),file=sys.stderr)
for p,vs in res[:40]: print(p.split('/')[-1][:55], sorted(vs))
