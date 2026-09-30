import type { Token } from "./render.ts";

/**
 * Shiki themes used for diff highlighting, matched to the overlay's active
 * theme so the code palette suits the surrounding background (VS Code's
 * dark-plus / light-plus palettes). Both are loaded up front; themes are small
 * and selecting one at render time is free.
 */
export const DARK_THEME = "dark-plus";
export const LIGHT_THEME = "light-plus";

/** The subset of the Shiki highlighter surface we use. */
export interface CoreHighlighter {
  codeToTokens(
    code: string,
    opts: { lang: string; theme: string },
  ): { tokens: Token[][] };
}

export type CreateHighlighter = (opts: {
  themes: string[];
  langs: string[];
}) => Promise<CoreHighlighter>;

/**
 * A lazily-initialised highlighter backed by Shiki's `createdBundledHighlighter`
 * (lightweight: only the requested languages are loaded).
 *
 * `create` is injectable so unit tests can run without the real WASM/oniguruma
 * engine. When `create` is null (e.g. Shiki failed to initialise) every call
 * degrades to a plaintext token, so rendering always works.
 */
export class Highlighter {
  private core: CoreHighlighter | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * `isLight` reports whether the pi terminal's active theme is a light one,
   * so the code palette follows the surrounding overlay.
   */
  constructor(
    private readonly create: CreateHighlighter | null,
    private readonly isLight?: () => boolean,
  ) { }

  private activeTheme(): string {
    try {
      return this.isLight?.() ? LIGHT_THEME : DARK_THEME;
    } catch {
      return DARK_THEME;
    }
  }

  /** Ensure the core is initialised for the given set of languages. */
  async ensure(langs: string[]): Promise<void> {
    if (this.core || this.initPromise) return;
    const create = this.create;
    if (!create) return;
    this.initPromise = (async () => {
      try {
        const unique = [...new Set(langs.filter((l) => l && l !== "plaintext"))];
        this.core = await create({ themes: [DARK_THEME, LIGHT_THEME], langs: unique });
      } catch {
        this.core = null;
      }
    })();
    await this.initPromise;
  }

  /**
   * Highlight a single line. Returns `[[{ content: line }]]` (no colour) when
   * the language is plaintext/unknown or highlighting is unavailable.
   */
  async highlightLine(line: string, language: string): Promise<Token[][]> {
    if (!language || language === "plaintext") return [[{ content: line }]];
    await this.ensure([language]);
    if (!this.core) return [[{ content: line }]];
    const theme = this.activeTheme();
    try {
      const result = this.core.codeToTokens(line, { lang: language, theme });
      const first = result.tokens[0];
      return first && first.length > 0 ? [first] : [[{ content: line }]];
    } catch {
      return [[{ content: line }]];
    }
  }
}

let defaultInstance: Highlighter | null = null;

/**
 * Build (and cache) the real Shiki-backed highlighter. Shiki's `createdBundledHighlighter`
 * wires a name→lazy-import resolver, so only the languages and theme we actually
 * request are loaded.
 */
export function createRealHighlighter(isLight?: () => boolean): Highlighter {
  return new Highlighter(
    async (opts) => {
      const { createdBundledHighlighter } = await import("shiki/core");
      const { bundledLanguages } = await import("shiki/langs");
      const { bundledThemes } = await import("shiki/themes");
      const { default: wasm } = await import("shiki/wasm");
      const factory = createdBundledHighlighter(bundledLanguages, bundledThemes, wasm);
      return factory(opts) as Promise<CoreHighlighter>;
    },
    isLight,
  );
}

/**
 * Shared singleton for the whole extension process. `isLight` reads pi's
 * currently active theme, so the palette follows theme switches at any time.
 */
export function getDefaultHighlighter(isLight?: () => boolean): Highlighter {
  if (!defaultInstance) defaultInstance = createRealHighlighter(isLight);
  return defaultInstance;
}
