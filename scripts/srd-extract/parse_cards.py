import re, json, sys
lines = open(sys.argv[1], encoding='utf-8').read().replace('\f','\n').split('\n')
SMALL = {'of','the','a','an','and','to','in','for','on','with','or','by'}
def title(s):
    s = s.replace('\u2011','-').replace('’',"'")
    words = s.split(' ')
    out=[]
    for i,w in enumerate(words):
        parts = w.split('-')
        parts = [p[:1].upper()+p[1:].lower() for p in parts]
        w2 = '-'.join(parts)
        if i>0 and w2.lower() in SMALL: w2 = w2.lower()
        out.append(w2)
    return ' '.join(out)
skip = re.compile(r'^(Daggerheart SRD\s+\d+|This section contains additional information and re|sheets, visit daggerheart.com/downloads.|\d+\s+Daggerheart SRD|APPENDIX|This section contains|sheets, visit|Domain Card referen|ference material\. For additional reference|ce)$')
lvl = re.compile(r'^Level (\d+) (\w+) (Spell|Ability|Grimoire)$')
L = [l.strip() for l in lines]
L = [l for l in L if l and not skip.match(l)]
cards=[]; domain=None; i=0
while i < len(L):
    l = L[i]
    m = re.match(r'^(\w+) DOMAIN$', l)
    if m: domain = title(m.group(1)); i+=1; continue
    if i+1 < len(L) and lvl.match(L[i+1]):
        name = l.lstrip('-—– '); m2 = lvl.match(L[i+1]); level, dom, typ = m2.groups()
        domain = title(dom)
        rc = re.match(r'^Recall Cost: (\d+)$', L[i+2]); assert rc, (name, L[i+2])
        i += 3; body=[]
        while i < len(L) and not (i+1 < len(L) and lvl.match(L[i+1])) and not re.match(r'^(\w+) DOMAIN$', L[i]):
            body.append(L[i]); i+=1
        # assemble text: paragraphs list; bullets are entries starting '- '
        paras=[]; cur=''
        mx = max((len(b) for b in body), default=0)
        for bi,b in enumerate(body):
            nxt = body[bi+1] if bi+1 < len(body) else ''
            if b.startswith('◦') or b.startswith('•'):
                if cur: paras.append(cur)
                cur = '- ' + b[1:].strip()
                if re.search(r'[.!?)]$', b): paras.append(cur); cur=''
            elif cur.startswith('- '):
                cur += ' ' + b
                if re.search(r'[.!?)]$', b): paras.append(cur); cur=''
            else:
                cur = (cur + ' ' + b).strip() if cur else b
                if re.search(r'[.!?)]$', b) and len(b) < mx-10 and (nxt[:1].isupper() or nxt[:1] in '◦•'):
                    paras.append(cur); cur=''
        if cur: paras.append(cur)
        # join: bullets adjacent to bullets with single newline
        text=''
        for pi,p in enumerate(paras):
            if pi==0: text=p
            elif p.startswith('- ') and paras[pi-1].startswith('- '): text += '\n' + p
            else: text += '\n\n' + p
        text = text.replace('\u2212','-').replace('\u2011','-')
        cards.append({'domain': domain, 'level': level, 'name': title(name), 'recall': rc.group(1), 'text': text, 'type': typ})
    else:
        print('UNPARSED', repr(l), file=sys.stderr); i+=1
json.dump(cards, open(sys.argv[2],'w'), indent=2, ensure_ascii=False)
print(len(cards))
from collections import Counter
print(Counter(c['domain'] for c in cards))
