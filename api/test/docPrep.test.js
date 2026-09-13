'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { prepareDocument } from '../src/lib/docPrep.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const DOCX_MIMETYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIMETYPE = 'application/pdf';

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name));
}

describe('prepareDocument - PDF path', () => {
  it('MKT301 (Mkt 301 03 Online Fall 26 Syllabus RYAN.pdf): returns pdf_document with correct page count and no warnings', async () => {
    const buffer = loadFixture('MKT301_syllabus.pdf');
    const result = await prepareDocument(buffer, PDF_MIMETYPE);

    expect(result.kind).toBe('pdf_document');
    expect(result.pageCount).toBe(12);
    expect(result.warnings).toEqual([]);

    expect(typeof result.payload).toBe('string');
    expect(() => Buffer.from(result.payload, 'base64')).not.toThrow();
    // Round-tripping the base64 payload must reproduce the original bytes.
    const decoded = Buffer.from(result.payload, 'base64');
    expect(decoded.equals(buffer)).toBe(true);
  });

  it('QMX210 (Syllabus QMX.pdf): returns pdf_document with correct page count and no warnings', async () => {
    const buffer = loadFixture('QMX210_syllabus.pdf');
    const result = await prepareDocument(buffer, PDF_MIMETYPE);

    expect(result.kind).toBe('pdf_document');
    expect(result.pageCount).toBe(7);
    expect(result.warnings).toEqual([]);

    expect(typeof result.payload).toBe('string');
    expect(() => Buffer.from(result.payload, 'base64')).not.toThrow();
    const decoded = Buffer.from(result.payload, 'base64');
    expect(decoded.equals(buffer)).toBe(true);
  });
});

describe('prepareDocument - DOCX path', () => {
  it('PHIL104 (Fall 26, Intro Ethics.docx): the 10/26 row and the Midterm Exam entry survive as one table row', async () => {
    const buffer = loadFixture('PHIL104_syllabus.docx');
    const result = await prepareDocument(buffer, DOCX_MIMETYPE);

    expect(result.kind).toBe('markdown');
    expect(result.pageCount).toBeNull();
    expect(result.warnings).toEqual([]);

    // Find the markdown table row containing "10/26" and assert the
    // Midterm Exam entry is present in that same row/line, not scattered
    // onto a different row by naive tag-stripping.
    const lines = result.payload.split('\n');
    const row = lines.find((line) => line.includes('10/26'));

    expect(row).toBeDefined();
    expect(row).toMatch(/^\|.*\|.*\|.*\|$/); // a 3-column pipe table row
    expect(row).toContain('Midterm Exam');
  });

  it('ACCT201 (ACCT 201 Syllabus Fall 2026.docx): the Week 6 / Oct 5 - Oct 9 row and Exam 1 survive as one table row', async () => {
    const buffer = loadFixture('ACCT201_syllabus.docx');
    const result = await prepareDocument(buffer, DOCX_MIMETYPE);

    expect(result.kind).toBe('markdown');
    expect(result.pageCount).toBeNull();
    expect(result.warnings).toEqual([]);

    // The real document's schedule table renders this week's date range in
    // one cell as "Week 6 Oct 5 – Oct 9" (en dash, no comma) - verified
    // against the actual converted output, not assumed.
    const lines = result.payload.split('\n');
    const row = lines.find((line) => line.includes('Week 6 Oct 5'));

    expect(row).toBeDefined();
    expect(row).toContain('Week 6 Oct 5 – Oct 9');
    expect(row).toMatch(/^\|.*\|.*\|.*\|$/); // a 3-column pipe table row
    expect(row).toContain('Exam 1');
  });

  it('MGT301 (1. Syllabus ALL MGt 301 FL 2026 (1).docx): a real schedule line keeps its week label, date, and assignment title together', async () => {
    const buffer = loadFixture('MGT301_syllabus.docx');
    const result = await prepareDocument(buffer, DOCX_MIMETYPE);

    expect(result.kind).toBe('markdown');
    expect(result.pageCount).toBeNull();
    expect(result.warnings).toEqual([]);

    // NOTE: in this particular source document, the weekly schedule is
    // authored as plain paragraphs, not a Word table (verified by
    // inspecting word/document.xml - the file contains exactly one
    // <w:tbl>, and it is the "Program Learning Goals" table, not the
    // schedule). So there is no table row to assert on for the schedule
    // itself; what matters is that mammoth + turndown preserve paragraph
    // order faithfully (no naive extraction scrambling week/date/
    // assignment onto different lines). We assert on a real schedule line
    // that contains a week label, a date token, and an assignment title
    // together, exactly as authored.
    expect(result.payload).toContain(
      'Week 4 Mon-Tue Chapt. 2. History of Management / **Tariff P-Point & Outline due 9/20**'
    );

    // The one real table in this document (Program Learning Goals) must
    // still convert to a genuine Markdown table.
    const lines = result.payload.split('\n');
    const headerRow = lines.find((line) =>
      line.includes('Program Learning Goals')
    );
    expect(headerRow).toBeDefined();
    expect(headerRow).toMatch(/^\|.*\|.*\|.*\|.*\|$/);
  });
});

describe('prepareDocument - rejection paths', () => {
  it('throws a clear error for an unsupported mimetype', async () => {
    const buffer = Buffer.from('not a real document');

    await expect(prepareDocument(buffer, 'text/plain')).rejects.toThrow(
      /Unsupported mimetype/
    );
  });

  it('throws a clear error for a PDF over the 32MB size limit', async () => {
    // Synthesize an oversize buffer rather than shipping a 32MB+ fixture.
    const oversizeBuffer = Buffer.alloc(33 * 1024 * 1024, 0);

    await expect(
      prepareDocument(oversizeBuffer, PDF_MIMETYPE)
    ).rejects.toThrow(/32MB/);
  });
});
