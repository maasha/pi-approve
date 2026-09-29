# pi-approve Extension — Specification

## Overview
`pi-approve` is a Pi extension that requires explicit user approval of every code change before it can be staged for commit. It bridges the gap between agent-generated changes and source control by presenting a structured review of the working-tree diff.

## Core Concepts

- **Code Change**: New, updated, or deleted code visible in `git diff` (working tree vs. HEAD). Includes tracked file modifications and untracked files.
- **Hunk**: The atomic unit of review. For tracked files, a hunk is a single contiguous diff block. For untracked files, the entire file is one hunk.
- **File-level Reset**: If any hunk in a tracked file is rejected, the entire file is reset to HEAD via `git checkout -- <file>`. This is a simplifying invariant: rejection is per-hunk visibility but per-file action.

## Requirements

1. **Approval Gate**: Every code change must be explicitly approved before it can be staged for commit.
2. **Granular Approval**: A user must be able to approve one hunk at a time, all hunks in a file, or all hunks across all files.
3. **Explicit Invocation**: Review is triggered by the user running the `/approve` command.

## Commands

### `/approve`
Starts an interactive review of the current working-tree diff.

**Flow:**
1. Check if the working directory is a git repository. If not, show an error and exit.
2. Run `git diff` plus list untracked files. If clean, show a brief notification: *"No changes to review."*
3. Parse the diff into hunks (per-file for tracked files, whole-file for untracked).
4. For each hunk, present to the user:
   - File path
   - Hunk context (lines of diff)
   - Actions: **Accept**, **Reject**, **Revise**
5. After the user makes a choice on a hunk, apply the immediate consequence and move to the next hunk.

### `/approve --all`
Approve all pending hunks across all files in one action, skipping individual review.

### `/approve --reject-all`
Reject all pending changes. For tracked files, `git checkout --` each modified file. For untracked files, delete them.

## Hunk Actions

| Action | Immediate Effect | File State After |
|---|---|---|
| **Accept** | Hunk stays on disk. | File remains modified (or stays as untracked for new files). |
| **Reject** | For tracked files: `git checkout -- <file>` resets the entire file to HEAD. The rejected hunk and any accepted hunks in that same file are lost. For untracked files: file is deleted from disk. | File restored to HEAD state (or no longer exists). |
| **Revise** | Hunk stays on disk. The user's feedback is sent as a user message to the model, triggering a new agent turn. | File remains modified. The model may change it further. |

**Important**: Because rejection resets the entire file, if a user has already accepted some hunks in a file and then rejects a later hunk in the same file, the previously accepted hunks are also lost. The user must re-approve them after fixing the rejected one.

## Revise Flow

1. User selects **Revise** on a hunk.
2. Prompt for free-text feedback (e.g., *"Use camelCase here"*).
3. Send the feedback as a user message to Pi: *"Please revise `<file>`: <feedback>. The relevant hunk was: <diff context>."*
4. The model receives this and generates a new turn.
5. The review does not continue. After the model turn completes, the user must run `/approve` again to review the fresh diff from the new state.

## Untracked Files

- Untracked files are included in review.
- Each untracked file is presented as a single hunk showing its full content.
- **Accept**: File stays on disk, remains untracked.
- **Reject**: File is deleted (`rm`).

## After Full Review

When all hunks have been resolved (accepted, rejected, or revised):
- All accepted changes remain in the working tree, **unstaged**.
- The user handles `git add` and `git commit` manually.
- If any hunks were revised, the user must re-run `/approve` after the model's next turn to review the updated diff.

## Edge Cases

| Scenario | Behavior |
|---|---|
| Not a git repo | Error: *"Not a git repository. Approval requires a git repo."* |
| Clean working tree | Brief notification: *"No changes to review."* |
| Reject after accepting other hunks in same file | Entire file resets to HEAD; accepted hunks are lost. |
| Revise mid-review | Review stops; model gets feedback; user re-runs `/approve` after model turn. |
| Model makes changes during review (theoretical race) | Reviews are modal; model does not run during `/approve` interaction. |

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

### Rendering pipeline

```typescript
import { codeToTokens } from 'shiki'

async function renderDiffLine(
  code: string,
  lang: string,
  diffPrefix: '+' | '-' | ' ',
  piTheme: Theme,
) {
  // 1. Highlight the code body (without the diff prefix)
  const { tokens } = await codeToTokens(code, {
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
