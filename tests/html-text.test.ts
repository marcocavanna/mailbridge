import { describe, expect, it } from 'vitest';

import { htmlToText, resolveReadableBody } from '#content/html-text';

/* --------
 * htmlToText
 * -------- */

describe('htmlToText', () => {
  it('keeps the text and drops the markup', () => {
    expect(htmlToText('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  /*
   * Without skipping these, the output fills with CSS and JavaScript — which is most of the byte count of
   * a marketing email.
   */
  it('drops style and script contents', () => {
    const html = '<style>.a{color:red}</style><script>alert(1)</script><p>Only this</p>';

    expect(htmlToText(html)).toBe('Only this');
  });

  it('keeps a link target, because in mail the destination is often the point', () => {
    expect(htmlToText('<a href="https://example.com/x">click here</a>')).toContain('https://example.com/x');
  });

  it('does not repeat a link whose text is already the URL', () => {
    const output = htmlToText('<a href="https://example.com">https://example.com</a>');

    expect(output.match(/example\.com/g)).toHaveLength(1);
  });

  it('decodes entities', () => {
    expect(htmlToText('<p>Ricci &amp; Co &lt;tag&gt; &nbsp;caff&egrave;</p>')).toContain('Ricci & Co <tag>');
    expect(htmlToText('<p>caff&egrave;</p>')).toBe('caffè');
  });

  it('turns a table into readable rows rather than one run-on line', () => {
    const html = '<table><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></table>';

    expect(htmlToText(html).split('\n').filter((line) => line.trim().length > 0)).toHaveLength(2);
  });

  it('survives malformed HTML instead of throwing', () => {
    expect(() => htmlToText('<p>unclosed <b>bold')).not.toThrow();
  });
});

/* --------
 * resolveReadableBody
 * -------- */

describe('resolveReadableBody', () => {
  it('prefers a real text part, which is what the sender actually wrote', () => {
    expect(resolveReadableBody('the original', '<p>the html</p>')).toEqual({
      body:   'the original',
      source: 'text',
    });
  });

  /*
   * Roughly 8% of real mail ships HTML only. Reporting "no body" for those would be false, so it is
   * converted — and the provenance is reported rather than passing a conversion off as the original.
   */
  it('converts the HTML when there is no text part, and says so', () => {
    expect(resolveReadableBody(undefined, '<p>only html</p>')).toEqual({
      body:   'only html',
      source: 'converted-html',
    });
  });

  it('treats a whitespace-only text part as absent', () => {
    expect(resolveReadableBody('   \n  ', '<p>real content</p>').source).toBe('converted-html');
  });

  it('reports none when there is nothing at all', () => {
    expect(resolveReadableBody(undefined, undefined)).toEqual({ body: undefined, source: 'none' });
  });

  it('reports none when the HTML holds no text', () => {
    expect(resolveReadableBody(undefined, '<style>.a{color:red}</style>')).toEqual({
      body:   undefined,
      source: 'none',
    });
  });
});
