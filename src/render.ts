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
 * into an ANSI-colored string.
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

/**
 * Render one diff line: a colored +/-/space prefix followed by the
 * highlighted tokens.
 */
export function renderDiffLine(tokens: Token[][], prefix: string, theme: ThemeLike): string {
  const color = prefix === "+" ? "success" : prefix === "-" ? "error" : "dim";
  const prefixChar = prefix === " " ? " " : prefix;
  const label = theme.fg(color, `${prefixChar} `);
  return `${label}${tokensToAnsi(tokens)}`;
}
