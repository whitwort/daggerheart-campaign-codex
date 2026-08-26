"""Adversaries (p.97-158) + Environments (p.160-183) from SRD 2.0.

Stat blocks are prose with inline styling (bold damage, italic
conditions, bold-italic feature headers, italic GM prompts), so this
works from `pdftohtml -xml -i` output rather than pdftotext:

    pdftohtml -xml -i -f 97 -l 183 -stdout SRD.pdf > adv.xml
    python3 parse_adv.py adv.xml adversaries.json environments.json

Output shape mirrors the old seansbox upstream JSON (string stats,
"Name - Type" feature names, markdown in text) because srd-import.js's
normalizeAdversaryRecord / normalizeEnvironmentRecord expect it.
Tier and Horde "X/HP" digits are private-use glyphs (U+E53F..E549) in
the PDF; PUA maps them back to 0-9.
"""
import html, json, re, sys
import xml.etree.ElementTree as ET

PUA = {0xE53F: '0', 0xE540: '0'}
PUA.update({0xE540 + i: str(i) for i in range(1, 10)})
GUTTER = 459          # pdftohtml coords (1.5x pt); page is 918 wide
FEATURE_TYPES = ('Passive', 'Action', 'Reaction', 'Evolution')


def fix_text(s):
    s = html.unescape(s).translate(PUA)
    # ligature glyphs (fi/fl/ff/ffi) come out with a stray space after them:
    # "benefi ts", "fl ees", "Stiff ,", "Diffi  culty"
    s = re.sub(r'\bf([il])\s+(?=[a-z])', r'f\1', s)
    s = re.sub(r'(?<=[A-Za-z])f([il])\s+(?=[a-z])', r'f\1', s)
    s = re.sub(r'(?<=[A-Za-z]f)\s+(?=-)', '', s)
    # "ff" ligature gaps: only a closed set of words in this range (checked
    # by hand; "off heads"/"cliff side" are real spaces and stay)
    s = re.sub(r'\b([Dd]iff|[Ee]ff|[Aa]ff|[Ss]uff|[Uu]naff) (?=[a-z])', r'\1', s)
    s = re.sub(r'\b(quaff|puff) s\b', r'\1s', s)
    s = re.sub(r'\b([Oo]ff) (er|ers|ering|ended)\b', r'\1\2', s)
    s = re.sub(r'(?<=[A-Za-z]f)\s+(?=[,.;:!?])', '', s)
    return s


def seg_style(el):
    b = el.find('.//b') is not None
    i = el.find('.//i') is not None
    txt = ''.join(el.itertext())
    return fix_text(txt), b, i


def load_lines(path):
    root = ET.parse(path).getroot()
    lines = []
    for page in root.findall('page'):
        pno = int(page.get('number'))
        segs = []
        for t in page.findall('text'):
            txt, b, i = seg_style(t)
            if not txt.strip():
                continue
            top, left = int(t.get('top')), int(t.get('left'))
            font = int(t.get('font'))
            segs.append((0 if left < GUTTER else 1, top, left, txt, b, i, font, int(t.get('width'))))
        segs.sort(key=lambda s: (s[0], s[1], s[2]))
        # group by (col, top +-3)
        cur = None
        for col, top, left, txt, b, i, font, w in segs:
            if cur and cur['col'] == col and abs(cur['top'] - top) <= 3:
                cur['segs'].append((left, txt, b, i, font, w))
            else:
                cur = {'page': pno, 'col': col, 'top': top, 'left': left, 'segs': [(left, txt, b, i, font, w)]}
                lines.append(cur)
    for l in lines:
        l['segs'].sort(key=lambda s: s[0])
        l['left'] = l['segs'][0][0]
    return lines


def render(segs):
    """Inline markdown for a line's segments."""
    # merge consecutive same-style runs first ("**mark a** **Stress**")
    runs = []
    prev_end = None
    for left, txt, b, i, _, w in segs:
        if runs and not txt[:1].isspace() and not runs[-1][0][-1:].isspace() \
                and (left - prev_end > 2 or (txt[:1].isalnum() and runs[-1][0][-1:].isalnum())):
            txt = ' ' + txt      # gap between elements = a space ("mark a"+"Stress")
        prev_end = left + w
        if runs and runs[-1][1:] == (b, i):
            runs[-1] = (runs[-1][0] + txt, b, i)
        else:
            runs.append((txt, b, i))
    parts = []
    for txt, b, i in runs:
        core = re.sub(r'\s+', ' ', txt).strip()
        if not core:
            continue
        if core.startswith('•') and (b or i):   # keep the bullet glyph outside the markup
            parts.append('•'); core = core[1:].strip()
        if b and i:
            core = '***' + core + '***'
        elif b:
            core = '**' + core + '**'
        elif i:
            core = '_' + core + '_'
        parts.append(core)
    out = ' '.join(parts)
    out = re.sub(r'\s+([,.;:)\]?!])', r'\1', out)
    out = re.sub(r'([(\[])\s+', r'\1', out)
    return out.strip()


def plain(segs):
    return re.sub(r'\s+', ' ', ''.join(s[1] for s in segs)).strip()


def is_footer(l):
    p = plain(l['segs'])
    return bool(re.fullmatch(r'(\d+\s*)?Daggerheart SRD(\s*\d+)?', p))


def is_name(l):
    s = l['segs']
    return len(s) >= 1 and s[0][4] in (0, 20) and plain(s).isupper()


def tier_line(l):
    return re.match(r'Tier (\d) (.+)', plain(l['segs']))


def parse(lines):
    advs, envs, tier = [], [], None
    blocks = []
    i = 0
    n = len(lines)
    # 1. segment into blocks: name line(s) + Tier line + body until next name
    while i < n:
        l = lines[i]
        p = plain(l['segs'])
        m = re.match(r'TIER (\d) (ADVERSARIES|ENVIRONMENTS)', p)
        if m:
            tier = m.group(1); i += 1; continue
        if is_name(l) and not p.startswith('TIER ') and not p.startswith('('):
            name = [p]
            j = i + 1
            while j < n and is_name(lines[j]) and not tier_line(lines[j]):
                if not plain(lines[j]['segs']).startswith('('):
                    name.append(plain(lines[j]['segs']))
                j += 1
            if j < n and tier_line(lines[j]):
                tm = tier_line(lines[j])
                body = []
                k = j + 1
                while k < n and not is_name(lines[k]) and not (plain(lines[k]['segs']).isupper() and plain(lines[k]['segs']) != 'FEATURES'):
                    if not is_footer(lines[k]):
                        body.append(lines[k])
                    k += 1
                blocks.append((tier, ' '.join(name).title(), tm.group(2).strip(), body, tm.group(1)))
                i = k; continue
        i += 1
    for tier, name, typ, body, tnum in blocks:
        if tnum != tier:
            # Volcanic Eruption (p.178): Tier 4 section header is laid over a
            # Tier 3 block; the glyph + the by-tier index agree on 3.
            print('tier mismatch (glyph wins)', name, tnum, tier, file=sys.stderr)
        rec = parse_block(name, typ, body, tnum)
        (envs if typ in ('Exploration', 'Traversal', 'Event', 'Social') and 'impulses' in rec else advs).append(rec)
    return advs, envs


def parse_block(name, typ, body, tier):
    rec = {'name': fix_name(name), 'tier': tier, 'type': typ, 'feature': []}
    # block indent per column (a block may continue into the next column/page)
    col_left = {}
    for l in body:
        col_left[(l['page'], l['col'])] = min(col_left.get((l['page'], l['col']), 9999), l['left'])
    mode = 'desc'
    desc, motives, imp, potadv, exp = [], [], [], [], []
    feats = []
    for l in body:
        p = plain(l['segs'])
        s0 = l['segs'][0]
        if p == 'FEATURES':
            mode = 'feat'; continue
        if mode != 'feat':
            if p.startswith('Motives & Tactics:'):
                mode = 'mot'; motives.append(p.split(':', 1)[1].strip()); continue
            if p.startswith('Impulses:'):
                mode = 'imp'; imp.append(p.split(':', 1)[1].strip()); continue
            if p.startswith('Difficulty:'):
                mode = 'stats'
                for k, v in re.findall(r'(Difficulty|Thresholds|HP|Stress):\s*([^|]+)', p):
                    rec[k.lower()] = v.strip()
                continue
            if p.startswith('ATK:'):
                m = re.match(r'ATK:\s*([^|:]+)\|\s*([^:|]+):\s*([^|]+)\|\s*(.+)', p)
                m2 = re.match(r'ATK:\s*([^:|]+):\s*([^|]+)\|\s*([^|]+)\|\s*(.+)', p)
                if m:
                    rec['atk'], rec['attack'], rec['range'], rec['damage'] = [x.strip() for x in m.groups()]
                elif m2:
                    rec['attack'], rec['atk'], rec['range'], rec['damage'] = [x.strip() for x in m2.groups()]
                if 'atk' in rec:
                    rec['atk'] = rec['atk'].replace('−', '-').replace('–', '-')
                else:
                    print('bad ATK', name, p, file=sys.stderr)
                continue
            if p.startswith('Experience:'):
                mode = 'exp'; exp.append(p.split(':', 1)[1].strip()); continue
            if p.startswith('Potential Adversaries:'):
                mode = 'pot'; potadv.append(p.split(':', 1)[1].strip()); continue
            {'desc': desc, 'mot': motives, 'imp': imp, 'exp': exp, 'pot': potadv, 'stats': desc}[mode].append(p)
            continue
        # features
        fm = re.match(r'\*\*\*(.+?)\s*-\s*(%s):\*\*\*(.*)' % '|'.join(FEATURE_TYPES), render(l['segs']))
        base_left = col_left[(l['page'], l['col'])]
        if fm and abs(l['left'] - base_left) <= 6 and s0[2] and s0[3]:
            feats.append({'name': fm.group(1) + ' - ' + fm.group(2), 'lines': [(l['left'], fm.group(3).strip(), False)]})
            continue
        if not feats:
            print('orphan feature text', name, p, file=sys.stderr); continue
        italic_all = all(s[3] for s in l['segs'] if s[1].strip())
        feats[-1]['lines'].append((l['left'] - base_left, render(l['segs']), italic_all))
    rec['description'] = ' '.join(desc)
    if motives: rec['motives_and_tactics'] = ' '.join(motives)
    if imp: rec['impulses'] = ' '.join(imp)
    if potadv: rec['potential_adversaries'] = ' '.join(potadv)
    if exp: rec['experience'] = ' '.join(exp)
    for f in feats:
        rec['feature'].append({'name': f['name'], 'text': join_feature(f['lines'])})
    if 'impulses' in rec:
        for f in rec['feature']:
            q = re.findall(r'_([^_]+\?)_\s*$', f['text'])
            if q: f['question'] = q[0]
    return rec


def join_feature(lines):
    """Merge wrapped lines; bullets -> list items; italic GM prompt -> own
    italic paragraph; indented sub-features (evolutions) -> own paragraph."""
    paras = []
    cur = ''
    mode = 'text'
    for left, txt, italic in lines:
        bullet = txt.startswith('•') or re.match(r'\d+\. ', txt)
        subfeat = re.match(r'\*\*\*.+?\s*-\s*(%s):\*\*\*' % '|'.join(FEATURE_TYPES), txt) or re.match(r'\*\*[^*]+:\*\* \S+ \| \S', txt)
        if bullet:
            paras.append(cur); cur = txt if txt[0].isdigit() else '- ' + txt[1:].strip(); mode = 'bullet'; continue
        if subfeat or (italic and mode != 'italic' and txt.endswith('?') or (italic and mode not in ('italic',) and cur and cur.rstrip().endswith(('.', '?')) and mode != 'bullet')):
            paras.append(cur); cur = txt; mode = 'italic' if italic else 'sub'; continue
        if mode == 'bullet' and left <= 12:
            paras.append(cur); cur = txt; mode = 'text'; continue
        if cur and re.search(r'[A-Za-z]-$', cur) and txt[:1].isalpha():
            cur += txt          # line-wrap hyphen ("piston-" / "driven")
        else:
            cur = (cur + ' ' + txt).strip() if cur else txt
    paras.append(cur)
    paras = [p.strip() for p in paras if p.strip()]
    out = []
    for p in paras:
        if out and re.match(r'(- |\d+\. )', p) and re.match(r'(- |\d+\. )', out[-1]):
            out[-1] += '\n' + p
        else:
            out.append(p)
    text = '\n\n'.join(out)
    # merge adjacent italic fragments split across lines: "_a_ _b_" -> "_a b_"
    text = re.sub(r'(?<!_)_ _(?!_)', ' ', text)
    text = re.sub(r'(?<!\*)\*\* \*\*(?!\*)', ' ', text)
    return text


def fix_name(n):
    n = re.sub(r"(\w)'S\b", r"\1's", n)
    n = n.replace("’S ", "’s ")
    for w in (' Of ', ' The ', ' And ', ' To ', ' In ', ' A '):
        n = n.replace(w, w.lower())
    n = re.sub(r'-(\w)', lambda m: '-' + m.group(1).upper(), n)
    return n


if __name__ == '__main__':
    lines = load_lines(sys.argv[1])
    advs, envs = parse(lines)
    json.dump(advs, open(sys.argv[2], 'w'), indent=1, ensure_ascii=False)
    json.dump(envs, open(sys.argv[3], 'w'), indent=1, ensure_ascii=False)
    print(len(advs), 'adversaries;', len(envs), 'environments', file=sys.stderr)
