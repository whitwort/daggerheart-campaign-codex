# SRD extraction helpers

Used to produce `public/data/srd/*.json` from the official SRD PDF (see
`docs/srd-update-process.md`). All take a two-column PDF page range and
split it into column-ordered text via `pdftotext` (poppler-utils).

    python3 cols.py 206 224 /tmp/SRD.pdf > appendix.txt   # per-page gutter detection
    python3 parse_cards.py appendix.txt abilities.json    # Domain Card Reference -> abilities.json
    python3 parse_anc.py anc.txt ancestries.json ANCESTRY # ancestry/community sections
    python3 parse_anc.py com.txt communities.json COMMUNITY

`domains.json` = page-7 descriptions + per-level card-name lists derived
from abilities.json (inline one-off, see git history of the 2.0 commit).
Post-processing (drop "Elemental Kin"/"Mixed Ancestry" pseudo-records,
split the "X are often …" adjective sentence into `note`) was done by
hand; re-check the output shape against `templates.js` before committing.

`campaign-mechanics.json` (Witherwild + Supplemental Campaign Mechanics,
p.184-205) is NOT regex-parsed: the prose and cross-column tables are
hand-written markdown in `campaign-mechanics/*.md` (first line `# Name`,
rest = description). `python3 build_campaign_mechanics.py` assembles the
JSON in page order. Edit the .md files, rebuild, commit both.

Equipment (p.55-84) uses word coordinates, not `-layout` text (column
alignment drifts per line in the text rendering):

    pdftotext -f 55 -l 69 -tsv SRD.pdf weap.tsv;  python3 parse_equip.py weap.tsv weapons.json WEAPONS
    pdftotext -f 72 -l 74 -tsv SRD.pdf armor.tsv; python3 parse_equip.py armor.tsv armor.json ARMOR
    pdftotext -f 75 -l 84 -tsv SRD.pdf loot.tsv;  python3 parse_loot.py loot.tsv items.json consumables.json

Items/consumables carry `source_set` ('Core Set' | 'Hope & Fear') since
2.0 prints two separately-numbered roll tables per type.
