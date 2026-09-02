import type { LlmProvider, GafferExtractedLine, GafferDocumentInput, GafferDocumentExtraction } from "./provider";

export type NamedProvider = {
  /** Short label for logs, e.g. "anthropic" / "gemini". */
  name: string;
  provider: LlmProvider;
};

type LogFn = (message: string, error?: unknown) => void;

const defaultLog: LogFn = (message, error) => {
  if (error !== undefined) {
    // A leg actually failed → warn (log aggregators surface this).
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[llm-fallback] ${message}: ${reason}`);
  } else {
    // Informational (empty-result handoff / recovery succeeded) → not a warning.
    console.info(`[llm-fallback] ${message}`);
  }
};

/**
 * Wraps an ordered list of LLM providers and tries each in turn.
 *
 * A provider is considered "failed for this request" when it throws OR
 * returns an empty result (empty = it could not recognise anything, so the
 * next provider should get a chance). The LAST provider's result is always
 * returned as-is — an empty array from the final leg is a legitimate
 * "no equipment in this text" answer, not an error.
 *
 * Боевая цепочка — anthropic → gemini (см. getLlmProvider): Claude отдаёт
 * позиции structured output'ом, Gemini подхватывает при 429/5xx/отказе.
 *
 * Latency budget: each leg's own internal retry/back-off runs before this
 * wrapper sees a failure. Construct non-final legs with fewer internal
 * retries (see buildLlmLeg) so a sustained outage hands off in ~1 round-trip
 * rather than stalling on exponential back-off.
 */
export class FallbackLlmProvider implements LlmProvider {
  private readonly legs: NamedProvider[];
  private readonly log: LogFn;

  constructor(legs: NamedProvider[], log: LogFn = defaultLog) {
    if (legs.length === 0) {
      throw new Error("FallbackLlmProvider requires at least one provider");
    }
    this.legs = legs;
    this.log = log;
  }

  /** Имена ног по порядку — для логов при старте и для тестов конфигурации. */
  get legNames(): string[] {
    return this.legs.map((l) => l.name);
  }

  extractGafferLines(text: string): Promise<GafferExtractedLine[]> {
    return this.run(this.legs, (p) => p.extractGafferLines(text), (r) => r.length === 0);
  }

  /**
   * Документы читают только ноги со зрением; остальные пропускаем молча —
   * это конфигурация, а не сбой. Ни одной такой ноги — ошибка конфигурации.
   */
  async extractGafferDocument(doc: GafferDocumentInput): Promise<GafferDocumentExtraction> {
    const capable = this.legs.filter((l) => typeof l.provider.extractGafferDocument === "function");
    if (capable.length === 0) {
      throw new Error(
        "Ни один провайдер в LLM_FALLBACK_CHAIN не умеет читать документы — нужна нога anthropic или gemini",
      );
    }
    return this.run(
      capable,
      (p) => (p.extractGafferDocument as NonNullable<LlmProvider["extractGafferDocument"]>).call(p, doc),
      (r) => r.lines.length === 0,
    );
  }

  private async run<T>(
    legs: NamedProvider[],
    call: (provider: LlmProvider) => Promise<T>,
    isEmpty: (result: T) => boolean,
  ): Promise<T> {
    let lastError: unknown;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const isLast = i === legs.length - 1;

      try {
        const result = await call(leg.provider);
        if (!isEmpty(result) || isLast) {
          if (i > 0) {
            this.log(`provider "${leg.name}" succeeded after ${i} fallback(s)`);
          }
          return result;
        }
        this.log(`provider "${leg.name}" returned 0 lines — falling back to next`);
      } catch (err: unknown) {
        lastError = err;
        if (isLast) {
          this.log(`provider "${leg.name}" failed (last leg) — giving up`, err);
          throw err;
        }
        this.log(`provider "${leg.name}" failed — falling back to next`, err);
      }
    }

    // Unreachable: the final iteration always returns (success/empty) or
    // throws (caught error on last leg). Kept for exhaustive control flow.
    throw lastError ?? new Error("FallbackLlmProvider: all providers exhausted");
  }
}
