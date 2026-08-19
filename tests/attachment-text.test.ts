import { describe, expect, it } from 'vitest';

import { extractAttachmentText } from '#content/attachment-text';

/* --------
 * Routing by type
 * -------- */

describe('extractAttachmentText', () => {
  it('reads plain text as-is', async () => {
    const result = await extractAttachmentText(Buffer.from('line one\nline two'), 'text/plain', 'notes.txt');

    expect(result.method).toBe('plain');
    expect(result.text).toBe('line one\nline two');
  });

  it('converts an HTML attachment rather than dumping markup', async () => {
    const result = await extractAttachmentText(Buffer.from('<p>Hello <b>there</b></p>'), 'text/html', 'page.html');

    expect(result.method).toBe('html');
    expect(result.text).toBe('Hello there');
  });

  it('handles a content type carrying a charset parameter', async () => {
    const result = await extractAttachmentText(Buffer.from('ok'), 'text/plain; charset="utf-8"', 'a.txt');

    expect(result.method).toBe('plain');
  });

  /*
   * Many clients send `application/octet-stream` when they do not know the type — it was the second most
   * common attachment type in the corpus this was built against. Falling back to the extension is what
   * makes those readable instead of "binary content".
   */
  it('falls back to the file extension when the type is octet-stream', async () => {
    const result = await extractAttachmentText(Buffer.from('%PDF-1.4 broken'), 'application/octet-stream', 'invoice.pdf');

    expect(result.method).toBe('pdf');
  });

  it('routes a docx by extension even with a generic type', async () => {
    const result = await extractAttachmentText(Buffer.from('not really a docx'), 'application/octet-stream', 'contract.docx');

    expect(result.method).toBe('textutil');
  });

  it('says what it cannot do instead of returning nothing silently', async () => {
    const result = await extractAttachmentText(Buffer.from([0, 1, 2, 3]), 'image/png', 'photo.png');

    expect(result.method).toBe('unsupported');
    expect(result.text).toBeUndefined();
    expect(result.note).toContain('image/png');
  });

  it('reports a malformed PDF as unreadable rather than throwing', async () => {
    const result = await extractAttachmentText(Buffer.from('this is not a pdf'), 'application/pdf', 'broken.pdf');

    expect(result.text).toBeUndefined();
    expect(result.note).toBeDefined();
  });
});
