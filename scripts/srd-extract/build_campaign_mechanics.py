#!/usr/bin/env python3
"""Build public/data/srd/campaign-mechanics.json from campaign-mechanics/*.md.

Each .md: first line `# Name`, remainder is the markdown description
(rendered via srd-import.js's legacy formatSrdRecord path, like
conditions). Order below = SRD 2.0 page order (p.184-205).
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'campaign-mechanics')
OUT = os.path.join(HERE, '..', '..', 'public', 'data', 'srd', 'campaign-mechanics.json')
ORDER = [
    'witherwild', 'faction-tracking', 'everyday-hero-starting-equipment',
    'feasts', 'grimdark-campaigns', 'tech-based-campaigns', 'western-campaigns',
    'colossal-adversaries', 'floating-magic-school-campaigns',
    'fairy-tale-campaigns', 'monster-hunting-campaigns', 'hex-crawl-campaigns',
]
recs = []
for slug in ORDER:
    with open(os.path.join(SRC, slug + '.md'), encoding='utf-8') as f:
        text = f.read().strip()
    head, _, body = text.partition('\n')
    assert head.startswith('# '), slug
    recs.append({'name': head[2:].strip(), 'description': body.strip()})
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(recs, f, indent=2, ensure_ascii=False)
    f.write('\n')
print(len(recs), 'records ->', os.path.relpath(OUT))
