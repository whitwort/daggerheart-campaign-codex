import re, json, sys
sys.argv=[sys.argv[0],'cls.txt','/dev/null','/dev/null']
exec(open('/tmp/parse_classes.py').read().split('# split into class blocks')[0])
def region(start, end):
    a=[i for i,l in enumerate(L) if l.strip()==start][0]
    b=[i for i,l in enumerate(L) if l.strip()==end and i>a][0]
    return L[a+1:b]
# ---- beastforms
R=region('BEASTFORM OPTIONS','GUARDIAN')
forms=[]; tier=None; i=0
while i<len(R):
    s=R[i].strip()
    m=re.match(r'^TIER (\d)$',s)
    if m: tier=m.group(1); i+=1; continue
    if caps(s) and i+1<len(R) and R[i+1].strip().startswith('('):
        f={'name':tc(s),'tier':tier,'examples':R[i+1].strip()}
        j=i+2
        if '|' in R[j]:
            tb,ev=[x.strip() for x in R[j].strip().split('|')]; f['trait_bonus']=tb; f['evasion_bonus']=ev; j+=1
        if re.match(r'^(Melee|Very Close|Close|Far|Very Far|Agility|Strength|Finesse|Instinct|Presence|Knowledge) .*\bd\d+',R[j].strip()):
            f['attack']=R[j].strip(); j+=1
        if R[j].strip().startswith('Gain advantage on:'):
            f['advantages']=R[j].strip().split(':',1)[1].strip(); j+=1
        i=j-5
        i+=5; body=[]
        while i<len(R) and not (caps(R[i].strip()) and (re.match(r'^TIER \d$',R[i].strip()) or (i+1<len(R) and R[i+1].strip().startswith('(')))):
            body.append(R[i]); i+=1
        f['feature']=features(body)
        forms.append(f)
    else:
        print('SKIP',repr(s),file=sys.stderr); i+=1
json.dump(forms,open('beastforms2.json','w'),indent=2,ensure_ascii=False)
print(len(forms),[(f['name'],f['tier'],len(f['feature'])) for f in forms])
# ---- stances
R=region('STANCE FEATURES','DRUID')
st=[]; tier=None; buf=[]
def flush():
    for f in features(buf): st.append({'name':f['name'],'tier':tier,'description':f['text']})
for l in R:
    m=re.match(r'^TIER (\d)$',l.strip())
    if m:
        flush(); buf=[]; tier=m.group(1)
    elif l.strip().startswith('The following section'): continue
    else: buf.append(l)
flush()
json.dump(st,open('stances2.json','w'),indent=2,ensure_ascii=False)
print(len(st),[(s['name'],s['tier']) for s in st])
