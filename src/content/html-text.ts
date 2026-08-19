import { convert } from 'html-to-text';

/* --------
 * Constants
 * -------- */

/**
 * Width the text is wrapped to. `null` would keep every paragraph on one endless line, which reads
 * badly and wastes context; 100 columns matches how mail is normally written.
 */
const WRAP_COLUMNS = 100;

/* --------
 * Implementation
 * -------- */

/**
 * Converts an HTML message body into readable plain text.
 *
 * Around 8% of real mail carries no `text/plain` part at all — commercial mail especially — and for
 * those messages the alternative to converting is telling the reader there is no body, which is false.
 *
 * The conversion is deliberately opinionated:
 *
 * - links keep their target in brackets, because in mail the destination is often the point;
 * - images are dropped rather than replaced by their alt text, which in bulk mail is usually a tracking
 *   pixel or a filename;
 * - `style` and `script` contents are skipped, or the output fills with CSS;
 * - **tables are rendered as tables.** The library flattens them by default, turning a two-column
 *   invoice into `a1b2`: readable output has to be asked for explicitly, and invoices, order
 *   confirmations and reports are exactly the mail that arrives as a table.
 */
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: WRAP_COLUMNS,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'table', format: 'dataTable' },
    ],
  }).trim();
}

/**
 * Picks the best readable body out of what a message actually provides.
 *
 * Prefers a real `text/plain` part: it is what the sender wrote, without a conversion in between. Falls
 * back to converting the HTML, and reports which path was taken so the caller can say so rather than
 * passing a derived body off as the original.
 */
export function resolveReadableBody(
  text: string | undefined,
  html: string | undefined,
): { body: string | undefined; source: 'text' | 'converted-html' | 'none' } {
  if (text !== undefined && text.trim().length > 0) {
    return { body: text, source: 'text' };
  }

  if (html !== undefined && html.trim().length > 0) {
    const converted = htmlToText(html);

    if (converted.length > 0) {
      return { body: converted, source: 'converted-html' };
    }
  }

  return { body: undefined, source: 'none' };
}
