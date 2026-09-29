# pi-approve

A [Pi](https://github.com/earendil-works/pi) extension that lets you review and approve every code change before it is staged for commit.

## What it does

After the agent edits your files, run `/approve` to walk through each diff hunk interactively. You can accept, reject, or request revisions on a per-hunk basis. Approved changes stay in the working tree but remain **unstaged** — you decide when to `git add` / `git commit`.

## Features

- **Granular approval** — accept or reject one hunk at a time, all hunks in a file, or all changes across the repo
- **Syntax highlighting** — diff hunks are rendered with [Shiki](https://shiki.style/) (the same engine VS Code uses) using the `dark-plus` theme
- **Revision requests** — ask the agent to fix a hunk inline; the review pauses, the agent gets your feedback, and you re-run `/approve` when done
- **Untracked files** — new files are shown as whole-file hunks and can be approved or deleted
- **Per-hunk revert** — rejecting a hunk reverses only that hunk (via a reconstructed single-hunk patch), while `R`/`--reject-all` reset the whole file to the index; staged changes are never touched

## Installation

Install from GitHub:

```bash
pi install git:github.com/maasha/pi-approve
```

Or try it once without adding it to settings:

```bash
pi -e git:github.com/maasha/pi-approve
```

## Usage

### Commands

| Command | Action |
|---|---|
| `/approve` | Start an interactive review of all working-tree changes |
| `/approve <dir>` | Start an interactive review for the repo at `<dir>` |
| `/approve --all` | Approve all changes without reviewing |
| `/approve <dir> --all` | Approve all changes in `<dir>` without reviewing |
| `/approve --reject-all` | Reject all changes (checkout tracked files, delete untracked files) |
| `/approve <dir> --reject-all` | Reject all changes in `<dir>` |

### Interactive review

When you run `/approve`, a modal overlay appears for each diff hunk:

```
╭─────────────────────────────────────────────────────────────────────────╮
│ 📝 src/index.ts                                                         │
│ @@ -45,7 +45,8 @@                                                      │
│                                                                         │
│    import { codeToTokens } from 'shiki'                                 │
│  - const highlighted = codeToTokens(code, { lang: 'typescript' })       │
│  + const { tokens } = await codeToTokens(code, {                        │
│  +   lang,                                                              │
│  +   theme: 'dark-plus',                                                │
│  + })                                                                   │
│    const lines = tokens.map(...)                                        │
│                                                                         │
│ ────────────────────────────────────────────────────────────────────────│
│  [a] accept hunk · [r] reject hunk · [A] accept file · [R] reject file  │
│  [v] revise                                                             │
│  [↑] prev hunk · [↓] next hunk · [←] prev file · [→] next file · [q] quit │
╰─────────────────────────────────────────────────────────────────────────╯
```

| Key | Action |
|---|---|
| `a` | **Accept** this hunk |
| `A` | **Accept all remaining hunks** in this file |
| `r` | **Reject** this hunk — reverses only that hunk on disk (preserving staged changes and the file's other hunks) |
| `R` | **Reject all hunks** in this file (resets it to the index) |
| `v` | **Revise** — type feedback, which is sent to the agent immediately; review stops and you re-run `/approve` later |
| `↑` / `↓` | Previous / next **hunk** (may land on an already-decided hunk, which is shown but inert) |
| `←` / `→` | Previous / next **open file** (a file with undecided hunks); skips fully-decided files |
| `q` | Quit the review |
| `Esc` | Quit the review (also cancels the revise prompt). Not shown in the on-screen menu, but works. |

Navigation never accepts or rejects — it only moves the viewing cursor. The meta line shows
a live `file X/Y` counter: **Y** is the number of files with at least one undecided hunk,
and it decreases as files get fully decided. The review auto-closes when every hunk has been
decided; quitting early leaves undecided hunks untouched on disk.

## How it works

1. The extension runs `git diff` to collect tracked-file modifications (unstaged changes only — staged changes are already approved and excluded) and `git ls-files --others --exclude-standard` to find untracked files.
2. It parses the diff into hunks and feeds each hunk's code body to Shiki for syntax highlighting (diff prefixes `+`/`-`/\  are stripped before highlighting, then re-added in Pi's theme colors).
3. You review hunks in a modal overlay. Accepted hunks stay on disk; rejecting a hunk reverses just that hunk (other hunks and staged changes are untouched); `R` resets a file to the index; rejected untracked files are deleted. You can navigate freely with the arrow keys — a hunk stays undecided until you act on it, and already-decided hunks remain viewable (but inert).
4. When all hunks are resolved, the overlay closes and you're back at the prompt.

## Requirements

- A **git repository** — the extension refuses to run outside one
- **Node.js 18+** — for the dynamic `import("shiki")`
- Pi's **interactive (TUI) mode** — `ctx.ui.custom()` is required for the overlay; in non-interactive modes the command will fail gracefully

## Known limitations

- **Theme**: Shiki uses the fixed `dark-plus` palette. It does not automatically match Pi's active terminal theme.
- **Rejection granularity**: `r` reverses only the hunk you reject — previously accepted hunks in the same file are kept. `R` (and `--reject-all`) reset the whole file's working tree to the *index*, preserving staged changes. Neither operation modifies the index, so staged (already approved) changes are never at risk.
- **Untracked directories**: Only untracked *files* are shown. Empty directories or directories containing only other empty directories are invisible to git and therefore to this extension.
- **Mode-only changes**: `chmod` / `chown` changes do not appear in `git diff` and are not reviewed.
- **Binary files**: Shown as `[Binary file]` — you can accept or reject them but not preview their contents.

## Future ideas

- `/approve --stage` — auto-stage approved changes
- `/approve --commit` — auto-commit with a generated message
- Theme matching — map Shiki tokens to Pi's active semantic colors
- Stage individual accepted hunks (via `git apply` of accepted patches)
- Persistent review state across Pi sessions

## License

MIT
