import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { htmlToText } from './html-text.js';

import { logger } from '#shared/logger';

/* --------
 * Constants
 * -------- */

const COMMAND_TIMEOUT_MS = 30_000;

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** `textutil` is part of macOS: it reads doc, docx, rtf, odt and html without any extra dependency. */
const TEXTUTIL_BIN = '/usr/bin/textutil';

const UNZIP_BIN = '/usr/bin/unzip';

const execFileAsync = promisify(execFile);

/* --------
 * Types
 * -------- */

export type ExtractionMethod =
  | 'plain'
  | 'html'
  | 'pdf'
  | 'textutil'
  | 'spreadsheet'
  | 'unsupported';

export interface ExtractedText {
  method: ExtractionMethod;
  /** `undefined` when this content type cannot be turned into text. */
  text: string | undefined;
  /** Why extraction produced nothing, when it did not. */
  note: string | undefined;
}

/* --------
 * Helpers
 * -------- */

/**
 * Runs an operation with the attachment written to a private temporary file, removed afterwards.
 *
 * Some converters only read from a path, not from a stream. The directory is created with `mkdtemp`, so
 * it is unique and not world-readable, and it is removed in `finally` — an attachment extracted in order
 * to be read must not be left behind. See `.claude/rules/security.md` §5.
 */
async function withTemporaryFile<T>(
  content: Buffer,
  filename: string,
  operation: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'mailbridge-attachment-'));
  const path = join(directory, filename);

  try {
    await writeFile(path, content, { mode: 0o600 });

    return await operation(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Extracts a PDF's text.
 *
 * Uses a pure JavaScript reader rather than `pdftotext`: it needs no system package, so it also works
 * for anybody who clones this repository, and it does not break when a Homebrew formula loses a shared
 * library — which is precisely what had happened on the machine this was written on.
 */
async function extractPdf(content: Buffer): Promise<ExtractedText> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const document = await getDocumentProxy(new Uint8Array(content));
    const { text, totalPages } = await extractText(document, { mergePages: true });
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return {
        method: 'pdf',
        text:   undefined,
        note:   `${totalPages} pages with no extractable text: it is probably a scan, which would need OCR.`,
      };
    }

    return { method: 'pdf', text: trimmed, note: `${totalPages} pages` };
  } catch (cause) {
    logger.warn('PDF extraction failed', { error: cause });

    return { method: 'pdf', text: undefined, note: 'The PDF could not be read: it may be encrypted or malformed.' };
  }
}

/**
 * Extracts text through macOS `textutil`, which handles doc, docx, rtf and odt.
 */
async function extractWithTextutil(content: Buffer, filename: string): Promise<ExtractedText> {
  try {
    const stdout = await withTemporaryFile(content, filename, async (path) => {
      const result = await execFileAsync(TEXTUTIL_BIN, ['-convert', 'txt', '-stdout', path], {
        timeout:   COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      });

      return result.stdout;
    });

    const trimmed = stdout.trim();

    return trimmed.length === 0
      ? { method: 'textutil', text: undefined, note: 'The document holds no text.' }
      : { method: 'textutil', text: trimmed, note: undefined };
  } catch (cause) {
    logger.warn('textutil extraction failed', { filename, error: cause });

    return { method: 'textutil', text: undefined, note: 'The document could not be converted.' };
  }
}

/**
 * Extracts the cell values of an `xlsx` workbook.
 *
 * `textutil` does not read spreadsheets, so the file is unzipped and its XML read directly — an `xlsx`
 * is a ZIP archive. Two parts matter: `sharedStrings.xml`, where repeated text is pooled, and each
 * sheet, whose cells reference that pool by index. Reading only the sheets would yield a grid of
 * numbers with every label missing.
 *
 * The output is deliberately rough — values in row order, tab separated — because the point is making
 * the content searchable and readable, not reproducing the layout.
 */
async function extractSpreadsheet(content: Buffer): Promise<ExtractedText> {
  try {
    const rendered = await withTemporaryFile(content, 'workbook.xlsx', async (path) => {
      const readPart = async (part: string): Promise<string> => {
        try {
          const { stdout } = await execFileAsync(UNZIP_BIN, ['-p', path, part], {
            timeout:   COMMAND_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
          });

          return stdout;
        } catch {
          return '';
        }
      };

      // ---- Shared strings: the pool the cells point into
      const sharedXml = await readPart('xl/sharedStrings.xml');
      const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => (
        [...(match[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((text) => text[1] ?? '').join('')
      ));

      // ---- Sheets
      const lines: string[] = [];

      for (let index = 1; index <= 10; index += 1) {
        const sheetXml = await readPart(`xl/worksheets/sheet${index}.xml`);

        if (sheetXml.length === 0) {
          break;
        }

        if (index > 1) {
          lines.push('', `--- sheet ${index} ---`);
        }

        for (const row of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
          const cells: string[] = [];

          for (const cell of (row[1] ?? '').matchAll(/<c[^>]*?(?:\st="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)) {
            const type = cell[1];
            const inner = cell[2] ?? '';
            const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';

            if (type === 's') {
              const position = Number.parseInt(value, 10);

              cells.push(shared[position] ?? '');
              continue;
            }

            if (type === 'inlineStr') {
              cells.push(/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '');
              continue;
            }

            cells.push(value);
          }

          if (cells.some((cell) => cell.length > 0)) {
            lines.push(cells.join('\t'));
          }
        }
      }

      return lines.join('\n');
    });

    const decoded = rendered
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();

    return decoded.length === 0
      ? { method: 'spreadsheet', text: undefined, note: 'The workbook holds no readable cells.' }
      : { method: 'spreadsheet', text: decoded, note: undefined };
  } catch (cause) {
    logger.warn('spreadsheet extraction failed', { error: cause });

    return { method: 'spreadsheet', text: undefined, note: 'The workbook could not be read.' };
  }
}

/* --------
 * Implementation
 * -------- */

/**
 * Turns an attachment into text, when its type allows it.
 *
 * The extracted text is content written by third parties, exactly like a message body: a PDF invoice can
 * carry any instruction its author wants. See `.claude/rules/security.md` §2.
 */
export async function extractAttachmentText(
  content: Buffer,
  contentType: string,
  filename: string | undefined,
): Promise<ExtractedText> {
  const type = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  const name = filename ?? 'attachment';
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();

  // ---- Plain text families
  if (type.startsWith('text/html') || extension === 'html' || extension === 'htm') {
    return { method: 'html', text: htmlToText(content.toString('utf8')), note: undefined };
  }

  if (type.startsWith('text/') || type === 'application/json' || type === 'application/xml') {
    return { method: 'plain', text: content.toString('utf8'), note: undefined };
  }

  // ---- Documents
  if (type === 'application/pdf' || extension === 'pdf') {
    return extractPdf(content);
  }

  const spreadsheetTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ];

  if (spreadsheetTypes.includes(type) || extension === 'xlsx' || extension === 'xls') {
    return extractSpreadsheet(content);
  }

  const textutilTypes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/rtf',
    'text/rtf',
    'application/vnd.oasis.opendocument.text',
  ];

  if (textutilTypes.includes(type) || ['docx', 'doc', 'rtf', 'odt'].includes(extension ?? '')) {
    return extractWithTextutil(content, name);
  }

  /*
   * `application/octet-stream` is what many clients send when they do not know better, so the extension
   * gets a second chance above. Reaching here means neither the type nor the name suggested anything.
   */
  return {
    method: 'unsupported',
    text:   undefined,
    note:   `No text extractor for ${type || 'unknown type'}${extension === undefined ? '' : ` (.${extension})`}.`,
  };
}
