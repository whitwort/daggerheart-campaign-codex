// export-render.js — format builders for Admin > Data > Export Lore.
// Shared by export-lore.js (GM admin view) and, per the Phase design
// discussion, a future player-facing reuse of the same export UI.
//
// Pure-ish helpers: everything here takes already-resolved data
// (entities + their ctx-filtered content) and produces a Blob. No
// visibility/canSee logic lives here -- that stays in export-lore.js
// (and ultimately visibility.js), so this module doesn't need to know
// about GM vs player vs character ctx beyond the plain secretCharName
// string it's handed (the name to print in a "[Secret - X only]" tag;
// null when nothing in this export is secret-tagged).
//
// docx/jsPDF are loaded lazily via esm.sh dynamic import, same pattern
// as marked/DOMPurify in markdown.js and sortablejs elsewhere -- a CDN
// hiccup only breaks the Word/PDF export path, not the whole app.
//
// perEntity (shared shape, built by export-lore.js's buildPerEntityRecord):
//   { entity, entitySecret, statBlockMd,
//     loreContent: {content,secret}[], noteContent: {content,secret}[],
//     sourceIds }
// imagesByEntity: { [entityId]: imageDoc[] }  (each may carry .secret)
// Every builder below renders, per entity: statBlockMd (Details/
// Features, template entities only) -> "Lore" (bulleted, if any) ->
// "Gallery" (if any images) -> "Notes" (bulleted, if any) -- each
// section heading omitted when its content is empty. Secret items get
// a "[Secret - Name only]" tag and a teal outline/color.

import { getFirestore, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { loadMarkdownModules } from './markdown.js';
import { categoryGroupLabel } from './codex.js';

const db = getFirestore(firebaseApp);
const SECRET_COLOR_HEX = '2E86AB';
const SECRET_COLOR_RGB = [0x2E, 0x86, 0xAB];

// --- Image fetch -----------------------------------------------------

// One-time (not onSnapshot) fetch of every 'entity'-owned image doc for
// the given entity ids, chunked at Firestore's 30-item 'in' cap. Used
// only at export time -- the app's live caches (entity-images-cache.js,
// state.allCharacterImages) are scoped to a single entity or metadata-
// only, neither of which fits "full image data for N export entities".
function fetchImagesForEntities(entityIds) {
  const ids = entityIds.slice();
  const chunks = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
  if (!chunks.length) return Promise.resolve([]);
  return Promise.all(chunks.map(function (chunk) {
    const q = query(collection(db, 'images'), where('ownerType', '==', 'entity'), where('ownerId', 'in', chunk));
    return getDocs(q).then(function (snap) {
      const out = [];
      snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
      return out;
    });
  })).then(function (results) { return results.flat(); });
}

// webp (the app's own upload format) has inconsistent embed support
// across docx/PDF libraries -- normalize every image to PNG via canvas
// decode/re-encode before handing it to either builder. Returns PNG
// bytes (docx's ImageRun wants an ArrayBuffer/Uint8Array) AND the
// source canvas (jsPDF's addImage takes a canvas directly -- avoids
// round-tripping back through a base64 data URL, which was silently
// throwing "Maximum call stack size exceeded" on anything but small
// images via String.fromCharCode.apply on a large byte array).
function imageToPngBytes(dataUrl) {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx2d = canvas.getContext('2d');
      ctx2d.drawImage(img, 0, 0);
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error('PNG re-encode failed')); return; }
        blob.arrayBuffer().then(function (buf) {
          resolve({ bytes: new Uint8Array(buf), width: img.naturalWidth, height: img.naturalHeight, canvas: canvas });
        }, reject);
      }, 'image/png');
    };
    img.onerror = function () { reject(new Error('Could not decode image')); };
    img.src = dataUrl;
  });
}

// --- Markdown inline parsing --------------------------------------------

function inlineRuns(tokens, bold, italic) {
  const runs = [];
  (tokens || []).forEach(function (t) {
    if (t.type === 'strong') { runs.push.apply(runs, inlineRuns(t.tokens, true, italic)); }
    else if (t.type === 'em') { runs.push.apply(runs, inlineRuns(t.tokens, bold, true)); }
    else if (t.type === 'link') { runs.push.apply(runs, inlineRuns(t.tokens, bold, italic)); }
    else if (t.type === 'br') { runs.push({ text: '\n', bold: !!bold, italic: !!italic }); }
    else if (t.tokens && t.tokens.length) { runs.push.apply(runs, inlineRuns(t.tokens, bold, italic)); }
    else {
      const text = t.text != null ? t.text : (t.raw || '');
      if (text) runs.push({ text: text, bold: !!bold, italic: !!italic });
    }
  });
  return runs;
}

function listItemRuns(item) {
  const textTok = (item.tokens || []).find(function (t) { return t.type === 'text' || t.type === 'paragraph'; });
  return inlineRuns(textTok ? textTok.tokens : item.tokens, false, false);
}

// Parses a markdown string into a flat block list (docx/PDF's Details/
// Features "statBlockMd" content -- structured, so it's worth a real
// markdown->blocks walk). Ordered/unordered lists both render as
// bulleted (no numbering.config plumbing) -- an accepted simplification
// since these lists are effectively always unordered in practice.
function blocksFromMarkdown(md, marked) {
  const tokens = marked.lexer(md || '', { breaks: true });
  const blocks = [];
  function walkList(listToken, depth) {
    listToken.items.forEach(function (item) {
      blocks.push({ type: 'listitem', depth: depth, runs: listItemRuns(item) });
      (item.tokens || []).forEach(function (t) { if (t.type === 'list') walkList(t, depth + 1); });
    });
  }
  tokens.forEach(function (tok) {
    if (tok.type === 'heading') blocks.push({ type: 'heading', level: tok.depth, runs: inlineRuns(tok.tokens) });
    else if (tok.type === 'paragraph') blocks.push({ type: 'paragraph', runs: inlineRuns(tok.tokens) });
    else if (tok.type === 'list') walkList(tok, 0);
    else if (tok.type === 'blockquote') blocks.push({ type: 'paragraph', runs: [{ text: tok.text, bold: false, italic: true }] });
    else if (tok.type === 'hr') blocks.push({ type: 'hr' });
    // space/code/table/etc: not expected in this app's lore content;
    // silently dropped rather than guessing a rendering.
  });
  return blocks;
}

// A single Lore/Note item's content flattened to one run list (multi-
// paragraph items get a blank line between paragraphs) -- these items
// render as one bullet each, not a nested block structure, so there's
// no need for the full blocksFromMarkdown list-walk here.
function itemInlineRuns(content, marked) {
  const tokens = marked.lexer(content || '', { breaks: true });
  const runs = [];
  tokens.forEach(function (tok, i) {
    if (i > 0) runs.push({ text: '\n' });
    if (tok.tokens && tok.tokens.length) runs.push.apply(runs, inlineRuns(tok.tokens));
    else if (tok.text) runs.push({ text: tok.text });
  });
  return runs;
}

// Plain-text ("Secret - Name only") flavor used by the Markdown export,
// which has no color/border to lean on.
function secretTagText(secretCharacterName) {
  return '[Secret \u2013 ' + secretCharacterName + ' only] ';
}

// Multiple separate lore/note items on one entity render as an
// unordered list (one bullet per item), mirroring how import.js's own
// `lore` array turns multiple markdown strings into multiple separate
// items on the way in -- this is the reverse direction of that same
// transform. Used by the Markdown builder only; docx/PDF walk `items`
// directly so they can add a per-item border/color for secrets.
function toBulletListMd(items, secretCharacterName) {
  return items.map(function (it) {
    const prefix = it.secret ? secretTagText(secretCharacterName) : '';
    return '- ' + (prefix + it.content).trim().split('\n').join('\n  ');
  }).join('\n');
}

// --- Sources / copyright warning ---------------------------------------

function buildSourcesWarning(sourceIds, allSources) {
  const uniqueIds = Array.from(new Set(sourceIds.filter(Boolean)));
  const sources = uniqueIds
    .map(function (id) { return allSources.find(function (s) { return s.id === id; }); })
    .filter(Boolean);
  const lines = ['Sources:'];
  if (sources.length) {
    sources.forEach(function (s) { lines.push('- ' + (s.text || '').trim().split('\n')[0]); });
  } else {
    lines.push('- (none recorded on the exported content)');
  }
  lines.push('');
  lines.push('Some of this content may be drawn from copyrighted sources (see above). Do not repost or redistribute it if so.');
  return lines.join('\n');
}

// --- Markdown export -----------------------------------------------------
// No embedded image bytes (keeps the file a lightweight, readable
// text artifact) -- a non-empty Gallery section just notes the count.

function buildMarkdownDocument(perEntity, imagesByEntity, warningText, secretCharacterName) {
  const byCategory = {};
  perEntity.forEach(function (pe) {
    const cat = pe.entity.category || '(uncategorized)';
    (byCategory[cat] = byCategory[cat] || []).push(pe);
  });
  const parts = [];
  Object.keys(byCategory).sort().forEach(function (cat) {
    parts.push('# ' + categoryGroupLabel(cat));
    byCategory[cat]
      .sort(function (a, b) { return (a.entity.name || '').localeCompare(b.entity.name || ''); })
      .forEach(function (pe) {
        parts.push('## ' + pe.entity.name + (pe.entitySecret ? ' ' + secretTagText(secretCharacterName).trim() : ''));
        if (pe.statBlockMd) parts.push(pe.statBlockMd);
        if (pe.loreContent.length) parts.push('### Lore', toBulletListMd(pe.loreContent, secretCharacterName));
        const imgs = imagesByEntity[pe.entity.id] || [];
        if (imgs.length) {
          parts.push('### Gallery', '*(' + imgs.length + ' image' + (imgs.length === 1 ? '' : 's') + ' -- not embedded in this Markdown export)*');
        }
        if (pe.noteContent.length) parts.push('### Notes', toBulletListMd(pe.noteContent, secretCharacterName));
      });
  });
  parts.push('---');
  parts.push(warningText);
  return parts.join('\n\n');
}

// --- Word (.docx) export ---------------------------------------------

let docxModulePromise = null;
function loadDocx() {
  if (!docxModulePromise) docxModulePromise = import('https://esm.sh/docx@8');
  return docxModulePromise;
}

function docxParagraphsFromBlocks(blocks, docxMod) {
  const { Paragraph, TextRun, HeadingLevel } = docxMod;
  const headingMap = {
    1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6
  };
  function runs(block) {
    return (block.runs || []).map(function (r) {
      return new TextRun({ text: r.text, bold: !!r.bold, italics: !!r.italic });
    });
  }
  return blocks.map(function (block) {
    if (block.type === 'heading') {
      return new Paragraph({ heading: headingMap[block.level] || HeadingLevel.HEADING_6, spacing: { before: 240, after: 100 }, children: runs(block) });
    }
    if (block.type === 'listitem') {
      return new Paragraph({ bullet: { level: block.depth || 0 }, spacing: { after: 60 }, children: runs(block) });
    }
    if (block.type === 'hr') {
      return new Paragraph({ text: '', border: { bottom: { color: 'auto', space: 1, style: 'single', size: 6 } } });
    }
    return new Paragraph({ spacing: { after: 120 }, children: runs(block) });
  });
}

// Each Lore/Note item is its own bulleted Paragraph (not run through
// blocksFromMarkdown) so a secret item can carry its own colored tag +
// bordered "outline" box -- that per-item metadata doesn't survive a
// round-trip through a single combined markdown string.
function docxItemListParagraphs(items, secretCharacterName, docxMod, marked) {
  const { Paragraph, TextRun } = docxMod;
  return items.map(function (item) {
    const runs = [];
    if (item.secret) {
      runs.push(new TextRun({ text: secretTagText(secretCharacterName), bold: true, color: SECRET_COLOR_HEX }));
    }
    itemInlineRuns(item.content, marked).forEach(function (r) {
      if (!r.text) return;
      runs.push(new TextRun({ text: r.text, bold: !!r.bold, italics: !!r.italic }));
    });
    const opts = { bullet: { level: 0 }, spacing: { after: 80 }, children: runs };
    if (item.secret) {
      const b = { color: SECRET_COLOR_HEX, size: 6, style: 'single', space: 4 };
      opts.border = { top: b, bottom: b, left: b, right: b };
    }
    return new Paragraph(opts);
  });
}

// Section sub-headings (Lore/Gallery/Notes) render as Heading 3 --
// deliberately excluded from the ToC's headingStyleRange (1-2) so the
// contents list stays at category/entity granularity, not cluttered
// with every entity's sub-sections. Default document font is set to a
// sans-serif (Calibri) at the style level so it covers headings too,
// not just body TextRuns.
async function buildDocxBlob(perEntity, imagesByEntity, warningText, secretCharacterName) {
  const docxMod = await loadDocx();
  const { Document, Packer, Paragraph, HeadingLevel, ImageRun, TextRun, TableOfContents, PageBreak } = docxMod;
  const mods = await loadMarkdownModules();
  const marked = mods.marked;

  function sectionHeading(text, keepNext) {
    return new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 80 }, keepNext: !!keepNext, children: [new TextRun(text)] });
  }

  const byCategory = {};
  perEntity.forEach(function (pe) {
    const cat = pe.entity.category || '(uncategorized)';
    (byCategory[cat] = byCategory[cat] || []).push(pe);
  });
  const categories = Object.keys(byCategory).sort();

  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('Lore Export')] }),
    new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),
    new Paragraph({ children: [new PageBreak()] })
  ];

  for (const cat of categories) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 150 }, children: [new TextRun(categoryGroupLabel(cat))] }));
    const list = byCategory[cat].sort(function (a, b) { return (a.entity.name || '').localeCompare(b.entity.name || ''); });
    for (const pe of list) {
      const nameRuns = [new TextRun(pe.entity.name)];
      if (pe.entitySecret) nameRuns.push(new TextRun({ text: '  ' + secretTagText(secretCharacterName).trim(), color: SECRET_COLOR_HEX, bold: true, size: 22 }));
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 100 }, children: nameRuns }));
      if (pe.statBlockMd) {
        children.push.apply(children, docxParagraphsFromBlocks(blocksFromMarkdown(pe.statBlockMd, marked), docxMod));
      }
      if (pe.loreContent.length) {
        children.push(sectionHeading('Lore'));
        children.push.apply(children, docxItemListParagraphs(pe.loreContent, secretCharacterName, docxMod, marked));
      }
      const imgs = imagesByEntity[pe.entity.id] || [];
      if (imgs.length) {
        // keepNext ties this heading to the paragraph that follows (the
        // first image) so Word never strands "Gallery" alone at the
        // bottom of a page with the image pushed to the next one.
        children.push(sectionHeading('Gallery', true));
        for (const img of imgs) {
          try {
            const png = await imageToPngBytes(img.data);
            const maxW = 400;
            const scale = png.width > maxW ? maxW / png.width : 1;
            const imgPara = new Paragraph({
              children: [new ImageRun({ data: png.bytes, transformation: { width: Math.round(png.width * scale), height: Math.round(png.height * scale) }, type: 'png' })]
            });
            children.push(imgPara);
            if (img.secret) {
              children.push(new Paragraph({ children: [new TextRun({ text: secretTagText(secretCharacterName).trim(), bold: true, italics: true, color: SECRET_COLOR_HEX, size: 18 })] }));
            }
          } catch (e) {
            children.push(new Paragraph({ children: [new TextRun({ text: '[image failed to embed]', italics: true })] }));
          }
        }
      }
      if (pe.noteContent.length) {
        children.push(sectionHeading('Notes'));
        children.push.apply(children, docxItemListParagraphs(pe.noteContent, secretCharacterName, docxMod, marked));
      }
    }
  }

  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(new Paragraph({ border: { bottom: { color: 'auto', space: 1, style: 'single', size: 6 } }, text: '' }));
  warningText.split('\n').forEach(function (line) {
    children.push(new Paragraph({ children: [new TextRun({ text: line, italics: true, size: 18 })] }));
  });

  const doc = new Document({
    features: { updateFields: true },
    styles: {
      default: {
        document: { run: { font: 'Calibri' } },
        title: { run: { font: 'Calibri' } },
        heading1: { run: { font: 'Calibri' } },
        heading2: { run: { font: 'Calibri' } },
        heading3: { run: { font: 'Calibri' } }
      }
    },
    sections: [{ children: children }]
  });
  return Packer.toBlob(doc);
}

// --- PDF export --------------------------------------------------------
// jsPDF has no field-based ToC (unlike docx), so this is a manual
// two-pass layout: page 1 is reserved blank, the body renders starting
// on page 2 while recording each category/entity's page number, then
// the reserved page 1 is drawn last using doc.setPage(1) + those
// recorded numbers. TOC line height auto-shrinks to whatever fits in
// one page rather than inserting extra pages (which would shift every
// already-recorded body page number). Every page (including the ToC)
// gets a footer page number once the full page count is known.

let jsPdfModulePromise = null;
function loadJsPdf() {
  if (!jsPdfModulePromise) jsPdfModulePromise = import('https://esm.sh/jspdf@2');
  return jsPdfModulePromise;
}

async function buildPdfBlob(perEntity, imagesByEntity, warningText, secretCharacterName) {
  const jsPdfMod = await loadJsPdf();
  const jsPDF = jsPdfMod.jsPDF || jsPdfMod.default;
  const mods = await loadMarkdownModules();
  const marked = mods.marked;

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const margin = 54;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  function ensureRoom(h) {
    if (y + h > pageHeight - margin) { doc.addPage(); y = margin; }
  }

  function renderRuns(runs, size, indent) {
    const x0 = margin + (indent || 0);
    const lineHeight = size * 1.3;
    let x = x0;
    ensureRoom(lineHeight);
    runs.forEach(function (run) {
      const style = run.bold && run.italic ? 'bolditalic' : run.bold ? 'bold' : run.italic ? 'italic' : 'normal';
      doc.setFont('helvetica', style);
      doc.setFontSize(size);
      doc.setTextColor.apply(doc, run.color || [0, 0, 0]);
      run.text.split(/(\s+)/).forEach(function (word) {
        if (word === '') return;
        if (word === '\n') { y += lineHeight; x = x0; ensureRoom(lineHeight); return; }
        const w = doc.getTextWidth(word);
        if (x + w > x0 + (maxWidth - (indent || 0)) && word.trim() !== '') {
          y += lineHeight; x = x0; ensureRoom(lineHeight);
        }
        if (word.trim() === '' && x === x0) return; // no leading space after a wrap
        doc.text(word, x, y);
        x += w;
      });
    });
    doc.setTextColor(0, 0, 0);
    y += lineHeight;
  }

  function renderBlock(block) {
    if (block.type === 'heading') {
      const size = Math.max(11, 20 - (block.level - 1) * 2);
      y += 10;
      renderRuns(block.runs.map(function (r) { return Object.assign({}, r, { bold: true }); }), size, 0);
      return;
    }
    if (block.type === 'listitem') {
      ensureRoom(14);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.text('\u2022', margin + (block.depth || 0) * 14, y);
      renderRuns(block.runs, 10, (block.depth || 0) * 14 + 12);
      return;
    }
    if (block.type === 'hr') {
      ensureRoom(10);
      doc.setDrawColor(180);
      doc.line(margin, y, pageWidth - margin, y);
      y += 12;
      return;
    }
    renderRuns(block.runs, 10, 0);
  }

  // Renders one Lore/Note item as a bullet, drawing a teal outline box
  // around it (and a colored "[Secret - Name only]" tag) when secret.
  function renderItem(item) {
    ensureRoom(14);
    const startY = y - 9;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('\u2022', margin, y);
    const runs = [];
    if (item.secret) runs.push({ text: secretTagText(secretCharacterName), bold: true, color: SECRET_COLOR_RGB });
    itemInlineRuns(item.content, marked).forEach(function (r) { if (r.text) runs.push(r); });
    renderRuns(runs, 10, 12);
    if (item.secret) {
      doc.setDrawColor.apply(doc, SECRET_COLOR_RGB);
      doc.roundedRect(margin - 3, startY, maxWidth + 6, (y - startY) - 4, 2, 2, 'S');
      doc.setDrawColor(0, 0, 0);
    }
  }

  function sectionHeading(text) {
    y += 8;
    ensureRoom(18);
    renderRuns([{ text: text, bold: true }], 12, 0);
  }

  // Renders the FIRST image of a gallery already-decoded (so its
  // height is known before the "Gallery" heading is committed to a
  // page -- see the pairing logic in the main loop below, which keeps
  // the heading and first image together rather than orphaning the
  // heading alone at a page bottom).
  function placeDecodedImage(png, secret) {
    const maxW = maxWidth;
    const maxH = 260;
    let w = png.width, h = png.height;
    if (w > maxW) { h = h * (maxW / w); w = maxW; }
    if (h > maxH) { w = w * (maxH / h); h = maxH; }
    ensureRoom(h + 10);
    doc.addImage(png.canvas, 'PNG', margin, y, w, h);
    y += h + 10;
    if (secret) renderRuns([{ text: secretTagText(secretCharacterName).trim(), bold: true, italic: true, color: SECRET_COLOR_RGB }], 9, 0);
  }

  async function renderImage(img) {
    try {
      const png = await imageToPngBytes(img.data);
      placeDecodedImage(png, !!img.secret);
    } catch (e) {
      ensureRoom(12);
      renderRuns([{ text: '[image failed to embed]', italic: true }], 9, 0);
    }
  }

  const byCategory = {};
  perEntity.forEach(function (pe) {
    const cat = pe.entity.category || '(uncategorized)';
    (byCategory[cat] = byCategory[cat] || []).push(pe);
  });
  const categories = Object.keys(byCategory).sort();

  // Reserve page 1 for the ToC; body starts on page 2.
  doc.addPage();
  y = margin;
  const tocEntries = [];

  for (const cat of categories) {
    y += 16;
    ensureRoom(30);
    tocEntries.push({ label: categoryGroupLabel(cat), page: doc.internal.getCurrentPageInfo().pageNumber, indent: 0, bold: true });
    renderRuns([{ text: categoryGroupLabel(cat), bold: true }], 18, 0);
    const list = byCategory[cat].sort(function (a, b) { return (a.entity.name || '').localeCompare(b.entity.name || ''); });
    for (const pe of list) {
      y += 10;
      ensureRoom(20);
      tocEntries.push({ label: pe.entity.name, page: doc.internal.getCurrentPageInfo().pageNumber, indent: 14, bold: false });
      const nameRuns = [{ text: pe.entity.name, bold: true }];
      if (pe.entitySecret) nameRuns.push({ text: '  ' + secretTagText(secretCharacterName).trim(), bold: true, color: SECRET_COLOR_RGB });
      renderRuns(nameRuns, 14, 0);
      if (pe.statBlockMd) blocksFromMarkdown(pe.statBlockMd, marked).forEach(renderBlock);
      if (pe.loreContent.length) {
        sectionHeading('Lore');
        pe.loreContent.forEach(renderItem);
      }
      const imgs = imagesByEntity[pe.entity.id] || [];
      if (imgs.length) {
        // Pre-decode the first image so its height is known, then
        // ensureRoom for heading+image together -- keeps "Gallery"
        // from landing alone at the bottom of a page.
        let firstPng = null;
        try { firstPng = await imageToPngBytes(imgs[0].data); } catch (e) { /* falls through to renderImage's own error handling */ }
        if (firstPng) {
          const estH = Math.min(260, firstPng.height * Math.min(1, maxWidth / firstPng.width));
          y += 8;
          ensureRoom(18 + estH);
          renderRuns([{ text: 'Gallery', bold: true }], 12, 0);
          placeDecodedImage(firstPng, !!imgs[0].secret);
        } else {
          sectionHeading('Gallery');
          await renderImage(imgs[0]);
        }
        for (let i = 1; i < imgs.length; i++) await renderImage(imgs[i]);
      }
      if (pe.noteContent.length) {
        sectionHeading('Notes');
        pe.noteContent.forEach(renderItem);
      }
    }
  }

  doc.addPage();
  y = margin;
  doc.setDrawColor(180);
  doc.line(margin, y, pageWidth - margin, y);
  y += 14;
  renderRuns(warningText.split('\n').map(function (line) { return { text: line, italic: true }; }).reduce(function (acc, r) {
    acc.push(r, { text: '\n' });
    return acc;
  }, []), 9, 0);

  // Draw the reserved ToC page last, now that every entity's page
  // number is known. Line height shrinks to whatever fits in one page
  // rather than inserting pages (which would shift the numbers above).
  doc.setPage(1);
  y = margin;
  renderRuns([{ text: 'Contents', bold: true }], 20, 0);
  y += 8;
  const availableH = pageHeight - margin - y;
  const lineH = Math.max(9, Math.min(16, availableH / Math.max(1, tocEntries.length)));
  tocEntries.forEach(function (e) {
    const size = e.bold ? Math.min(12, lineH * 0.85) : Math.min(10, lineH * 0.75);
    doc.setFont('helvetica', e.bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.text(e.label, margin + e.indent, y);
    const pageLabel = String(e.page);
    doc.text(pageLabel, pageWidth - margin - doc.getTextWidth(pageLabel), y);
    y += lineH;
  });

  // Footer page numbers on every page, now that the final count (ToC +
  // body + warning) is known.
  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(120, 120, 120);
    doc.text(String(p), pageWidth / 2, pageHeight - 26, { align: 'center' });
    doc.setTextColor(0, 0, 0);
  }

  return doc.output('blob');
}

export {
  fetchImagesForEntities, blocksFromMarkdown, toBulletListMd, buildSourcesWarning,
  buildMarkdownDocument, buildDocxBlob, buildPdfBlob
};
