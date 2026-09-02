/**
 * Mock/offline backends (default until keys exist).
 * Call counters exist so tests can prove classify is free and fan-out stays off.
 */
import type { Owner } from "./types.ts";
import { estimateTokensFromText } from "./classify.ts";

export class RateLimitError extends Error {
  readonly status = 429;
  constructor(owner: Owner) {
    super(`429 Too Many Requests from ${owner}`);
    this.name = "RateLimitError";
  }
}

export interface CompleteArgs {
  payload: string;
  requestId: string;
  isRetry: boolean;
  signal?: AbortSignal;
}

export interface Backend {
  readonly owner: Owner;
  complete(args: CompleteArgs): Promise<string>;
}

export interface MockCounters {
  callCount: number;
  tokensIn: number;
  tokensOut: number;
  invocations: number;
}

class MockBackend implements Backend {
  readonly owner: Owner;
  callCount = 0;
  tokensIn = 0;
  tokensOut = 0;
  invocations = 0;
  nextStatus: number | null = null;
  private billedIds = new Set<string>();

  constructor(owner: Owner) {
    this.owner = owner;
  }

  reset(): void {
    this.callCount = 0;
    this.tokensIn = 0;
    this.tokensOut = 0;
    this.invocations = 0;
    this.nextStatus = null;
    this.billedIds.clear();
  }

  queue429(): void {
    this.nextStatus = 429;
  }

  async complete(args: CompleteArgs): Promise<string> {
    if (args.signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }

    this.invocations += 1;

    if (!args.isRetry && !this.billedIds.has(args.requestId)) {
      this.callCount += 1;
      this.billedIds.add(args.requestId);
    }

    if (this.nextStatus === 429) {
      this.nextStatus = null;
      throw new RateLimitError(this.owner);
    }

    const tin = estimateTokensFromText(args.payload);
    const tout = 96;
    this.tokensIn += tin;
    this.tokensOut += tout;

    return `[${this.owner} mock] ${args.payload.slice(0, 240)}`;
  }

  snapshot(): MockCounters {
    return {
      callCount: this.callCount,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      invocations: this.invocations,
    };
  }
}

export class MockRegistry {
  readonly chatgpt: MockBackend;
  readonly cursor: MockBackend;
  readonly claude: MockBackend;
  readonly local: MockBackend;

  constructor() {
    this.chatgpt = new MockBackend("chatgpt");
    this.cursor = new MockBackend("cursor");
    this.claude = new MockBackend("claude");
    this.local = new MockBackend("local");
  }

  get(owner: Owner): MockBackend {
    return this[owner];
  }

  reset(): void {
    this.chatgpt.reset();
    this.cursor.reset();
    this.claude.reset();
    this.local.reset();
  }

  totalCallCount(): number {
    return this.chatgpt.callCount + this.cursor.callCount + this.claude.callCount + this.local.callCount;
  }

  paidCallCount(): number {
    return this.chatgpt.callCount + this.cursor.callCount + this.claude.callCount;
  }

  ownersCalled(): Owner[] {
    const out: Owner[] = [];
    for (const o of ["chatgpt", "cursor", "claude", "local"] as const) {
      if (this[o].callCount > 0) out.push(o);
    }
    return out;
  }
}

export const defaultRegistry = new MockRegistry();
