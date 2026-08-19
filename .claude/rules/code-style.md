# Coding style

## TypeScript

Full strict mode, no exceptions: `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`,
`exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`.

- **Never `enum`**: `as const` or a union of string literals.
- **Never `any`** on public signatures. Where it is unavoidable — MIME parsing, raw IMAP responses —
  use `unknown` and narrow explicitly at the entry point, never propagate it inwards.
- **Explicit return type** on every exported function.
- Types **derived from schemas**, not rewritten by hand: `z.infer<typeof xxxSchema>`.
- No default export in modules with more than one export.
- Path aliases always: no `../../..`. The prefix here is `#`, see below.
- `interface` for object shapes used as options or config; `type` for unions and compositions.

## Formatting

Single quotes always. Trailing commas in multi-line literals. **Object properties aligned vertically
from three entries up.** Arrow function bodies always wrapped in parentheses on return.

Naming: `kebab-case` for every file. Role suffixes through dot notation — `.types.ts`, `.schema.ts`,
`.constants.ts`, `.tool.ts`. Booleans `isXxx` / `hasXxx` / `withXxx`.

## Imports

Groups separated by one blank line, no blank line inside a group:

```
node: builtins  →  external libraries  →  internal aliases (#)  →  relative  →  type-only
```

Builtins always with the `node:` prefix (`node:child_process`, not `child_process`).
`import type` for type-only imports.

**Alias `#` rather than `~` — a documented deviation.** The usual convention is `~/`, which presupposes a
bundler or a loader that rewrites paths. This package is native ESM executed by Node without a bundler,
and the only alias mechanism Node resolves at runtime is the *subpath imports* field of `package.json`,
which requires the `#` prefix. So `#imap/messages`, not `~/imap/messages`. The spirit of the rule — never
a deep relative import — is intact.

The map lives in `package.json` and points at `dist/`: extend it whenever a new directory appears under
`src/`.

## Language

**English everywhere**: code, comments, user-facing strings, documentation, commit messages.

Two exceptions, both **data rather than prose**, and both marked in place:

- the localized folder names in `src/imap/folders.ts`, which exist to recognize what providers actually
  name their folders;
- the test fixture in `tests/fixtures/`, which deliberately carries accented and encoded-word text
  because that is what it tests.

Translating either would remove the thing that makes it useful.

## Section comments — two levels, mandatory

**File level**, separating the top-level concerns (types, constants, helpers, implementation, exports),
with a blank line before and after:

```ts
/* --------
 * Helpers
 * -------- */
```

**Body level** inside non-trivial functions, with labels reused and never reinvented for the same
concept: `Options Deconstruct`, `Validation`, `Internal State`, `Connection Setup`, `Query Build`,
`Result Mapping`, `Error Handling`, `Cleanup`, `Return`.

They are omitted only in utilities of a few lines with a single logical section.

## Structure

Logic stays out of the tool handlers: `src/tools/*.tool.ts` validates, delegates, formats. A handler
holding a business rule, a hand-built IMAP query or a parser is in the wrong place.

A module past ~300 lines gets split. Boilerplate repeated across modules becomes a shared helper, not a
copy.

Errors: one domain error type in `src/shared/errors.ts`, never `throw new Error('string')` in the
modules. The message aimed at the model says what to do, not only what is broken.

## Versions

Latest stable resolved from the registry at install time, **pinned exactly** (`save-exact`). Never a
number written by hand, never copied from another project. A constraint forcing a non-latest version has
to be written down here with the reason.

Constraints in force: none.

## Asynchrony

`async`/`await`, no `.then()` chains. Every network operation has an explicit timeout and releases its
connection in `finally`. IMAP connections go through the pool: no module opens one on its own.

## CLI

One entry, `src/cli/main.ts`, with two modes over the same logic:

- **interactive** when there are no arguments — a menu built with `@clack/prompts`
- **non-interactive** through the subcommands — the form `launchd`, scripts and CI use

Both modes call the same functions in `*-actions.ts`. Behaviour that only exists in the menu is behaviour
nobody can automate; behaviour that only exists in the flags is behaviour nobody will find.

Binding rules:

- A cancelled prompt travels up as `CancelledError` and exits with 130. `isCancel` is not checked on every
  line: `required()` in `prompt-helpers.ts` handles it.
- Every long operation goes through `withSpinner`, which closes the spinner **even** on error. A spinner
  left open makes clack print a spurious "Canceled" after the real error message.
- The spinner reports success only when the outcome is good: use `outcome` to separate "completed" from
  "completed with problems".
- The `outro` reflects `process.exitCode`. Closing with "Done." while exiting non-zero is a lie.
- Rendering lives in `ui.ts` and the `*-view.ts` files. Column widths are measured on text **stripped of
  ANSI**: colour sequences count towards `length` but occupy zero columns.
- An unavailable value prints as `n/a`, and a state never reached prints as what it is (`never`). Do not
  fake a zero.

## Publishing

The package is published to npm, so three things are load-bearing:

- `files` is a **whitelist**. Anything not listed is not published, which is the safe default for a
  project whose working directory holds a real `accounts.json`.
- `build` cleans `dist/` first. Without it, a module that gets renamed or split leaves its old compiled
  file behind, and that dead file ships to users.
- `prepublishOnly` runs typecheck, tests and build. A broken publish cannot be taken back, only
  superseded.
- `os: ["darwin"]` is declared, because the Keychain, `launchd` and `textutil` are not portable.

### The update check

The CLI asks the npm registry whether a newer version exists, at most once a day, and reports it on the way
out. Four constraints shape it, and each one rules out reaching for `update-notifier` off the shelf:

- **Interactive paths only.** Never under `serve`, where stdout carries the MCP protocol, and never under
  `sync --quiet`, whose output is a log file the scheduled agent appends to every few minutes.
- **It never adds latency.** The request starts before the command's real work and is collected after it,
  with a 2s network timeout and a 500ms wait at the end. If the answer is late, the command finishes
  silently and the cache lands for next time.
- **Silence is the default on every failure.** Offline, DNS failure, timeout, or a 404 because the package
  is not published under this name — none of them are worth a warning.
- **It is reversible.** It honours `MAILBRIDGE_NO_UPDATE_CHECK`, the conventional `NO_UPDATE_NOTIFIER`, and
  stays quiet in CI. A program that reads mail and calls a third party unasked has to let the user say no.

The upgrade instruction adapts to how the copy was installed: telling somebody who cloned the repository to
run `npm install -g` would install a second copy beside their checkout.

**Two channels, two audiences.** The CLI notice reaches whoever runs commands in a terminal. Most people
only ever use mailbridge through an MCP client and would never see it, so the notice is also appended to
the server's `instructions` at handshake time — read from cache **synchronously**, because the handshake
cannot await. A cold cache says nothing and the next session says it, which is the right trade for never
delaying a connection.

**There is no tool that performs the upgrade**, and that is a deliberate departure from comparable servers.
This one reads untrusted mail: a tool that runs `npm install -g` would put package installation one step
away from content an attacker controls, and "the user consented" is thin cover when the request to upgrade
could itself have been planted in an email. `update_status` reports the command; running it stays with the
person at the keyboard.

`dismiss_update` has to be honoured by **both** channels, since they read the same state. A suppression that
leaked into the handshake would keep announcing an update the user already silenced.

The version has **one** source, `#shared/version`, read from `package.json`. It used to be copied into the
CLI banner, the MCP handshake and the LaunchAgent bundle — three places that drift apart with nothing
noticing.

Optional system tools are checked before use and reported by the formula that provides them — `mbsync`
comes from `isync`, which nobody guesses. See the note on the optional mirror in `CLAUDE.md`.

## Scheduled sync (launchd)

On macOS periodic execution means **launchd**, not cron: cron does not wake the machine, does not catch up
on runs missed while it slept, and starts in an environment where `mbsync` is not on the PATH.

Constraints the plist must always satisfy — each one closes a concrete way of failing silently:

- `EnvironmentVariables.PATH` includes `/opt/homebrew/bin`, or `mbsync` and `notmuch` are not found and
  the error in the logs cannot be traced back to the cause.
- `MAILBRIDGE_LOG_LEVEL=warn`: stderr lands in `sync.error.log`, which has to stay a **signal**. If
  there is something in there, something went wrong.
- `--quiet` among the arguments: the output goes to a file, not to a terminal.
- `RunAtLoad` is `false`: at login the machine has better things to do than download gigabytes of mail.
- Every value that ends up in the XML goes through escaping. An `&` in a path produces a plist launchd
  rejects without saying which character broke it.
- `bootout` before `bootstrap` when reconfiguring: launchd refuses a Label that is already loaded, and
  without unloading it the old interval would stay in force.

The `plist` points at an **absolute** Node path. Under nvm that path contains the version number, and
upgrading Node moves it: `schedule status` checks the binary still exists and says so, because it is the
most likely way this automation breaks.

### The agent launches an app bundle, not Node

`ProgramArguments[0]` points at the executable of `MailbridgeSync.app`, never at the Node binary.

The reason is not technical but about legibility, and it matters: in **System Settings → Login Items →
Allow in the Background** macOS attributes an item to **whoever signs the executable launchd starts**, not
to the LaunchAgent's `Label`. Pointing at the Node binary, the system announces "an item from Node.js
Foundation" — true, and useless to somebody deciding whether to disable it.

The bundle lives under `~/Library/Application Support/mailbridge/`, carries its own `CFBundleName` and
`CFBundleIdentifier`, and is **ad-hoc** signed (`codesign -s -`): no Developer ID is needed, an identity
is. `LSBackgroundOnly` and `LSUIElement` keep macOS from treating it as an app with a UI, complete with a
Dock icon on every run.

Node's path is baked into the bundle's script, not into the plist: `schedule status` reads it back from
there and recognizes an installation made before the bundle existed, telling the user to run `enable`
again.
