#!/usr/bin/env python3
"""Loot tables (SRD 2.0 p.75-84) -> items.json + consumables.json.

    pdftotext -f 75 -l 84 -tsv SRD.pdf loot.tsv
    python3 parse_loot.py loot.tsv items.json consumables.json

Word-coordinate parser (see parse_equip.py for why not -layout). Each
'ROLL Loot description' header row defines column x-starts; consumables
pages print two such tables side by side, so a header row with two ROLL
words yields two column sets and words are routed to the nearer table.
'Core Set ...' / 'Additional ...' subheadings set `source_set`.
"""
import json, re, sys
from collections import defaultdict
sys.path.insert(0, __import__('os').path.dirname(__file__))
from parse_equip import read_lines

def parse(lines):
    items, cons, tables, cur, kind, src = [], [], [], None, None, None
    for page, top, ws in lines:
        text = ' '.join(t for _, t in ws)
        if text == 'ITEMS': kind = 'items'; continue
        if text == 'CONSUMABLES': kind = 'consumables'; continue
        if re.match(r'^Core Set (Items|Consumables)$', text): src = 'Core Set'; continue
        if re.match(r'^Additional (Items|Consumables)$', text): src = 'Hope & Fear'; continue
        toks = [t for _, t in ws]
        if toks and toks[0] == 'ROLL' and all(t == 'ROLL' or t.lower() in ('loot', 'description') for t in toks):
            tables = []
            for i, (l, t) in enumerate(ws):
                if t == 'ROLL': tables.append([l, ws[i + 1][0], ws[i + 2][0]])
            cur = None; continue
        if not tables or kind is None or 'Daggerheart SRD' in text or text.startswith('The following table'): continue
        # route words per table
        per = [[[], [], []] for _ in tables]
        for left, t in ws:
            ti = max(i for i, tb in enumerate(tables) if left >= tb[0] - 4) if left >= tables[0][0] - 4 else 0
            ci = max(i for i, s in enumerate(tables[ti]) if left >= s - 4) if left >= tables[ti][0] - 4 else 0
            per[ti][ci].append(t)
        for ti, cells in enumerate(per):
            roll, name, desc = (' '.join(c) for c in cells)
            if not (roll or name or desc): continue
            out = items if kind == 'items' else cons
            if roll and re.match(r'^\d+$', roll):
                cur = {'name': name, 'description': desc, 'roll': roll, 'source_set': src, '_t': ti}
                out.append(cur)
            else:
                # continuation: attach to the most recent record of THIS table
                tgt = next((r for r in reversed(out) if r['_t'] == ti), None)
                if tgt is None: continue
                if name: tgt['name'] += ' ' + name
                if desc: tgt['description'] += ' ' + desc
    for r in items + cons:
        del r['_t']; r['name'] = ' '.join(r['name'].split()); r['description'] = ' '.join(r['description'].split())
    return items, cons

if __name__ == '__main__':
    items, cons = parse(read_lines(sys.argv[1]))
    json.dump(items, open(sys.argv[2], 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    json.dump(cons, open(sys.argv[3], 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print(len(items), 'items;', len(cons), 'consumables')
