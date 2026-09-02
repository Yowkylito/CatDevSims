/**
 * Send gate. UI never calls a backend; everything goes through here.
 * Send is dead until ClassifyResult is unblocked with a finite estCostUsd.
 */
import type { ClassifyResult, Owner, SendOptions, SendResult } from "./types.ts";
import { isFiniteNumber, isPaidOwner, SendRejectedError } from "./types.ts";
import { assertNoRepoDump, buildBrief } from "./payload.ts";
import { defaultRegistry, MockRegistry, RateLimitError } from "./backends.ts";
import { defaultCache, PromptCache } from "./cache.ts";
import { Budget, defaultBudget } from "./budget.ts";

export function canSend(result: ClassifyResult, fanOutEnabled: boolean): boolean {
  try {
    assertSendable(result, fanOutEnabled);
    return true;
  } catch {
    return false;
  }
}

export function assertSendable(result: ClassifyResult, fanOutEnabled: boolean): void {
  if (!result || typeof result !== "object") {
    throw new SendRejectedError("invalid_classify", "missing ClassifyResult");
  }
  if (result.blocked === true) {
    throw new SendRejectedError(result.blockReason ?? "blocked", "Send rejected: classify blocked");
  }
  if (!isFiniteNumber(result.estCostUsd)) {
    throw new SendRejectedError("missing_estimate", "Send rejected: missing or non-finite estCostUsd");
  }
  if (fanOutEnabled === false && result.fanOut !== false) {
    throw new SendRejectedError("fanout_mismatch", "fanOutEnabled is false but fanOut is not false");
  }
  if (isPaidOwner(result.owner) && result.estCostUsd === 0) {
    throw new SendRejectedError("missing_estimate", "paid owner with estCostUsd === 0 cannot Send");
  }
  if (result.fanOut && typeof result.fanOut === "object") {
    if (!Array.isArray(result.fanOut.owners) || result.fanOut.owners.length === 0) {
      throw new SendRejectedError("fanout_estimate", "fan-out owners missing");
    }
    if (!isFiniteNumber(result.fanOut.estCostUsd) || result.fanOut.estCostUsd <= 0) {
      throw new SendRejectedError("fanout_estimate", "every extra owner needs its own finite estimate");
    }
  }
}

function localComplete(prompt: string, cacheHit: boolean): string {
  if (cacheHit) return "[local cache]";
  return `[local degrade] ${prompt.slice(0, 200)}`;
}

export interface SendDeps {
  registry?: MockRegistry;
  cache?: PromptCache;
  budget?: Budget;
}

export async function send(opts: SendOptions, deps: SendDeps = {}): Promise<SendResult> {
  const registry = deps.registry ?? defaultRegistry;
  const cache = deps.cache ?? defaultCache;
  const budget = deps.budget ?? defaultBudget;

  assertSendable(opts.classify, opts.fanOutEnabled);

  const requestId = opts.requestId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tokenLog: SendResult["tokenLog"] = [];

  const runOne = async (owner: Owner, isRetry: boolean): Promise<string> => {
    const payload = buildBrief(owner, opts.prompt);
    assertNoRepoDump(owner, payload);
    if (owner === "local") {
      return localComplete(opts.prompt, opts.classify.cacheHit);
    }
    const backend = registry.get(owner);
    return backend.complete({
      payload,
      requestId,
      isRetry,
      signal: opts.signal,
    });
  };

  const owners: Owner[] = (() => {
    if (opts.fanOutEnabled === true && opts.classify.fanOut && opts.classify.fanOut !== false) {
      return [...opts.classify.fanOut.owners];
    }
    return [opts.classify.owner];
  })();

  if (opts.fanOutEnabled === false && owners.length !== 1) {
    throw new SendRejectedError("silent_fanout", "no silent two-model path when fan-out is off");
  }

  let degraded = false;
  const parts: string[] = [];

  for (const owner of owners) {
    if (opts.signal?.aborted) {
      throw new SendRejectedError("stopped", "Stop cancelled in-flight call");
    }
    try {
      const text = await runOne(owner, false);
      parts.push(text);
      const b = registry.get(owner);
      tokenLog.push({
        owner,
        tokensIn: owner === "local" ? 0 : b.tokensIn,
        tokensOut: owner === "local" ? 0 : b.tokensOut,
        costUsd: owner === "local" ? 0 : opts.classify.estCostUsd,
      });
    } catch (err) {
      if (err instanceof SendRejectedError) throw err;
      if (err instanceof RateLimitError) {
        try {
          const retryText = await runOne(owner, true);
          parts.push(retryText);
          tokenLog.push({
            owner,
            tokensIn: registry.get(owner).tokensIn,
            tokensOut: registry.get(owner).tokensOut,
            costUsd: opts.classify.estCostUsd,
          });
        } catch (retryErr) {
          if (retryErr instanceof RateLimitError || retryErr instanceof Error) {
            degraded = true;
            parts.push(localComplete(opts.prompt, false));
            tokenLog.push({ owner: "local", tokensIn: 0, tokensOut: 0, costUsd: 0 });
          } else {
            throw retryErr;
          }
        }
      } else if (err && (err as Error).name === "AbortError") {
        throw new SendRejectedError("stopped", "Stop cancelled in-flight call");
      } else {
        throw err;
      }
    }
  }

  const text = parts.join("\n---\n");
  const charged = degraded ? 0 : opts.classify.estCostUsd;
  if (charged > 0 && !opts.classify.cacheHit) {
    budget.record(
      opts.fanOutEnabled && opts.classify.fanOut
        ? opts.classify.fanOut.estCostUsd
        : charged,
    );
  }
  if (opts.classify.cacheHit === false) {
    cache.set(opts.prompt, text, opts.classify.owner);
  }

  return {
    ok: true,
    owner: degraded ? "local" : opts.classify.owner,
    text,
    degraded,
    tokenLog,
  };
}
