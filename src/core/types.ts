/** Steward core types. Local-first orchestrator contracts. */

export type Owner = "local" | "chatgpt" | "cursor" | "claude";

export interface ClassifyRequest {
  prompt: string;
  fanOutEnabled: boolean;
  dailySpentUsd: number;
  dailyCapUsd: number;
  perRunCapUsd: number;
}

export type BlockReason = "daily_cap" | "per_run_cap" | "missing_estimate";

export interface ClassifyResult {
  owner: Owner;
  estTokensIn: number;
  estTokensOut: number;
  estCostUsd: number;
  fanOut: false | { owners: Owner[]; estCostUsd: number };
  cacheHit: boolean;
  blocked: boolean;
  blockReason?: BlockReason;
  reason: string;
}

export interface TokenLog {
  owner: Owner;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export class SendRejectedError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "SendRejectedError";
    this.code = code;
  }
}

export interface SendOptions {
  prompt: string;
  classify: ClassifyResult;
  fanOutEnabled: boolean;
  requestId?: string;
  signal?: AbortSignal;
}

export interface SendResult {
  ok: boolean;
  owner: Owner;
  text: string;
  degraded: boolean;
  tokenLog: TokenLog[];
  error?: string;
}

export const PAID_OWNERS: readonly Owner[] = ["chatgpt", "cursor", "claude"];

export function isPaidOwner(owner: Owner): boolean {
  return owner === "chatgpt" || owner === "cursor" || owner === "claude";
}

export function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
