'use strict';

/**
 * Document-preparation layer for Kevin Study OS.
 *
 * Converts an uploaded syllabus (PDF or DOCX) into the highest-fidelity
 * input Claude can consume for downstream extraction. This module does
 * pure input transformation only: no AI calls, no DB writes, no routes.
 *
 * PDF strategy (deliberate, not a placeholder):
 *   Two of the real target syllabi use multi-column layouts where naive
 *   text extraction interleaves unrelated dates/labels onto the same line
 *   (columns get flattened out of order). Instead of running any
 *   text-extraction library on the PDF, we base64-encode the raw bytes so
 *   the caller can send the file to Claude as a native PDF document block.
 *   Claude's own document vision handles multi-column layout far better
 *   than any text-extraction heuristic we could write here. `pdf-lib` is
 *   used ONLY to read the page count (structural metadata) - it never
 *   extracts or touches text content.
 *
 * DOCX strategy:
 *   Schedule tables must survive conversion with rows intact - stripping
 *   <w:t> tags naively loses which date goes with which assignment. We
 *   convert DOCX -> HTML via mammoth (tables preserved as <table>/<tr>/<td>)
 *   then HTML -> Markdown via turndown with a custom table rule (see
 *   addTableRules below) that renders tables using pipe syntax with a
 *   header separator row. Embedded images are dropped during the mammoth
 *   pass (no OCR/image extraction is in scope, and inlining raw base64
 *   image bytes as Markdown text would bloat the payload with data that
 *   is useless for schedule/assignment extraction).
 */

const mammoth = require('mammoth');
const TurndownService = require('turndown');
const {
  highlightedCodeBlock,
  strikethrough,
  taskListItems,
} = require('turndown-plugin-gfm');
const { PDFDocument } = require('pdf-lib');

const PDF_MIMETYPE = 'application/pdf';
const DOCX_MIMETYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const SUPPORTED_MIMETYPES = new Set([PDF_MIMETYPE, DOCX_MIMETYPE]);

// Practical Claude document limits.
const MAX_PDF_PAGES = 100;
const MAX_PDF_BYTES = 32 * 1024 * 1024; // 32MB

/**
 * @param {Buffer} buffer - raw file bytes
 * @param {string} mimetype - the uploaded file's mimetype
 * @returns {Promise<{kind: 'pdf_document'|'markdown', payload: string, pageCount: number|null, warnings: string[]}>}
 */
async function prepareDocument(buffer, mimetype) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(
      `prepareDocument: expected a Buffer for "buffer", got ${typeof buffer}`
    );
  }

  if (!SUPPORTED_MIMETYPES.has(mimetype)) {
    throw new Error(
      `Unsupported mimetype "${mimetype}". Supported types: ${[
        ...SUPPORTED_MIMETYPES,
      ].join(', ')}`
    );
  }

  if (mimetype === PDF_MIMETYPE) {
    return preparePdf(buffer);
  }

  return prepareDocx(buffer);
}

async function preparePdf(buffer) {
  const warnings = [];

  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(
      `PDF exceeds the 32MB document limit (got ${(
        buffer.length /
        (1024 * 1024)
      ).toFixed(2)}MB). Cannot send as a native document block.`
    );
  }

  let pageCount;
  try {
    // updateMetadata: false - we only read structure, never mutate/extract text.
    const pdfDoc = await PDFDocument.load(buffer, { updateMetadata: false });
    pageCount = pdfDoc.getPageCount();
  } catch (err) {
    throw new Error(`Failed to read PDF structure: ${err.message}`);
  }

  if (pageCount > MAX_PDF_PAGES) {
    throw new Error(
      `PDF exceeds the 100-page document limit (got ${pageCount} pages). Cannot send as a native document block.`
    );
  }

  const payload = buffer.toString('base64');

  return { kind: 'pdf_document', payload, pageCount, warnings };
}

async function prepareDocx(buffer) {
  const warnings = [];

  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      // Drop embedded images (produces <img> with no src) instead of
      // inlining them as base64 data URIs - see module doc comment above.
      // mammoth.convertToHtml(input, options) takes conversion options as
      // a separate second argument, not merged into the input object.
      convertImage: mammoth.images.imgElement(() => ({})),
    }
  );

  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  turndownService.use([highlightedCodeBlock, strikethrough, taskListItems]);
  turndownService.addRule('dropImages', {
    filter: 'img',
    replacement: function () {
      return '';
    },
  });
  addTableRules(turndownService);

  const markdown = turndownService.turndown(html);

  if (!/\|.*\|/.test(markdown)) {
    warnings.push(
      'No Markdown table detected in the converted output - unusual for a syllabus, which typically contains a schedule table.'
    );
  }

  return { kind: 'markdown', payload: markdown, pageCount: null, warnings };
}

/**
 * Custom GFM-style table rules for turndown.
 *
 * mammoth converts DOCX table rows to plain <td> cells (it does not mark
 * the first row as <th> unless the source document used Word's "header
 * row" table style), so turndown-plugin-gfm's built-in table rule - which
 * only converts tables that already have a heading row of <th> cells -
 * falls back to leaving the whole <table> as raw HTML. That would defeat
 * the point of this module (Markdown table syntax, not flattened/kept
 * HTML), so we treat the first row of every table as the header row and
 * render every table using pipe syntax with a header separator, joining
 * multi-paragraph cell content with <br> so each row stays on one line.
 */
function addTableRules(turndownService) {
  turndownService.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: function (content, node) {
      return renderCell(content, node);
    },
  });

  turndownService.addRule('tableRow', {
    filter: 'tr',
    replacement: function (content, node) {
      let output = '\n' + content;
      if (isHeaderRow(node)) {
        let separator = '';
        for (let i = 0; i < node.childNodes.length; i++) {
          separator += renderCell('---', node.childNodes[i]);
        }
        output += '\n' + separator;
      }
      return output;
    },
  });

  turndownService.addRule('table', {
    filter: 'table',
    replacement: function (content) {
      content = content.replace(/\n\n/g, '\n');
      return '\n\n' + content + '\n\n';
    },
  });

  turndownService.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: function (content) {
      return content;
    },
  });
}

function renderCell(content, node) {
  content = content.trim().replace(/\n+/g, '<br>').replace(/\|/g, '\\|');
  const siblings = Array.prototype.slice.call(node.parentNode.childNodes);
  const index = siblings.indexOf(node);
  const prefix = index === 0 ? '| ' : ' ';
  return prefix + content + ' |';
}

function isHeaderRow(tr) {
  const parent = tr.parentNode;
  if (parent.nodeName === 'THEAD') return true;
  if (parent.nodeName === 'TABLE') return parent.firstChild === tr;
  if (parent.nodeName === 'TBODY') {
    const prevSibling = parent.previousSibling;
    const isFirstTbody =
      !prevSibling ||
      (prevSibling.nodeName === 'THEAD' && /^\s*$/.test(prevSibling.textContent));
    return isFirstTbody && parent.firstChild === tr;
  }
  return false;
}

module.exports = { prepareDocument, SUPPORTED_MIMETYPES, MAX_PDF_BYTES };
