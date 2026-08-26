import re, json, sys
sys.argv=[sys.argv[0],'trans.txt','/dev/null','/dev/null']
exec(open('/tmp/parse_classes.py').read().split('# split into class blocks')[0])
a=[i for i,l in enumerate(L) if l.strip()=='GRANTING TRANSFORMATIONS'][0]
R=L[a+1:]
recs=[]; cur=None; sec=None
for l in R:
    s=l.strip()
    if s in ('TRANSFORMATION FEATURES','TRANSFORMATION QUESTIONS'): sec=s; continue
    if caps(s) and sec is None or (caps(s) and sec=='TRANSFORMATION QUESTIONS'):
        cur={'name':tc(s),'_d':[],'_f':[],'_q':[]}; recs.append(cur); sec=None; continue
    if cur is None: continue
    {None:cur['_d'],'TRANSFORMATION FEATURES':cur['_f'],'TRANSFORMATION QUESTIONS':cur['_q']}[sec].append(l)
out=[{'name':r['name'],'description':paras(r['_d']),'feature':features(r['_f']),'question':bullets(r['_q'])} for r in recs]
json.dump(out,open('transformations2.json','w'),indent=2,ensure_ascii=False)
for o in out: print(o['name'],[f['name'] for f in o['feature']],len(o['question']),len(o['description']))
print(json.dumps(out[-1],indent=1,ensure_ascii=False)[:1500])
