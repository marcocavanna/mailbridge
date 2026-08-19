# Git

Conventional commits, in English, imperative present tense.

```
feat(imap): add connection pool with per-account limits
fix(search): escape notmuch query operators in subject terms
docs(rules): record the untrusted-input model
```

Scopes in use: `imap`, `smtp`, `search`, `mirror`, `schedule`, `tools`, `cli`, `config`, `secrets`,
`rules`, `deps`.

## Nothing leaves the machine unasked

`git push` is not run unless it is asked for, and "commit this" is not "push this". No tags, no releases,
no publishing on anyone's own initiative.

## What never enters the repository

- a real `accounts.json` (only `accounts.example.json` is versioned)
- anything under `~/Mail/`
- `.eml` files taken from real mail
- debug output containing real addresses or message bodies
