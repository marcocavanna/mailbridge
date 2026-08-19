# Glossary

Domain terms mapped to the entities that implement them. This table is binding: a term that cannot be
anchored **gets reported and written here**, never guessed.

| Domain term | Entity in code | Note |
|---|---|---|
| account | `Account` | An IMAP+SMTP pair with its credentials. `accountId` is the slug chosen at setup |
| folder | `Folder` | Full IMAP path, with the server's delimiter. Not "label" |
| special folder | `SpecialFolder` | `inbox` \| `sent` \| `drafts` \| `archive` \| `trash` \| `junk` — a union of literals, not an enum |
| message | `Message` | Our own model, already parsed. Not imapflow's raw object |
| conversation / thread | `Thread` | Grouped by `References`/`In-Reply-To`, or by notmuch thread id |
| draft | `Draft` | A message composed and saved in `drafts`, never sent |
| flag | `MessageFlag` | An IMAP flag (`\Seen`, `\Flagged`, …) plus the server's keywords |
| mirror | `Mirror` | The local Maildir copy. A cache, never the source of truth |
| index | `SearchIndex` | The notmuch database over the mirror |
| sync | `SyncRun` | A single mbsync execution plus the reindex |
| sync lock | — | A file at `~/.config/mailbridge/sync.lock`. Records pid and source (`cli` \| `mcp` \| `schedule`) |
| account state | `AccountOverview` | Configuration + credential + last sync + statistics, in one read |
| mirror statistics | `MirrorStats` | Size on disk and indexed counts. Every measure is optional: `undefined` means "not measurable", rendered as `n/a` |
| connection test | `AccountHealth` | Outcome for credential, IMAP and SMTP. Sends nothing and changes nothing |
| probe | `ProbeResult` | A single test: `ok` \| `failed` \| `skipped` |
| scheduled sync | `AgentStatus` | LaunchAgent state: installed, loaded, cadence, last outcome |
| agent bundle | `MailbridgeSync.app` | An ad-hoc signed app bundle (`com.marcocavanna.mailbridge`) that launchd starts in place of Node, so the system shows a sensible name |

Terms deliberately **not** used, to avoid importing a single provider's vocabulary: "label", "mailbox" in
place of account, "archive" as a verb distinct from moving.
