# pi-approve Extension — Specification

## Overview
`pi-approve` is a Pi extension that requires explicit user approval of every code change before it can be staged for commit. It bridges the gap between agent-generated changes and source control by presenting a structured review of the working-tree diff.

## Core Concepts

- **Code Change**: New, updated, deleted, or renamed code visible in `git diff` (working tree vs. index, i.e. unstaged changes). Staged changes are excluded. Includes tracked file modifications, tracked file deletions, and untracked files.
- **Hunk**: The atomic unit of review. For tracked files, a hunk is a single contiguous diff block. For deleted tracked files, the entire deletion is one hunk. For untracked files, the entire file is one hunk.
- **File-level Reset**: If any hunk in a tracked file is rejected, the file's working tree is reset to the index via `git checkout -- <file>`. This preserves any staged changes. This is a simplifying invariant: rejection is per-hunk visibility but per-file action. **Exception**: If a file has staged changes, the user is warned that rejection will discard those staged changes and must confirm before proceeding.

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
   - If the file was rejected (reset to index), skip any remaining hunks in that file.
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
Reject all pending changes. For tracked files, `git checkout --` each modified file (reset working tree to index, preserving staged changes). For untracked files, delete them. If any affected file has staged changes, warn the user and require confirmation before discarding them.

## Hunk Actions

| Action | Immediate Effect | File State After |
|---|---|---|
| **Accept** | Hunk stays on disk. | File remains modified (or stays as untracked for new files). |
| **Accept all in file** (`f`) | All hunks in the current file (already reviewed and not yet seen) are accepted. The overlay advances to the next file. | File remains modified. |
| **Reject** | For tracked files: the file's working tree is reset to the index via `git checkout -- <file>`, preserving staged changes. If the file has staged changes, the user is warned and must confirm. For untracked files: file is deleted from disk. | File restored to index state (or no longer exists). |
| **Reject all in file** (`d`) | Same as **Reject** for the current file: resets working tree to index or deletes untracked file. All hunks in this file are discarded. | File restored to index state (or no longer exists). |
| **Revise** | Hunk stays on disk. The user's feedback is sent as a user message to the model, triggering a new agent turn. | File remains modified. The model may change it further. |
| **Quit** | Review ends immediately. All prior decisions (acceptances and rejections) are preserved. Unreviewed hunks remain untouched. | Working tree reflects all decisions made so far. Re-run `/approve` to review remaining hunks. |

**Important**: Because rejection resets the entire file, if a user has already accepted some hunks in a file and then rejects a later hunk in the same file, the previously accepted hunks are also lost. The user must re-approve them after fixing the rejected one.

## Revise Flow

1. User selects **Revise** on a hunk.
2. Prompt for free-text feedback (e.g., *"Use camelCase here"*).
3. The extension calls `pi.sendUserMessage()` with: *"Please revise `<file>`: <feedback>. The relevant hunk was: <diff context>."*
4. The model receives this and generates a new turn.
5. The review does not continue. After the model turn completes, the user must run `/approve` again to review the fresh diff from the new state.

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

When all hunks have been resolved (accepted, rejected, or revised):
- All accepted changes remain in the working tree, **unstaged**.
- The user handles `git add` and `git commit` manually.
- Accepted but unstaged changes will reappear on subsequent `/approve` runs until they are staged or committed.
- If any hunks were revised, the user must re-run `/approve` after the model's next turn to review the updated diff.

## Edge Cases

| Scenario | Behavior |
|---|---|
| Not a git repo | Error: *"Not a git repository. Approval requires a git repo."* |
| Clean working tree | Brief notification: *"No changes to review."* |
| Reject after accepting other hunks in same file | Entire file resets; accepted hunks are lost. |
| File has staged changes and user rejects a hunk | Warning shown: "This file has staged (already approved) changes. Rejection will discard them. Continue?" User must confirm before `git checkout -- <file>` runs. If declined, the hunk is skipped and the file remains unchanged. |
| Revise mid-review | Review stops; model gets feedback; user re-runs `/approve` after model turn. |
| Binary file in working tree | Shown as a single pseudo-hunk with the label `[Binary file]`. No preview is rendered. Accept/reject actions apply the same as for tracked/untracked files. Rejecting a tracked binary resets the working tree to the index; rejecting an untracked binary deletes it. |
| Bulk `--reject-all` when tracked files have staged changes | Same warning and confirmation as per-hunk rejection: list affected files and require confirmation before running `git checkout --` (reset working tree to index, preserving staged changes). |

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
- Inline line-level commenting on hunks.
- Smart patch-based hunk reversion (reset only the rejected hunk without resetting the whole file).
