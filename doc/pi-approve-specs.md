# pi-approve Extension — Specification

## Overview
`pi-approve` is a Pi extension that requires explicit user approval of every code change before it can be staged for commit. It bridges the gap between agent-generated changes and source control by presenting a structured review of the working-tree diff.

## Core Concepts

- **Code Change**: New, updated, deleted, or renamed code visible in `git diff` (working tree vs. index, i.e. unstaged changes). Staged changes are excluded. Includes tracked file modifications, tracked file deletions, and untracked files.
- **Hunk**: The atomic unit of review. For tracked files, a hunk is a single contiguous diff block. For deleted tracked files, the entire deletion is one hunk. For untracked files, the entire file is one hunk.
- **Agent Delegation**: Rejecting a hunk of an ordinary tracked file does **not** mutate git locally. The extension ends the review and sends the agent a message containing the exact hunk diff, asking it to revert only that change. The user re-runs `/approve` to validate the result — the diff view *is* the validation. (Git has no primitive for "discard exactly this unstaged hunk"; the previous `git apply --reverse` hack, with its whole-file-reset fallback, has been removed.) Whole-file rejection (`R`, `--reject-all`) and rejection of untracked/deleted/binary files remain instant git primitives: `git checkout -- <file>` or file deletion. The index is never modified by any reject operation, so staged changes are preserved without any prompt.

## Requirements

1. **Approval Gate**: Every code change must be explicitly approved before it can be staged for commit.
2. **Granular Approval**: A user must be able to approve one hunk at a time, all hunks in a file, or all hunks across all files.
3. **Explicit Invocation**: Review is triggered by the user running the `/approve` command.
4. **Interactive Mode Only**: The full interactive review (`/approve` without `--all` or `--reject-all`) requires TUI mode. In non-interactive modes, the command exits with an error: *"Approval review requires interactive (TUI) mode."* The `--all` and `--reject-all` variants may run in any mode.

## Commands

### Command syntax

```
/approve [<dir>] [--all | --reject-all]
```

- `<dir>` is an optional path to a git repository. If omitted, the review targets the current working directory.
- `--all` and `--reject-all` are mutually exclusive. Passing both is an error.
- Flags and directory may appear in any order.

### `/approve`
Starts an interactive review of the current working-tree diff.

**Flow:**
1. Verify the agent is idle (`ctx.isIdle()`). If a model turn is already in progress, show an error: *"Agent is currently running. Wait for it to finish before reviewing changes."* and exit.
2. Check if the working directory is a git repository. If not, show an error and exit.
3. Run `git diff` (unstaged changes) plus list untracked files. If clean, show a brief notification: *"No changes to review."*
4. Parse the diff into hunks (per-file for tracked files, whole-file for untracked).
5. Sort hunks alphabetically by file path. Within each file, present hunks in diff order (line number ascending).
6. For each hunk, present to the user:
   - File path
   - Hunk context (lines of diff)
   - Actions: **Accept**, **Accept all in file**, **Reject**, **Reject all in file**, **Revise**, **Quit**
7. After the user makes a choice on a hunk, apply the immediate consequence and move to the next hunk.
   - If the file was rejected with **Reject all in file** (reset to index), skip any remaining hunks in that file.
   - If the file was fully accepted (all hunks accepted, or via **Accept all in file**), mark remaining hunks in that file as accepted implicitly.

### `/approve <dir>`
Starts an interactive review for the repository at `<dir>`.

**Behavior:**
1. Switch into `<dir>`.
2. Perform the same review flow as `/approve` for that repository.
3. If `<dir>` is not a git repository, show an error and exit.

### `/approve --all`
Approve all pending hunks across all files in one action, skipping individual review.

### `/approve --reject-all`
Reject all pending changes. For tracked files, `git checkout --` each modified file (reset working tree to index, preserving staged changes). For untracked files, delete them. No staged-changes warning is needed: resetting to the index never discards staged changes.

## Hunk Actions

| Action | Immediate Effect | File State After |
|---|---|---|
| **Accept** (`a`) | Hunk stays on disk. | File remains modified (or stays as untracked for new files). |
| **Accept all in file** (`A`) | All hunks in the current file (already reviewed and not yet seen) are accepted. The overlay advances to the next file. | File remains modified. |
| **Reject** (`r`) | For ordinary tracked files: the review **ends** and the agent is asked to revert exactly this hunk (message includes the hunk's diff; see *Reject Flow*). The user re-runs `/approve` to validate. For untracked files: file is deleted from disk instantly. For deleted/binary tracked files: the file is reset to the index instantly. | For agent-reverted hunks: file unchanged until the agent acts, then re-validate. Otherwise unchanged (or no longer exists). |
| **Reject all in file** (`R`) | The file's working tree is reset to the index (`git checkout -- <file>`) or the untracked file is deleted. All hunks in this file are discarded. Remaining hunks are skipped. | File restored to index state (or no longer exists). |
| **Revise** (`v`) | Hunk stays on disk. The user's feedback is sent as a user message to the model, triggering a new agent turn. | File remains modified. The model may change it further. |
| **Quit** (`q`, and hidden `Esc`) | Review ends immediately. All prior decisions (acceptances and rejections) are preserved. Unreviewed hunks remain untouched. | Working tree reflects all decisions made so far. Re-run `/approve` to review remaining hunks. |

**Key bindings and menu**: The in-overlay menu is two lines:

```
[a] accept hunk · [r] reject hunk · [A] accept file · [R] reject file · [v] revise
[↑] prev hunk · [↓] next hunk · [←] prev file · [→] next file · [q] quit
```

There is **no default action** — Enter does nothing in the hunk view, so nothing can be
accidentally accepted. `Esc` is not shown in the menu (to keep it short) but still quits;
it is documented in the README. The decision line wraps if the overlay is narrower than
the menu.

**Important**: Rejecting a hunk (`r`) asks the agent to revert only that hunk — previously accepted hunks in the same file are not touched. Only **Reject all in file** (`R`) resets the whole file. The navigation keys (`↑` `↓` `←` `→`) **never accept or reject** — they only move the viewing cursor (see *Navigation*).

## Navigation

Reviewing a multi-hunk change out of order can matter for understanding (a later hunk
may clarify an earlier one), so the user navigates freely. Navigation is a **pure
viewing cursor**: it never decides anything.

### The hunk list

- At review start, a **static hunk list** is built: files alphabetical, hunks in diff
  order — the same order as the presentation today.
- Every hunk starts as **undecided**. It becomes **decided** when the user accepts it
  (`a`/`A`), rejects it (`r`), or its whole file is reset/deleted (`R`). A file left by
  `A` has all its hunks decided-accepted; a file rejected by `R` has all its hunks
  decided-rejected.
- The list never shrinks or reorders. Decided hunks remain in it, visible but **inert**.

### Cursor movement

| Key | Effect |
|---|---|
| `↑` | Previous hunk in the static list. May land on a decided hunk (viewing it again). Clamps at the first hunk. |
| `↓` | Next hunk in the static list. Clamps at the last hunk. |
| `←` | Previous **open** file (a file with ≥1 undecided hunk). Lands on that file's **last** undecided hunk. Skips files with no undecided hunks. Clamps if none earlier. |
| `→` | Next **open** file. Lands on that file's **first** undecided hunk. Skips files with no undecided hunks. Clamps if none later. |

- After any decision on the current hunk, the cursor **auto-advances** to the next
  undecided hunk (any file) so the user is not left standing on an inert hunk. If no
  undecided hunk remains, the review ends (see below).
- `A` / `R` while viewing a file decide every hunk in that file at once; the cursor then
  auto-advances as above.

### Decided hunks

- A decided hunk renders with a marker in its meta line: `[accepted]` or `[rejected]`
  (a file reset via `R` shows `[rejected]` on all its hunks).
- All action keys (`a` `A` `r` `R` `v`) are **inert** on a decided hunk — navigation and
  `q`/`Esc` still work. Re-deciding is not supported in v1: the git state (or the pending
  agent revert) already reflects the decision, and requesting it again would either be a
  no-op or destroy the file's remaining changes.

### File counter (`file X/Y`)

The meta line shows the current file's position among files that still have work left:

```
path/to/file.ts — modified · hunk 1/2 · file 1/3
```

- **Y** = number of files with ≥1 **undecided** hunk. A file leaves the count the moment
  its last undecided hunk is decided — by acceptance or rejection. (`A` on the last open
  file drops Y immediately, even though the accepted changes are still on disk: there is
  nothing left to review there.)
- **X** = the viewed file's 1-based position among those files, in the original
  alphabetical order.
- When the viewed file itself becomes fully decided (via `A`/`R`), the displayed `X/Y`
  **freezes** on that file until the cursor moves (the auto-advance after the decision
  handles this immediately in practice).
- Y updates live: deciding the last open hunk of one file renumbers the counter for any
  file the cursor next lands on.

### End of review

- The review **auto-closes** when every hunk in the static list has been decided.
- `q` / `Esc` always quit immediately, preserving every decision made so far; undecided
  hunks are untouched on disk. (An undecided hunk is a *skipped* hunk — there is no
  separate skip action.)

### Edge cases

| Scenario | Behavior |
|---|---|
| `↑` on first hunk / `↓` on last hunk | Clamp — no-op. |
| `←`/`→` with no other open file in that direction | Clamp — no-op. |
| `→` from a hunk in the last open file | No-op; the file counter makes this visible (`file 3/3`). |
| Viewed file just got fully decided | Meta counter freezes on that file until the cursor moves; action keys are inert. |
| All hunks decided while reviewing | Overlay closes automatically; summary notification as today. |
| No open file in a direction but more hunks exist in the *same* file | `←`/`→` stay no-ops; `↑`/`↓` still move within the file. |

## Revise Flow

1. User selects **Revise** on a hunk.
2. Prompt for free-text feedback (e.g., *"Use camelCase here"*).
3. The extension calls `pi.sendUserMessage()` with: *"Please revise `<file>`: <feedback>. The relevant hunk was: <diff context>."*
4. The model receives this and generates a new turn.
5. The review does not continue. After the model turn completes, the user must run `/approve` again to review the fresh diff from the new state.

## Reject Flow (agent-reverted hunks)

Rejecting a hunk of an **ordinary tracked file** is delegated to the agent, because git has
no primitive for discarding exactly one unstaged hunk and the previous local
(`git apply --reverse`) approach was fragile: when the reconstructed patch did not apply
cleanly it fell back to resetting the **entire file**, destroying the file's other
unstaged hunks.

1. User selects **Reject** (`r`) on a hunk of an ordinary tracked file.
2. The extension calls `pi.sendUserMessage()` with a revert request that names the file
   and hunk and embeds the hunk's exact diff, instructing: revert **exactly this change**
   and nothing else in the file — leave all other unstaged hunks and all staged content
   untouched.
3. The model receives this and generates a new turn; the user is told to re-run
   `/approve` to validate.
4. The review does not continue, even if other hunks were still open. **The diff view is
   the validation**: if the agent reverted too much or too little, the next `/approve`
   pass shows it, and the user can push back in chat.

Rejected hunks therefore leave the working tree on the *agent's* next turn, not
instantly. This is the intended trade-off: failures become **observable and recoverable**
(a visible wrong diff, fixable by another turn) instead of instant local destruction.

Untracked files, deleted tracked files, and binary files are still rejected **instantly
and locally** — single-hunk semantics do not apply to them (see their sections): an
untracked file is deleted, a deleted file is restored from the index, and a binary file
is reset to the index.

## Deleted Tracked Files

- Deleted tracked files (visible in `git diff` as all-lines-removed hunks) are included in review.
- A deleted file is presented as a single hunk showing its former content with `-` prefixes.
- **Accept**: The file remains deleted in the working tree.
- **Reject**: The file is restored from the index via `git checkout -- <file>`.

## Untracked Files

- Untracked files are included in review.
- Each untracked file is presented as a single hunk showing its full content.
- **Accept**: File stays on disk, remains untracked.
- **Reject**: File is deleted (`rm`).

## After Full Review

When all hunks have been resolved (accepted, rejected, revised, or agent-revert-requested):
- All accepted changes remain in the working tree, **unstaged**.
- The user handles `git add` and `git commit` manually.
- Accepted but unstaged changes will reappear on subsequent `/approve` runs until they are staged or committed — by design, the review is a gate to run right before committing, and a re-confirm of an already-accepted hunk is a single keypress.
- If any hunks were revised or rejected (agent revert), the user must re-run `/approve` after the model's next turn to review/validate the updated diff.

## Edge Cases

| Scenario | Behavior |
|---|---|
| Not a git repo | Error: *"Not a git repository. Approval requires a git repo."* |
| Clean working tree | Brief notification: *"No changes to review."* |
| Reject after accepting other hunks in same file | Only the rejected hunk is asked of the agent (message names the exact hunk); accepted hunks stay on disk, validated on the next pass. |
| Reject (agent revert) requested mid-review | Review ends immediately; other open hunks remain untouched on disk and are reviewed on the next pass. |
| Agent reverts too much / too little | Visible on the next `/approve` run; the user pushes back in chat. Nothing is lost — the index is never modified. |
| Revise mid-review | Review stops; model gets feedback; user re-runs `/approve` after model turn. |
| Binary file in working tree | Shown as a single pseudo-hunk with the label `[Binary file]`. No preview is rendered. Accept/reject actions apply the same as for tracked/untracked files. Rejecting a tracked binary resets the working tree to the index; rejecting an untracked binary deletes it. |
| File has staged changes | Staged content is the *base* of the shown diff. Reversing a hunk only removes the unstaged delta on top of it; the index is never modified, so staged changes survive with no prompt. |

## Syntax Highlighting

Diff hunks are rendered with syntax highlighting powered by **Shiki**, the same engine used by VS Code.

### Why Shiki

- **Maturity & popularity**: Powers VS Code, VitePress, Nuxt. ~35k stars. De-facto standard.
- **VS Code parity**: Users see the same colors and token accuracy as their editor.
- **Diff-safe**: Shiki returns structured tokens (keyword, string, function, etc.). We highlight the *code body* and then prepend `+ `/`- `/`  ` prefixes in Pi's diff colors. This avoids parse errors from feeding prefixes into the language grammar.
- **180+ languages**: Automatic language detection from file extension via bundled aliases.
- **Dark themes**: Ships with `dark-plus`, `github-dark`, `catppuccin-mocha`, etc.

### Dependency

```json
{
  "dependencies": {
    "shiki": "^1.0.0"
  }
}
```

### Setup (lightweight)

Import `shiki/core` and load only the languages needed, rather than pulling in the full bundle (~MBs of unused grammar data):

```typescript
import { createHighlighterCore } from 'shiki/core'
import { loadWasm } from 'shiki/wasm'

let highlighter: Awaited<ReturnType<typeof createHighlighterCore>> | null = null

async function getHighlighter() {
  if (!highlighter) {
    await loadWasm(import('shiki/onig.wasm'))
    highlighter = await createHighlighterCore({
      themes: ['dark-plus'],
      langs: [], // loaded on demand
    })
  }
  return highlighter
}
```

### Rendering pipeline

```typescript
import { createHighlighterCore } from 'shiki/core'

async function renderDiffLine(
  code: string,
  lang: string,
  diffPrefix: '+' | '-' | ' ',
  piTheme: Theme,
) {
  const hl = await getHighlighter()
  // Ensure the language is loaded (no-op if already loaded)
  await hl.loadLanguage(lang)

  // 1. Highlight the code body (without the diff prefix)
  const { tokens } = await hl.codeToTokens(code, {
    lang,
    theme: 'dark-plus',
  })

  // 2. Convert Shiki tokens to ANSI escape codes
  const ansiBody = tokensToAnsi(tokens) // helper: map color → ANSI SGR

  // 3. Prepend diff prefix using Pi's semantic colors
  const prefix = diffPrefix === '+'
    ? piTheme.fg('success', '+ ')
    : diffPrefix === '-'
    ? piTheme.fg('error', '- ')
    : piTheme.fg('dim', '  ')

  return prefix + ansiBody
}
```

### Theme note

Shiki themes carry their own color palette. The highlighted code will look like VS Code's `dark-plus` regardless of Pi's active terminal theme. This is acceptable for v1; future versions may attempt to map Shiki tokens to Pi's semantic colors.


## Future Enhancements (out of scope for v1)

- `/approve --stage` flag to auto-stage approved changes.
- `/approve --commit` flag to auto-commit with a generated message.
- Persistent "pending review" state across sessions.
- Inline line-level commenting on hunks (instead of hunk-level revise).
- Re-deciding a hunk (e.g. undoing an accept) with a safe re-application path.
- Instant local per-hunk reject without a model round-trip, should the agent-delegation latency ever feel too slow.
- Stage individual accepted hunks (via `git apply` of accepted patches).
