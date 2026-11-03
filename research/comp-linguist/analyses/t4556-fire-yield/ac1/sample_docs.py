"""t/4556 AC1 sampler: large docs whose saved summary is single_shot + chunked, excluding the
t/4473 and t/4471 sample docs and snapshots over 250k chars (cost/labelling cap, set before any run:
the uncapped draw picked a 870k-char, 37-chunk report costing ~$0.65 alone). Stratified by snapshot length into 3 tertiles, 2 per tertile, seed 4556."""
import json, os, random, glob, subprocess
DATA = 'C:/Users/jsnov/repos/ai-triad-data'; SRC = 'C:/Users/jsnov/repos/ai-triad-sources'
excl = set()
t4473 = json.loads(subprocess.run(['git','-C','C:/Users/jsnov/repos/ai-triad-research','show',
    'origin/cl/t4473-after-measure:research/comp-linguist/analyses/t4473-density/after/sample.json'],
    capture_output=True, text=True, encoding='utf-8').stdout)
excl |= {r['doc'] for r in t4473['sample']}
excl |= {l.split()[-1].split('/')[-1][:-5] for l in subprocess.run(['git','-C',DATA+'/.worktrees/data-t4471','status','--short','summaries'],capture_output=True,text=True).stdout.splitlines() if l.strip()}
pop = []
for p in glob.glob(DATA + '/summaries/*.json'):
    d = os.path.basename(p)[:-5]
    if d in excl: continue
    s = json.load(open(p, encoding='utf-8')); mi = s.get('model_info') or {}
    if mi.get('extraction_mode') != 'single_shot': continue
    if not (mi.get('chunk_count') or 0) > 1: continue
    snap = os.path.join(SRC, d, 'snapshot.md')
    if not os.path.exists(snap): continue
    if os.path.getsize(snap) > 250_000: continue
    pop.append(dict(doc=d, chars=os.path.getsize(snap), chunk_count=mi.get('chunk_count'),
                    saved_model=mi.get('model'), saved_kp=sum(len((b or {}).get('key_points') or []) for b in (s.get('pov_summaries') or {}).values() if isinstance(b, dict))))
pop.sort(key=lambda r: r['chars'])
rng = random.Random(4556); n = len(pop); sample = []
for t in range(3):
    band = pop[t*n//3:(t+1)*n//3]
    sample += [dict(r, tertile=t) for r in rng.sample(band, 2)]
json.dump(dict(population=n, excluded=len(excl), seed=4556, sample=sample), open('sample.json','w',encoding='utf-8'), indent=1)
print('population', n, 'excluded', len(excl))
for r in sample: print(r)
