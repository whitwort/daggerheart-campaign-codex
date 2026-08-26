import re, json, sys
src, outp, kind = sys.argv[1], sys.argv[2], sys.argv[3]  # kind: ANCESTRY|COMMUNITY
L=[l.strip() for l in open(src).read().replace('\f','\n').split('\n')]
skip=re.compile(r'^(Daggerheart SRD\s+\d+|\d+\s+Daggerheart SRD|ANCESTRIES|COMMUNITIES)$')
recs=[]; cur=None; mode=None
for l in L:
    if not l or skip.match(l): continue
    if re.match(r'^%s FEATURES?$' % kind, l):
        if cur: mode='feat'
        continue
    if re.match(r"^[A-Z][A-Z'’ \-]+$", l):
        cur={'name': l.title().replace("’S","'s").replace("'S","'s"), 'desc':[], 'feature':[]}; recs.append(cur); mode='desc'; continue
    if cur is None: continue
    if mode=='desc': cur['desc'].append(l)
    elif mode=='feat':
        m=re.match(r'^([A-Z][^:]{1,40}):\s+(.*)$', l)
        if m: cur['feature'].append({'name':m.group(1),'text':m.group(2)})
        elif cur['feature']: cur['feature'][-1]['text'] += ' ' + l
        else: cur['desc'].append(l)
out=[]
for r in recs:
    # paragraphs: heuristic same as cards
    body=r['desc']; mx=max((len(b) for b in body),default=0); paras=[]; c=''
    for i,b in enumerate(body):
        nxt=body[i+1] if i+1<len(body) else ''
        c=(c+' '+b).strip() if c else b
        if re.search(r'[.!?)”]$', b) and len(b) < mx-10 and nxt[:1].isupper(): paras.append(c); c=''
    if c: paras.append(c)
    out.append({'name':r['name'],'description':'\n\n'.join(paras),'feature':r['feature']})
json.dump(out,open(outp,'w'),indent=2,ensure_ascii=False)
for o in out: print(o['name'], len(o['feature']), [f['name'] for f in o['feature']], len(o['description']))
