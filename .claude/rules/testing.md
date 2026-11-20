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
- **Version comparison**: that `1.10.0` ranks above `1.2.0`. A string comparison gets this backwards and
  would tell users on the newer version to downgrade.
- **The update check opt-out**: that both the project variable and the conventional `NO_UPDATE_NOTIFIER`
  are honoured, and that CI stays quiet.
- **Plist generation**: interval conversion, XML escaping, and the presence of the values whose absence
  would make the agent fail silently (the homebrew PATH, `--quiet`, the log level). The generated plist is
  also validated with `plutil -lint`, which is the real judge.

- **OAuth**: the PKCE challenge against the RFC 7636 example; the authorization URL (tenant, scopes,
  and the absence of anything that sends); the token requests carrying no client secret; the mapping of
  token endpoint errors to "sign in again" or "an administrator must consent", on the description shape
  measured against the real endpoint; the refresh token rotation being stored; one refresh shared by
  concurrent callers; tokens registered for redaction; and the sign-in round trip through a **real**
  loopback listener, with the browser and the token endpoint replaced, including a forged `state`
  refused before any code is redeemed and the port released afterwards.
- **Engine choice per account**: an account without a mirror does not take the index away from the
  others (`mixed`); a never synced mirror, or one lacking the folder, goes to the server alone; the
  notmuch query is scoped to the mirrored accounts, never the whole database (verified against notmuch);
  and an IMAP search without a folder visits every selectable folder, reports a failing one without
  sinking the others, and keeps the limit across folders.
- **The schema boundary for OAuth**: SMTP refused on an OAuth account, multi-tenant aliases refused, and
  `password` as the default so older configurations keep their meaning.
- **The mirror tunnel**, against a fake Exchange on loopback: XOAUTH2 in the documented shape, `PREAUTH`
  as the first thing mbsync reads, with the server's capabilities, bytes piped both ways until LOGOUT,
  no token on the output, an upstream refusal turned into `BYE` with the reason, and no connection at all
  without a token. The generated `mbsyncrc` runs the tunnel with absolute paths, holds no host, user or
  password for an OAuth account, and refuses a path that would need shell escaping.
- **A message held by two mirrors** (a mailbox moved to a new server, old mirror still on disk) is
  attributed to the copy of the account in scope, and dropped when no copy is in scope: notmuch keeps one
  message per `Message-Id`, and the first file it lists can belong to the wrong mirror.
- **Moving an account to another server**: the new configuration saved, the old mirror moved outside the
  mail root and never deleted, the sync history cleared even with no mirror on disk; and **nothing
  changed at all** while a sync holds the lock or when the destination already exists.
- **The sync lock is exclusive**: created with `wx`, so of two acquisitions only one passes; a live lock
  survives past one hour, because a first sync on several accounts legitimately runs that long.
- **A half-filled mirror stays out of the index**: a mirror whose only runs failed is searched on the
  server, and the last success survives a later failure. Older state files are read by their outcome.

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
