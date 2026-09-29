# pi-approve

A [Pi](https://github.com/earendil-works/pi) extension that lets you review and approve every code change before it is staged for commit.

## What it does

After the agent edits your files, run `/approve` to walk through each diff hunk interactively. You can accept, reject, or request revisions on a per-hunk basis. Approved changes stay in the working tree but remain **unstaged** — you decide when to `git add` / `git commit`.

## Features

- **Granular approval** — accept or reject one hunk at a time, all hunks in a file, or all changes across the repo
- **Syntax highlighting** — diff hunks are rendered with [Shiki](https://shiki.style/) (the same engine VS Code uses) using the `dark-plus` theme
- **Revision requests** — ask the agent to fix a hunk inline; the review pauses, the agent gets your feedback, and you re-run `/approve` when done
- **Untracked files** — new files are shown as whole-file hunks and can be approved or deleted
- **File-level reset** — rejecting any hunk in a file resets the entire file to `HEAD`, keeping the model safe from partial states

## Installation

1. **Install dependencies** (Shiki for syntax highlighting):
   ```bash
   cd pi-approve
   npm install
   ```

2. **Load the extension** in Pi:
   ```bash
   pi --extension ./pi-approve/src/index.ts
   ```

   Or copy the directory into Pi's extensions path so it loads automatically:
   ```bash
   # macOS / Linux
   mkdir -p ~/.pi/agent/extensions
   cp -r pi-approve ~/.pi/agent/extensions/
   ```

## Usage

### Commands

| Command | Action |
|---|---|
| `/approve` | Start an interactive review of all working-tree changes |
| `/approve --all` | Approve all changes without reviewing |
| `/approve --reject-all` | Reject all changes (checkout tracked files, delete untracked files) |

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
│  Actions: [a] Accept  [r] Reject  [v] Revise                          │
│  [f] Accept all in file  [d] Reject all in file                       │
│  [↑↓] Scroll  [Esc/q] Quit                                            │
╰─────────────────────────────────────────────────────────────────────────╯
```

| Key | Action |
|---|---|
| `a` | **Accept** this hunk |
| `r` | **Reject** this hunk — resets the entire file to `HEAD` |
| `v` | **Revise** — type feedback, which is sent to the agent immediately; review stops and you re-run `/approve` later |
| `f` | **Accept all remaining hunks** in this file |
| `d` | **Reject all hunks** in this file |
| `↑` / `↓` | Scroll long diffs |
| `Esc` / `q` | Quit the review |

## How it works

1. The extension runs `git diff` to collect tracked-file modifications and `git ls-files --others --exclude-standard` to find untracked files.
2. It parses the diff into hunks and feeds each hunk's code body to Shiki for syntax highlighting (diff prefixes `+`/`-`/\  are stripped before highlighting, then re-added in Pi's theme colors).
3. You review hunks in a modal overlay. Accepted hunks stay on disk; rejected tracked files are restored with `git checkout -- <file>`; rejected untracked files are deleted.
4. When all hunks are resolved, the overlay closes and you're back at the prompt.

## Requirements

- A **git repository** — the extension refuses to run outside one
- **Node.js 18+** — for the dynamic `import("shiki")`
- Pi's **interactive (TUI) mode** — `ctx.ui.custom()` is required for the overlay; in non-interactive modes the command will fail gracefully

## Known limitations

- **Theme**: Shiki uses the fixed `dark-plus` palette. It does not automatically match Pi's active terminal theme.
- **Rejection granularity**: Rejecting any hunk in a file resets the *entire* file to `HEAD`. This is a simplifying invariant to avoid complex patch-reversal logic. If you accepted earlier hunks in the same file, they are lost and must be re-approved after the agent fixes the rejected hunk.
- **Untracked directories**: Only untracked *files* are shown. Empty directories or directories containing only other empty directories are invisible to git and therefore to this extension.
- **Mode-only changes**: `chmod` / `chown` changes do not appear in `git diff` and are not reviewed.
- **Binary files**: Shown as `[Binary file]` — you can accept or reject them but not preview their contents.
- **Large files**: Diffs are truncated to 100 lines per file to keep the overlay responsive.

## Future ideas

- `/approve --stage` — auto-stage approved changes
- `/approve --commit` — auto-commit with a generated message
- Theme matching — map Shiki tokens to Pi's active semantic colors
- Smart hunk reversion — reset only the rejected hunk without touching the rest of the file
- Persistent review state across Pi sessions

## License

MIT
