export interface ApproveArgs {
  /** Target git repo path, or null for the current working directory. */
  dir: string | null;
  all: boolean;
  rejectAll: boolean;
}

/**
 * Parse the raw argument tokens after `/approve` into a structured form.
 * Flags and the directory may appear in any order. `--all` and
 * `--reject-all` are mutually exclusive.
 */
export function parseArgs(tokens: string[]): ApproveArgs {
  let dir: string | null = null;
  let all = false;
  let rejectAll = false;

  for (const tok of tokens) {
    if (tok === "--all") {
      all = true;
    } else if (tok === "--reject-all") {
      rejectAll = true;
    } else if (tok.startsWith("--")) {
      // Unknown flag: ignore.
    } else if (tok) {
      dir = tok;
    }
  }

  if (all && rejectAll) {
    throw new Error("--all and --reject-all are mutually exclusive.");
  }

  return { dir, all, rejectAll };
}
