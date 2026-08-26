import re, json, sys
CLASSES=['ASSASSIN','BARD','BRAWLER','DRUID','GUARDIAN','RANGER','ROGUE','SERAPH','SORCERER','WARLOCK','WARRIOR','WITCH','WIZARD']
raw=open(sys.argv[1],encoding='utf-8').read().replace('\f','\n').split('\n')
skip=re.compile(r'^(Daggerheart SRD\s+\d+|\d+\s+Daggerheart SRD)$')
L=[]
for l in raw:
    s=l.rstrip()
    if not s.strip() or skip.match(s.strip()): continue
    L.append(s)
def caps(s): return re.match(r"^[A-Z][A-Z’' \-&:0-9]+$", s.strip()) is not None
def tc(s):
    s=s.replace('’',"'")
    w=[]
    for i,x in enumerate(s.split(' ')):
        y=x[:1].upper()+x[1:].lower()
        if i and y.lower() in ('of','the','and','a','an'): y=y.lower()
        w.append(y)
    return ' '.join(w)
def paras(lines):
    """join wrapped lines into paragraphs; bullets -> '- ' (bullet continues
    while following lines are indented deeper than the bullet marker)."""
    out=[]; cur=''; bind=None
    ind=[len(x)-len(x.lstrip()) for x in lines]
    stripped=[x.strip() for x in lines]
    mx=max((len(x) for x in stripped),default=0)
    def glue(a,b): return a+b if a.endswith('\u2014') else a+' '+b
    for i,b in enumerate(stripped):
        nxt=stripped[i+1] if i+1<len(stripped) else ''
        nind=ind[i+1] if i+1<len(stripped) else -1
        if b[:1] in '\u25e6\u2022':
            if cur: out.append(cur)
            cur='- '+b[1:].strip(); bind=ind[i]
            if nind<=bind or nxt[:1] in '\u25e6\u2022': out.append(cur); cur=''; bind=None
        elif bind is not None:
            cur=glue(cur,b)
            if nind<=bind or nxt[:1] in '\u25e6\u2022': out.append(cur); cur=''; bind=None
        elif b.startswith('Note:'):
            if cur: out.append(cur)
            cur='*'+b
            if re.search(r'[.!?)]$',b): out.append(cur+'*'); cur=''
        elif cur.startswith('*Note:'):
            cur=glue(cur,b)
            if re.search(r'[.!?)]$',b): out.append(cur+'*'); cur=''
        else:
            cur=glue(cur,b) if cur else b
            if re.search(r'[.!?)\u201d]$',b) and len(b)<mx-10 and (nxt[:1].isupper() or nxt[:1] in '\u25e6\u2022'):
                out.append(cur); cur=''
    if cur: out.append(cur)
    txt=''
    for i,p in enumerate(out):
        if i==0: txt=p
        elif p.startswith('- ') and out[i-1].startswith('- '): txt+='\n'+p
        else: txt+='\n\n'+p
    return txt.replace('\u2212','-').replace('\u2011','-').replace('\u00ad','').replace('\uf0e0','\u2192')
FEAT=re.compile(r"^([A-Z][A-Za-z’'\-& ]{1,40}):\s+(.*)$")
def features(lines):
    fs=[]; buf=[]
    FEAT2=re.compile(r"^([A-Z][A-Za-z\u2019'\- ]{1,30})\. ([A-Z].*)$")
    for li,l in enumerate(lines):
        s=l.strip(); m=FEAT.match(s)
        if not m and li==0: m=FEAT2.match(s)
        if m and not s.startswith('Note:'):
            if fs: fs[-1]['_lines']=buf
            fs.append({'name':m.group(1).replace('’',"'"),'_lines':None}); buf=[m.group(2)]
        else: buf.append(l)
    if fs: fs[-1]['_lines']=buf
    return [{'name':f['name'],'text':paras(f['_lines'])} for f in fs]
def bullets(lines):
    return [{'question':q[2:]} for q in paras(lines).split('\n') if q.startswith('- ')]
# split into class blocks
idx=[i for i,l in enumerate(L) if l.strip() in CLASSES and i+1<len(L) and not caps(L[i+1])]
# guard: class heading must be followed by description then DOMAINS line within 30 lines
idx=[i for i in idx if any(L[j].strip().startswith('DOMAINS –') for j in range(i,min(i+30,len(L))))]
assert len(idx)==13, [L[i] for i in idx]
classes=[]; subclasses=[]; extras={}
for n,i in enumerate(idx):
    block=L[i+1: idx[n+1] if n+1<len(idx) else len(L)]
    name=tc(L[i].strip())
    # sectionize on caps headings
    secs=[]; cur=('_desc',[])
    for l in block:
        if caps(l) and not re.match(r'^(STEP \d|TIER \d)',l.strip()):
            secs.append(cur); cur=(l.strip(),[])
        else: cur[1].append(l)
    secs.append(cur)
    rec={'name':name}
    desc=[]; 
    for l in secs[0][1]:
        s=l.strip()
        m=re.match(r'^(DOMAINS|STARTING EVASION|STARTING HIT POINTS|CLASS ITEMS) – (.*)$',s)
        if m:
            k,v=m.groups(); rec['_'+k]=[v]; last=k
        elif '_DOMAINS' in rec: rec['_'+last].append(s)
        else: desc.append(s)
    rec['description']=paras(desc)
    d1,d2=[x.strip() for x in rec['_DOMAINS'][0].split('&')]
    rec['domain_1'],rec['domain_2']=d1,d2
    rec['evasion']=rec['_STARTING EVASION'][0]; rec['hp']=rec['_STARTING HIT POINTS'][0]
    rec['items']=' '.join(rec['_CLASS ITEMS'])
    for k in [k for k in rec if k.startswith('_')]: del rec[k]
    rec['feature']=[]; rec['background']=[]; rec['connection']=[]
    subnames=[]; cur_sub=None
    for h,body in secs[1:]:
        if h.endswith('HOPE FEATURE'):
            f=features(body); assert len(f)==1,(name,h,f); rec['hope_feature_name']=f[0]['name']; rec['hope_feature_text']=f[0]['text']
        elif h=='CLASS FEATURES' or h=='CLASS FEATURE': rec['feature']+=features(body)
        elif h.endswith('SUBCLASSES'):
            m=re.search(r'Choose either the (.+?) or (?:the )?(.+?) subclass', ' '.join(x.strip() for x in body)); assert m,(name,body)
            subnames=[m.group(1),m.group(2)]; rec['subclass_1'],rec['subclass_2']=subnames
        elif tc(h) in subnames:
            cur_sub={'name':tc(h),'description':paras(body),'foundation':[],'specialization':[],'mastery':[]}; subclasses.append(cur_sub)
        elif h=='SPELLCAST TRAIT': cur_sub['spellcast_trait']=' '.join(x.strip() for x in body)
        elif re.match(r'^(FOUNDATION|SPECIALIZATION|MASTERY) FEATURES?$',h): cur_sub[h.split()[0].lower()]+=features(body)
        elif h=='BACKGROUND QUESTIONS': rec['background']=bullets(body)
        elif h=='CONNECTIONS': rec['connection']=bullets(body)
        else: extras.setdefault(name,[]).append((h,len(body)))
    for k in ['suggested_traits','suggested_armor','suggested_primary','suggested_secondary']: rec[k]=''
    classes.append(rec)
json.dump(classes,open(sys.argv[2],'w'),indent=2,ensure_ascii=False)
json.dump(subclasses,open(sys.argv[3],'w'),indent=2,ensure_ascii=False)
for c in classes: print(c['name'],c['domain_1'],c['domain_2'],c['evasion'],c['hp'],[f['name'] for f in c['feature']],c.get('hope_feature_name'),c.get('subclass_1'),c.get('subclass_2'),len(c['background']),len(c['connection']))
for s in subclasses: print('  ',s['name'],s.get('spellcast_trait'),[len(s[k]) for k in ('foundation','specialization','mastery')])
print('EXTRAS',json.dumps(extras,indent=1))

# --- hand patches for layout artifacts -----------------------------------
for c in classes:
    if c['name']=='Guardian':
        tip=[f for f in c['feature'] if f['name']=='Tip']
        if tip:
            c['feature']=[f for f in c['feature'] if f['name']!='Tip']
            c['feature'][0]['text']+='\n\n*Tip: '+tip[0]['text']+'*'
    if c['name']=='Witch':
        f=[f for f in c['feature'] if f['name']=='Commune'][0]
        f['text']=f['text'].split(' Roll   Effect')[0]+'\n\n| Roll | Effect |\n|---|---|\n| 1–3 | You taste a flavor, smell a scent, or feel a sensation relevant to the answer. |\n| 4–5 | You hear sounds or see a vision relevant to the answer. |\n| 6 | You psychically experience a scene relevant to the answer as if you were there. |'
json.dump(classes,open(sys.argv[2],'w'),indent=2,ensure_ascii=False)
