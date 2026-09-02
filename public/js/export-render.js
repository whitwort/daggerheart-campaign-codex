// export-render.js — format builders for Admin > Data > Export Lore.
// Shared by export-lore.js (GM admin view) and, per the Phase design
// discussion, a future player-facing reuse of the same export UI.
//
// Pure-ish helpers: everything here takes already-resolved data
// (entities + their ctx-filtered content) and produces a Blob. No
// visibility/canSee logic lives here -- that stays in export-lore.js
// (and ultimately visibility.js), so this module doesn't need to know
// about GM vs player vs character ctx at all.
//
// docx/jsPDF are loaded lazily via esm.sh dynamic import, same pattern
// as marked/DOMPurify in markdown.js and sortablejs elsewhere -- a CDN
// hiccup only breaks the Word/PDF export path, not the whole app.

import { getFirestore, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from './firebase.js';
import { loadMarkdownModules } from './markdown.js';

const db = getFirestore(firebaseApp);

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
// decode/re-encode before handing it to either builder. Returns a
// Uint8Array of PNG bytes plus the decoded pixel dimensions.
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
          resolve({ bytes: new Uint8Array(buf), width: img.naturalWidth, height: img.naturalHeight });
        }, reject);
      }, 'image/png');
    };
    img.onerror = function () { reject(new Error('Could not decode image')); };
    img.src = dataUrl;
  });
}

// --- Markdown block model ---------------------------------------------
// Parses a markdown string into a flat block list docx/PDF can both
// walk without re-implementing markdown parsing twice. Ordered/unordered
// lists both render as bulleted (no numbering.config plumbing) -- an
// accepted simplification since lore content lists are effectively
// always unordered (Details bullets, Feature entries) in practice.

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

function buildMarkdownDocument(perEntity, warningText) {
  const byCategory = {};
  perEntity.forEach(function (pe) {
    const cat = pe.entity.category || '(uncategorized)';
    (byCategory[cat] = byCategory[cat] || []).push(pe);
  });
  const parts = [];
  Object.keys(byCategory).sort().forEach(function (cat) {
    parts.push('# ' + cat);
    byCategory[cat]
      .sort(function (a, b) { return (a.entity.name || '').localeCompare(b.entity.name || ''); })
      .forEach(function (pe) {
        parts.push('## ' + pe.entity.name);
        if (pe.contentMd) parts.push(pe.contentMd);
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
      return new Paragraph({ heading: headingMap[block.level] || HeadingLevel.HEADING_6, spacing: { before: 200, after: 100 }, children: runs(block) });
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

function buildDocxBlob(perEntity, warningText, imagesByEntity) {
  return loadDocx().then(function (docxMod) {
    const { Document, Packer, Paragraph, HeadingLevel, ImageRun, TextRun } = docxMod;
    const byCategory = {};
    perEntity.forEach(function (pe) {
      const cat = pe.entity.category || '(uncategorized)';
      (byCategory[cat] = byCategory[cat] || []).push(pe);
    });
    const children = [];
    return loadMarkdownModules().then(function (mods) {
      const categories = Object.keys(byCategory).sort();
      let imageChain = Promise.resolve();
      categories.forEach(function (cat) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 150 }, children: [new TextRun(cat)] }));
        byCategory[cat]
          .sort(function (a, b) { return (a.entity.name || '').localeCompare(b.entity.name || ''); })
          .forEach(function (pe) {
            children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 }, children: [new TextRun(pe.entity.name)] }));
            if (pe.contentMd) {
              children.push.apply(children, docxParagraphsFromBlocks(blocksFromMarkdown(pe.contentMd, mods.marked), docxMod));
            }
            const imgs = imagesByEntity[pe.entity.id] || [];
            imgs.forEach(function (img) {
              imageChain = imageChain.then(function () { return imageToPngBytes(img.data); }).then(function (png) {
                const maxW = 400;
                const scale = png.width > maxW ? maxW / png.width : 1;
                children.push(new Paragraph({
                  children: [new ImageRun({ data: png.bytes, transformation: { width: Math.round(png.width * scale), height: Math.round(png.height * scale) }, type: 'png' })]
                }));
              }).catch(function () { /* skip an image that fails to decode */ });
            });
          });
      });
      children.push(new Paragraph({ text: '' }));
      children.push(new Paragraph({ border: { top: { color: 'auto', space: 1, style: 'single', size: 6 } }, text: '' }));
      warningText.split('\n').forEach(function (line) {
        children.push(new Paragraph({ children: [new TextRun({ text: line, italics: true, size: 18 })] }));
      });
      return imageChain.then(function () {
        const doc = new Document({ sections: [{ children: children }] });
        return Packer.toBlob(doc);
      });
    });
  });
}

// --- PDF export --------------------------------------------------------

let jsPdfModulePromise = null;
function loadJsPdf() {
  if (!jsPdfModulePromise) jsPdfModulePromise = import('https://esm.sh/jspdf@2');
  return jsPdfModulePromise;
}

function buildPdfBlob(perEntity, warningText, imagesByEntity) {
  return Promise.all([loadJsPdf(), loadMarkdownModules()]).then(function (mods) {
    const jsPDF = mods[0].jsPDF || mods[0].default;
    const marked = mods[1].marked;
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
      y += lineHeight;
    }

    function renderBlock(block) {
      if (block.type === 'heading') {
        const size = Math.max(11, 20 - (block.level - 1) * 2);
        y += 6;
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

    function renderImage(img) {
      return imageToPngBytes(img.data).then(function (png) {
        const maxW = maxWidth;
        const maxH = 260;
        let w = png.width, h = png.height;
        if (w > maxW) { h = h * (maxW / w); w = maxW; }
        if (h > maxH) { w = w * (maxH / h); h = maxH; }
        ensureRoom(h + 10);
        const dataUrl = 'data:image/png;base64,' + btoa(String.fromCharCode.apply(null, png.bytes));
        doc.addImage(dataUrl, 'PNG', margin, y, w, h);
        y += h + 10;
      }).catch(function () { /* skip an image that fails to decode */ });
    }

    let chain = Promise.resolve();
    const byCategory = {};
    perEntity.forEach(function (pe) {
      const cat = pe.entity.category || '(uncategorized)';
      (byCategory[cat] = byCategory[cat] || []).push(pe);
    });
    Object.keys(byCategory).sort().forEach(function (cat) {
      chain = chain.then(function () {
        ensureRoom(30);
        renderRuns([{ text: cat, bold: true }], 18, 0);
      });
      byCategory[cat]
        .sort(function (a, b) { return (a.entity.name || '').localeCompare(b.entity.name || ''); })
        .forEach(function (pe) {
          chain = chain.then(function () {
            ensureRoom(20);
            renderRuns([{ text: pe.entity.name, bold: true }], 14, 0);
            if (pe.contentMd) blocksFromMarkdown(pe.contentMd, marked).forEach(renderBlock);
          });
          (imagesByEntity[pe.entity.id] || []).forEach(function (img) {
            chain = chain.then(function () { return renderImage(img); });
          });
        });
    });
    chain = chain.then(function () {
      ensureRoom(30);
      doc.setDrawColor(180);
      doc.line(margin, y, pageWidth - margin, y);
      y += 14;
      renderRuns(warningText.split('\n').map(function (line) { return { text: line, italic: true }; }).reduce(function (acc, r) {
        acc.push(r, { text: '\n' });
        return acc;
      }, []), 8, 0);
    });
    return chain.then(function () { return doc.output('blob'); });
  });
}

export {
  fetchImagesForEntities, blocksFromMarkdown, buildSourcesWarning,
  buildMarkdownDocument, buildDocxBlob, buildPdfBlob
};
