import json, glob, os, collections, statistics, math

REPO_DATA = "C:/Users/jsnov/repos/ai-triad-data"
BASELINE_GLOB = os.path.join(REPO_DATA, "debates", "debate-*.json")   # 120-corpus lives here
PILOT_GLOB    = os.path.join(REPO_DATA, "debates", "t3790-pilot", "t3790p*-debate.json")

# frozen pilot cell
CELL = dict(model="gemini-3.5-flash-lite", protocol="structured",
            pacing="moderate", audience="policymakers", povs=3)

def pacing_of(d):
    # pacing lives at .adaptive_staging.pacing (per baseline scan); fall back to top-level
    ast = d.get("adaptive_staging")
    if isinstance(ast, dict) and ast.get("pacing"): return ast["pacing"]
    return d.get("pacing")

def config_of(d):
    return dict(model=d.get("debate_model"), protocol=d.get("protocol_id"),
                pacing=pacing_of(d), audience=d.get("audience"),
                povs=len(d.get("active_povers") or []))

def matches_cell(d):
    c = config_of(d)
    return (c["model"]==CELL["model"] and c["protocol"]==CELL["protocol"]
            and c["pacing"]==CELL["pacing"] and c["audience"]==CELL["audience"]
            and c["povs"]==CELL["povs"])

def turn_of(n):
    try: return int(n.get("turn_number"))
    except: return None

def measure(files, label, require_cell=False):
    n_debates=0; n_cell=0; n_edges=0
    steel_nodes=0; later_inbound=[]; any_later=0; adopt_nodes=0
    type_counter=collections.Counter()
    src_camp=collections.Counter()      # later-inbound source camp rel. to steelman
    for p in files:
        try: d=json.load(open(p,encoding="utf-8"))
        except: continue
        n_debates+=1
        if require_cell and not matches_cell(d): continue
        n_cell+=1
        an=d.get("argument_network")
        if not isinstance(an,dict): continue
        nodes=an.get("nodes") or []; edges=an.get("edges") or []
        if not nodes: continue
        byid={x.get("id"):x for x in nodes if isinstance(x,dict)}
        steel={x.get("id"):x for x in nodes if isinstance(x,dict) and x.get("steelman_of")}
        for e in edges:
            if not isinstance(e,dict): continue
            tgt=e.get("target")
            if tgt not in steel: continue
            sn=byid.get(e.get("source")); stn=steel[tgt]
            st=turn_of(sn) if sn else None; tt=turn_of(stn)
            if st is None or tt is None or st<=tt: continue
            type_counter[e.get("type")]+=1
            so=stn.get("steelman_of"); au=stn.get("speaker"); ss=sn.get("speaker") if sn else None
            if ss==so: src_camp["steelmanned_camp"]+=1
            elif ss==au: src_camp["author_camp"]+=1
            else: src_camp["third_camp"]+=1
        n_edges+=sum(1 for e in edges if isinstance(e,dict))
        for nid,nn in steel.items():
            steel_nodes+=1; tt=turn_of(nn); cnt=0; own=0
            for e in edges:
                if isinstance(e,dict) and e.get("target")==nid:
                    sn=byid.get(e.get("source")); st=turn_of(sn) if sn else None
                    if st is not None and tt is not None and st>tt:
                        cnt+=1
                        if sn and sn.get("speaker")==nn.get("steelman_of"): own+=1
            later_inbound.append(cnt)
            if cnt>0: any_later+=1
            # Confirmatory primary (pre-reg, t/3790): per-node binary, >=1 later inbound from the
            # node's OWN steelmanned camp. Same predicate as the src_camp tally above.
            if own>0: adopt_nodes+=1
    print(f"=== {label} ===")
    print(f"  debates scanned: {n_debates}" + (f" | matched cell: {n_cell}" if require_cell else ""))
    print(f"  steelman nodes (n): {steel_nodes}")
    if steel_nodes:
        conn=any_later/len(later_inbound)
        print(f"  CONNECTION rate (>=1 later inbound): {any_later}/{len(later_inbound)} ({conn:.0%})")
        print(f"  later inbound per node: mean {statistics.mean(later_inbound):.2f} median {statistics.median(later_inbound)} max {max(later_inbound)}")
        tot=sum(src_camp.values())
        print(f"  later inbound edge types: {dict(type_counter)}")
        print(f"  source camp of later inbound: {dict(src_camp)} (total {tot})")
        if tot:
            adopt=src_camp['steelmanned_camp']/tot
            print(f"  ADOPTION (steelmanned-camp share of later inbound): {src_camp['steelmanned_camp']}/{tot} ({adopt:.0%})")
    return dict(steel=steel_nodes, conn_num=any_later, conn_den=len(later_inbound),
                src=dict(src_camp), types=dict(type_counter),
                adopt_nodes=adopt_nodes, n_cell=n_cell, n_edges=n_edges)

def wilson(k,n,z=1.96):
    if n==0: return (0,0)
    p=k/n; d=1+z*z/n
    c=(p+z*z/(2*n))/d; h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return (max(0,c-h),min(1,c+h))

if __name__ == "__main__":  # the pilot read (t/3790); importable for the confirmatory arm
  base_files=sorted(glob.glob(BASELINE_GLOB), key=os.path.getmtime, reverse=True)[:120]
  pilot_files=sorted(glob.glob(PILOT_GLOB))

  b=measure(base_files, "MATCHED BASELINE SUBSET (120-corpus filtered to pilot cell)", require_cell=True)
  print()
  p=measure(pilot_files, "PILOT (10 debates, post-fix)", require_cell=False)
  print()
  print("=== COMPARISON ===")
  for m,lbl in [(b,"baseline-matched"),(p,"pilot")]:
    if m['conn_den']:
        lo,hi=wilson(m['conn_num'],m['conn_den'])
        st=sum(m['src'].values()); sc=m['src'].get('steelmanned_camp',0)
        alo,ahi=wilson(sc,st) if st else (0,0)
        print(f"{lbl}: n={m['steel']} | connection {m['conn_num']}/{m['conn_den']}={m['conn_num']/m['conn_den']:.0%} [95% {lo:.0%}-{hi:.0%}] "
              f"| adoption {sc}/{st}" + (f"={sc/st:.0%} [95% {alo:.0%}-{ahi:.0%}]" if st else "=n/a"))
