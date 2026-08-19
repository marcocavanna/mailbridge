# Testing

Vitest. Test what earns its place; do not pad for coverage.

## What gets tested

- **Parsing and mapping**: MIME → our message model. This is where the data is dirty and the bugs are
  silent: encodings, repeated headers, unnamed attachments, malformed dates.
- **Query construction**: the translation from tool input to a `notmuch` query and to `IMAP SEARCH`
  criteria. Tested on the produced string, with no network.
- **Schema validation**: that malformed input is rejected at the boundary, not halfway through.
- **Log redaction**: that a credential never reaches the output. It is a security test, and it stays even
  though it looks trivial.
- **Configuration mutations**: add, rename, remove — including removing the **last** account, which is the
  case that already broke once (the schema demanded `min(1)`).
- **That no password ever reaches `accounts.json`**, not even one smuggled into the input object.
- **CLI rendering**: column alignment in the presence of ANSI codes, and the scales of `formatBytes` /
  `formatAge`. These are the places where a mistake fails nothing and simply produces wrong numbers in
  front of somebody making a decision.
- **The sync lock**: that it is released even on error, that it refuses a concurrent sync, and that it
  recognizes a lock abandoned by a dead process. A held lock blocks every later sync, and the only way out
  would be deleting a file by hand.
- **Header parsing**: folded headers (RFC 5322 §2.2.3), repeated names, the empty line that ends the
  block. `List-Unsubscribe` is long by nature and therefore usually folded, so a line-by-line split
  would silently truncate exactly the header that matters most.
- **Bulk mail recognition**: that a personal message merely *mentioning* newsletters is not classified
  as bulk. Getting this wrong would file real correspondence when somebody asks to archive newsletters.
- **The bulk cap**: that it is enforced, counted after deduplication, and that the message reaching the
  model carries the limit and the way out — asserted on `toAgentMessage()`, not on `message` alone,
  since the number lives in `remediation`.
- **HTML conversion**: that `style` and `script` are dropped, entities decoded, and **tables rendered as
  tables**. That last one is not cosmetic: the library flattens them by default, and an invoice arriving
  as a two-column table becomes `a1b2` — information destroyed rather than formatted badly.
- **Attachment routing**: that the content type picks the right extractor, and that the file extension is
  the fallback when the type is `application/octet-stream`. That type was the second most common in the
  corpus, so the fallback is what makes those attachments readable at all.
- **Path parsing in the mirror**: recovering a folder from a Maildir filename, nested folders included.
- **Header casing**: notmuch returns capitalized header names, IMAP fetches return them lowercase.
  Matching one casing only would classify every newsletter as personal mail.
- **Plist generation**: interval conversion, XML escaping, and the presence of the values whose absence
  would make the agent fail silently (the homebrew PATH, `--quiet`, the log level). The generated plist is
  also validated with `plutil -lint`, which is the real judge.

## What does not get tested

No test against a real IMAP server in the suite. Connections are mocked at the pool boundary. A test that
needs the network, a live mailbox or a secret in the Keychain does not belong in `pnpm test`.

No test on tool wiring whose only assertion is that a mock was called.

## Queries are verified against the real engine

Search queries are tested on the **produced string**, but the expected string has to be verified against a
real `notmuch` first, not deduced from the documentation. The precedent: the first version used
`folder:"<account>/**"`, which is syntactically valid and returns **zero results** without signalling
anything, because `folder:` is a boolean term and ignores wildcards.

A test that freezes a query nobody ever ran freezes the bug.

## Fixtures

Sample messages in `tests/fixtures/*.eml`, real and ugly — with accents, repeated headers, attachments. A
clean invented fixture proves nothing. The fixture's non-English content is deliberate and must not be
"cleaned up": encoded-words and accented characters are what it exists to test.

**No fixture contains real mail.** Senders and addresses are fictional.
