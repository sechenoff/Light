import type { LlmProvider, GafferExtractedLine } from "./provider";

export type NamedProvider = {
  /** Short label for logs, e.g. "chatmock" / "openai". */
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
 * returns an empty array (empty = it could not recognise anything, so the
 * next, more reliable provider should get a chance). The LAST provider's
 * result is always returned as-is — an empty array from the final leg is a
 * legitimate "no equipment in this text" answer, not an error.
 *
 * Primary use: ChatMock (free, ChatGPT Plus session, but rate-limited with
 * HTTP 429 "usage limit reached") as leg 1, direct api.openai.com (billed,
 * reliable) as leg 2. When ChatMock hits its Plus cap, recognition
 * transparently continues via the paid API instead of failing with 503.
 *
 * Latency budget: each leg's own internal retry/back-off runs before this
 * wrapper sees a failure. Construct the primary leg with maxRetries=1 (see
 * getLlmProvider) so a sustained ChatMock 429 hands off in ~1 round-trip
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

  async extractGafferLines(text: string): Promise<GafferExtractedLine[]> {
    let lastError: unknown;

    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];
      const isLast = i === this.legs.length - 1;

      try {
        const result = await leg.provider.extractGafferLines(text);
        if (result.length > 0 || isLast) {
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
