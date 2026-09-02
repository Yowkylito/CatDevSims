/**
 * Steward orchestrator. The only path the UI should talk to.
 * UI never calls a backend itself.
 */
import { classify } from "./classify.ts";
import { send, canSend } from "./send.ts";
import { defaultRegistry, MockRegistry } from "./backends.ts";
import { PromptCache, defaultCache } from "./cache.ts";
import { Budget, defaultBudget } from "./budget.ts";
import { StopController, defaultStop } from "./stop.ts";
import { openHistory, type HistoryStore } from "./history.ts";
import { createKeychain, type Keychain } from "./keychain.ts";
import type { ClassifyRequest, ClassifyResult, SendResult } from "./types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface StewardOptions {
  registry?: MockRegistry;
  cache?: PromptCache;
  budget?: Budget;
  stop?: StopController;
  history?: HistoryStore;
  keychain?: Keychain;
  historyFile?: string;
  keychainDir?: string;
}

export class Steward {
  readonly registry: MockRegistry;
  readonly cache: PromptCache;
  readonly budget: Budget;
  readonly stop: StopController;
  readonly history: HistoryStore;
  readonly keychain: Keychain;
  lastClassify: ClassifyResult | null = null;

  constructor(opts: StewardOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.cache = opts.cache ?? defaultCache;
    this.budget = opts.budget ?? defaultBudget;
    this.stop = opts.stop ?? defaultStop;
    this.history = opts.history ?? openHistory(opts.historyFile ?? join(tmpdir(), "steward-runs.sqlite"));
    this.keychain = opts.keychain ?? createKeychain(opts.keychainDir);
  }

  classify(req: ClassifyRequest): ClassifyResult {
    const result = classify(req, { cache: this.cache });
    this.lastClassify = result;
    return result;
  }

  sendEnabled(result: ClassifyResult, fanOutEnabled: boolean): boolean {
    return canSend(result, fanOutEnabled);
  }

  async send(prompt: string, result: ClassifyResult, fanOutEnabled: boolean): Promise<SendResult> {
    const out = await send(
      { prompt, classify: result, fanOutEnabled, signal: this.stop.signal },
      { registry: this.registry, cache: this.cache, budget: this.budget },
    );
    this.history.record({
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      owner: out.owner,
      promptPreview: prompt,
      tokensIn: out.tokenLog.reduce((a, t) => a + t.tokensIn, 0),
      tokensOut: out.tokenLog.reduce((a, t) => a + t.tokensOut, 0),
      costUsd: out.tokenLog.reduce((a, t) => a + t.costUsd, 0),
      blocked: 0,
      cacheHit: result.cacheHit ? 1 : 0,
      degraded: out.degraded ? 1 : 0,
    });
    return out;
  }

  hardStop(): void {
    this.stop.stop();
  }

  async hasKeys(): Promise<boolean> {
    const a = await this.keychain.get("openai");
    const b = await this.keychain.get("anthropic");
    return Boolean(a || b);
  }
}
