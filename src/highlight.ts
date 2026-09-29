import type { Token } from "./render.ts";

/** Shiki theme used for diff highlighting (dark, VS Code dark-plus palette). */
const THEME = "dark-plus";

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
 * (lightweight: only the requested languages and the single theme are loaded).
 *
 * `create` is injectable so unit tests can run without the real WASM/oniguruma
 * engine. When `create` is null (e.g. Shiki failed to initialise) every call
 * degrades to a plaintext token, so rendering always works.
 */
export class Highlighter {
  private core: CoreHighlighter | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly create: CreateHighlighter | null) { }

  /** Ensure the core is initialised for the given set of languages. */
  async ensure(langs: string[]): Promise<void> {
    if (this.core || this.initPromise) return;
    const create = this.create;
    if (!create) return;
    this.initPromise = (async () => {
      try {
        const unique = [...new Set(langs.filter((l) => l && l !== "plaintext"))];
        this.core = await create({ themes: [THEME], langs: unique });
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
    try {
      const result = this.core.codeToTokens(line, { lang: language, theme: THEME });
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
export function createRealHighlighter(): Highlighter {
  return new Highlighter(async (opts) => {
    const { createdBundledHighlighter } = await import("shiki/core");
    const { bundledLanguages } = await import("shiki/langs");
    const { bundledThemes } = await import("shiki/themes");
    const { default: wasm } = await import("shiki/wasm");
    const factory = createdBundledHighlighter(bundledLanguages, bundledThemes, wasm);
    return factory(opts) as Promise<CoreHighlighter>;
  });
}

/** Shared singleton for the whole extension process. */
export function getDefaultHighlighter(): Highlighter {
  if (!defaultInstance) defaultInstance = createRealHighlighter();
  return defaultInstance;
}
