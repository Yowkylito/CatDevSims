/**
 * Local heuristic classifier. FREE: zero tokens, zero dollars.
 * MUST NOT tick any backend mock/API counter.
 */
import type { ClassifyRequest, ClassifyResult, Owner } from "./types.ts";
import { isPaidOwner } from "./types.ts";
import { PromptCache, defaultCache } from "./cache.ts";

const RATES: Record<Exclude<Owner, "local">, { in: number; out: number }> = {
  chatgpt: { in: 2.5, out: 10.0 },
  cursor: { in: 3.0, out: 15.0 },
  claude: { in: 3.0, out: 15.0 },
};

const PAID_MIN_USD = 0.00012;

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function pickOwner(prompt: string): { owner: Owner; reason: string } {
  const p = prompt.toLowerCase();
  const scores: Record<Exclude<Owner, "local">, number> = {
    chatgpt: 0,
    cursor: 0,
    claude: 0,
  };
  const reasons: string[] = [];

  const cursorHit =
    /\b(pull request|pull-request|\bprs\b|\bpr\b|diff|repo|repository|merge request|code review)\b/.test(p) ||
    /\b(file|files|filepath|source tree|workspace|monorepo)\b/.test(p) ||
    /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|swift|cs|cpp|h)\b/.test(p) ||
    /\b(package\.json|tsconfig|cargo\.toml|dockerfile|gitignore)\b/.test(p);

  if (cursorHit) {
    scores.cursor += 6;
    reasons.push("repo/files/PRs → cursor");
  }

  const chatgptHit =
    /\b(draft|summar(?:y|ize|ise)|tldr|rewrite|paraphrase|email|tweet|blog|outline|bullet points|subject line)\b/.test(p);
  if (chatgptHit) {
    scores.chatgpt += 6;
    reasons.push("draft/summary → chatgpt");
  }

  const claudeHit =
    /\b(reason|reasoning|prove|proof|architect(?:ure)?|algorithm|invariant|multi-step|trade-?off|complex|long[- ]form)\b/.test(p) ||
    (/\b(implement|refactor|debug|type[- ]level|formal)\b/.test(p) && prompt.length > 320);
  if (claudeHit) {
    scores.claude += 6;
    reasons.push("hard reasoning / long coding → claude");
  }

  if (prompt.length > 1600) {
    scores.claude += 2;
    reasons.push("long prompt");
  } else if (prompt.length < 240 && scores.chatgpt === 0 && scores.cursor === 0) {
    scores.chatgpt += 1;
    reasons.push("short general → chatgpt");
  }

  let owner: Exclude<Owner, "local"> = "chatgpt";
  let best = -1;
  for (const k of ["claude", "cursor", "chatgpt"] as const) {
    if (scores[k] > best) {
      best = scores[k];
      owner = k;
    }
  }
  if (best <= 0) {
    owner = prompt.length > 900 ? "claude" : "chatgpt";
    reasons.push(owner === "claude" ? "default long → claude" : "default → chatgpt");
  }

  return { owner, reason: reasons[0] ?? `heuristic → ${owner}` };
}

function estimateCost(owner: Owner, tokensIn: number, tokensOut: number): number {
  if (owner === "local") return 0;
  const rates = RATES[owner];
  const raw = (tokensIn / 1_000_000) * rates.in + (tokensOut / 1_000_000) * rates.out;
  if (!Number.isFinite(raw) || raw <= 0) return PAID_MIN_USD;
  return Math.max(PAID_MIN_USD, Number(raw.toFixed(8)));
}

function extraFanOutOwners(primary: Owner): Owner[] {
  const all: Owner[] = ["chatgpt", "cursor", "claude"];
  return all.filter((o) => o !== primary);
}

export interface ClassifyDeps {
  cache?: PromptCache;
}

export function classify(req: ClassifyRequest, deps: ClassifyDeps = {}): ClassifyResult {
  const cache = deps.cache ?? defaultCache;
  const prompt = req.prompt ?? "";

  if (cache.has(prompt)) {
    return {
      owner: "local",
      estTokensIn: 0,
      estTokensOut: 0,
      estCostUsd: 0,
      fanOut: false,
      cacheHit: true,
      blocked: false,
      reason: "cache hit → local (free, no backend)",
    };
  }

  const picked = pickOwner(prompt);
  let owner: Owner = picked.owner;
  const estTokensIn = estimateTokensFromText(prompt);
  const estTokensOut =
    owner === "claude"
      ? Math.min(1800, Math.max(256, Math.floor(estTokensIn * 0.6)))
      : owner === "cursor"
        ? Math.min(1200, Math.max(192, Math.floor(estTokensIn * 0.4)))
        : Math.min(800, Math.max(128, Math.floor(estTokensIn * 0.35)));

  let estCostUsd = estimateCost(owner, estTokensIn, estTokensOut);

  if (isPaidOwner(owner) && !(estCostUsd > 0 && Number.isFinite(estCostUsd))) {
    return {
      owner,
      estTokensIn,
      estTokensOut,
      estCostUsd: Number.NaN,
      fanOut: false,
      cacheHit: false,
      blocked: true,
      blockReason: "missing_estimate",
      reason: "paid owner missing finite cost estimate",
    };
  }

  let blocked = false;
  let blockReason: ClassifyResult["blockReason"];
  let reason = picked.reason;

  // Keep the intended owner on a cap block so the composer is honest.
  // Send stays dead (blocked). Do not rewrite to local — that looks like a legal zero.
  if (req.perRunCapUsd >= 0 && estCostUsd > req.perRunCapUsd + 1e-12) {
    blocked = true;
    blockReason = "per_run_cap";
    reason = `per-run cap $${req.perRunCapUsd} — refuse`;
  } else if (req.dailyCapUsd >= 0 && req.dailySpentUsd + estCostUsd > req.dailyCapUsd + 1e-12) {
    blocked = true;
    blockReason = "daily_cap";
    reason = `daily cap $${req.dailyCapUsd} — refuse`;
  }

  let fanOut: ClassifyResult["fanOut"] = false;
  if (req.fanOutEnabled === true && !blocked && isPaidOwner(owner)) {
    const owners: Owner[] = [owner, ...extraFanOutOwners(owner)];
    let extraCost = 0;
    const extrasOk = owners.every((o) => {
      if (o === "local") return false;
      const c = estimateCost(o, estTokensIn, estTokensOut);
      if (!(c > 0 && Number.isFinite(c))) return false;
      extraCost += c;
      return true;
    });
    if (extrasOk && owners.length > 1) {
      const fanCost = Number(extraCost.toFixed(8));
      // Fan-out that would blow a cap drops to ONE owner. Never three past a one-owner budget.
      if (req.perRunCapUsd >= 0 && fanCost > req.perRunCapUsd + 1e-12) {
        fanOut = false;
        reason = `${reason}; fan-out refused (per-run cap)`;
      } else if (
        req.dailyCapUsd >= 0 &&
        req.dailySpentUsd + fanCost > req.dailyCapUsd + 1e-12
      ) {
        fanOut = false;
        reason = `${reason}; fan-out refused (daily cap)`;
      } else {
        fanOut = { owners, estCostUsd: fanCost };
        reason = `${reason}; fan-out ${owners.join("+")}`;
      }
    }
  }

  const result: ClassifyResult = {
    owner,
    estTokensIn,
    estTokensOut,
    estCostUsd,
    fanOut,
    cacheHit: false,
    blocked,
    reason,
  };
  if (blockReason) result.blockReason = blockReason;
  return result;
}
