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
