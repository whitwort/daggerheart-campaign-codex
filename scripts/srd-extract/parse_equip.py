#!/usr/bin/env python3
"""Equipment tables (SRD 2.0) -> weapons.json / armor.json via word coords.

    pdftotext -f 55 -l 69 -tsv SRD.pdf weap.tsv ; python3 parse_equip.py weap.tsv weapons.json WEAPONS
    pdftotext -f 72 -l 74 -tsv SRD.pdf armor.tsv; python3 parse_equip.py armor.tsv armor.json ARMOR

`-layout` text drifts column alignment per line, so this uses `-tsv` word
boxes instead: every 'Name Trait Range Damage Burden Feature' header row
defines the column x-starts for the rows beneath it (they shift between
pages); words are binned by x. A row starts when the 2nd column is
non-empty; other lines fold their Name/Feature words into the row above.
"""
import json, re, sys
from collections import defaultdict

WEAPON_COLS = ['Name', 'Trait', 'Range', 'Damage', 'Burden', 'Feature']
ARMOR_COLS = ['Name', 'Thresholds', 'Score', 'Feature']

def read_lines(path):
    """-> list of (page, top, [(left, text), ...]) sorted by page/top."""
    words = defaultdict(list)  # (page, ytop) -> words
    for row in open(path, encoding='utf-8'):
        f = row.rstrip('\n').split('\t')
        if len(f) < 12 or f[0] != '5': continue
        page, left, top, text = int(f[1]), float(f[6]), float(f[7]), f[11]
        words[(page, top)].append((left, text))
    # merge tops within 3pt on same page
    keys = sorted(words)
    lines, cur = [], None
    for k in keys:
        if cur and cur[0] == k[0] and abs(cur[1] - k[1]) <= 3:
            cur[2].extend(words[k])
        else:
            cur = [k[0], k[1], list(words[k])]; lines.append(cur)
    return [(p, t, sorted(w)) for p, t, w in lines]

def feature_from(text):
    text = ' '.join(text.split())
    if not text or text in ('—', '-', '–'): return []
    m = re.match(r'^([A-Z][A-Za-z\'’ -]+?):\s*(.*)$', text, re.S)
    if not m: return [{'name': text, 'text': ''}]
    return [{'name': m.group(1).strip(), 'text': m.group(2).strip()}]

def parse(lines, cols, weapons):
    recs, starts, cur = [], None, None
    tier = pm = ps = None
    for page, top, ws in lines:
        text = ' '.join(t for _, t in ws)
        m = re.match(r'^TIER (\d)', text)
        if m: tier = m.group(1); cur = None; continue
        if text.startswith('PRIMARY WEAPON'): ps = 'Primary'; continue
        # Secondary tables have no Physical/Magic split; 1.0 tagged them all
        # Physical (secondaries include mag-damage items but the field is a
        # section label, kept for schema continuity).
        if text.startswith('SECONDARY WEAPON'): ps = 'Secondary'; pm = 'Physical'; continue
        if text == 'Physical Weapons': pm = 'Physical'; continue
        if text == 'Magic Weapons': pm = 'Magical'; continue
        hdr = [t for _, t in ws]
        if hdr == cols or (not weapons and hdr == ['Name', 'Thresholds', 'Score', 'Feature']):
            starts = [l for l, _ in ws]; cur = None; continue
        if starts is None or 'Daggerheart SRD' in text or text in ('Base', 'Base Base'): continue
        if text.startswith('All magic weapons') or text.startswith('Players can') or text.startswith('other weapons'): continue
        cells = [[] for _ in cols]
        for left, t in ws:
            idx = 0
            for i, s in enumerate(starts):
                if left >= s - 4: idx = i
            cells[idx].append(t)
        cells = [' '.join(c) for c in cells]
        if cells[1]:
            cur = dict(zip(cols, cells)); cur['_tier'] = tier; cur['_pm'] = pm; cur['_ps'] = ps
            recs.append(cur)
        elif cur and (cells[0] or cells[-1]):
            if cells[0]: cur['Name'] += ' ' + cells[0]
            if cells[-1]: cur['Feature'] += ' ' + cells[-1]
    out = []
    for r in recs:
        if weapons:
            rec = {'name': r['Name'], 'trait': r['Trait'], 'range': r['Range'], 'damage': r['Damage'],
                   'burden': r['Burden'], 'feature': feature_from(r['Feature']), 'tier': r['_tier'],
                   'physical_or_magical': r['_pm'], 'primary_or_secondary': r['_ps']}
        else:
            rec = {'name': r['Name'], 'tier': r['_tier'], 'base_thresholds': r['Thresholds'],
                   'base_score': r['Score'], 'feature': feature_from(r['Feature'])}
        if not rec['feature']: del rec['feature']  # 1.0 shape: key absent when none
        out.append(rec)
    return out

if __name__ == '__main__':
    src, dst, kind = sys.argv[1], sys.argv[2], sys.argv[3]
    weapons = kind == 'WEAPONS'
    recs = parse(read_lines(src), WEAPON_COLS if weapons else ARMOR_COLS, weapons)
    json.dump(recs, open(dst, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print(len(recs), 'records')
