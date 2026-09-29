/** Convert a `#rrggbb` hex color to a 24-bit ANSI SGR parameter string. */
export function hexToAnsi(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `38;2;${r};${g};${b}`;
}

export interface Token {
  content: string;
  color?: string;
}

/**
 * Render a Shiki-style token array (array of lines, each an array of tokens)
 * into an ANSI-colored string. The per-token reset is fg-only (`\x1b[39m`)
 * so it does not wipe the surrounding diff-line background.
 */
export function tokensToAnsi(tokens: Token[][]): string {
  return tokens
    .map((line) =>
      line
        .map((t) => {
          if (t.color) {
            return `\x1b[${hexToAnsi(t.color)}m${t.content}\x1b[39m`;
          }
          return t.content;
        })
        .join(""),
    )
    .join("\n");
}

export interface ThemeLike {
  fg(color: string, text: string): string;
}

/** Pale backgrounds for added/removed diff lines. */
export const ADDED_BG = "\x1b[48;2;22;101;52m";
export const REMOVED_BG = "\x1b[48;2;60;22;30m";
const BG_RESET = "\x1b[49m";

/**
 * Render one diff line: a colored +/-/space prefix followed by the
 * highlighted tokens. Added lines get a pale green background, removed
 * lines a pale red one.
 */
export function renderDiffLine(tokens: Token[][], prefix: string, theme: ThemeLike): string {
  const color = prefix === "+" ? "success" : prefix === "-" ? "error" : "dim";
  const prefixChar = prefix === " " ? " " : prefix;
  const label = theme.fg(color, `${prefixChar} `);
  const content = `${label}${tokensToAnsi(tokens)}`;
  if (prefix === "+") return `${ADDED_BG}${content}${BG_RESET}`;
  if (prefix === "-") return `${REMOVED_BG}${content}${BG_RESET}`;
  return content;
}
