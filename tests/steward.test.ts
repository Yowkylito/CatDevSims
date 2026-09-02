import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classify } from "../src/core/classify.ts";
import { send, canSend, assertSendable } from "../src/core/send.ts";
import { MockRegistry } from "../src/core/backends.ts";
import { PromptCache } from "../src/core/cache.ts";
import { Budget } from "../src/core/budget.ts";
import { assertNoRepoDump, buildBrief, payloadContainsRepoPath } from "../src/core/payload.ts";
import { SendRejectedError, type ClassifyResult, type ClassifyRequest } from "../src/core/types.ts";
import { FileBackedKeychain } from "../src/core/keychain.ts";
import { SqliteHistory } from "../src/core/history.ts";
import { Steward } from "../src/core/orchestrator.ts";
import { StopController } from "../src/core/stop.ts";

const caps = {
  dailySpentUsd: 0,
  dailyCapUsd: 20,
  perRunCapUsd: 5,
};

function req(partial: Partial<ClassifyRequest> & { prompt: string }): ClassifyRequest {
  return {
    fanOutEnabled: false,
    ...caps,
    ...partial,
  };
}

function paidDraft(cache?: PromptCache): ClassifyResult {
  return classify(req({ prompt: "Draft a short summary of this weekly status email for the team." }), cache ? { cache } : {});
}

describe("Steward classify + send gate", () => {
  let registry: MockRegistry;
  let cache: PromptCache;
  let budget: Budget;

  beforeEach(() => {
    registry = new MockRegistry();
    cache = new PromptCache();
    budget = new Budget({ dailyCapUsd: 20, monthlyCapUsd: 50 });
  });

  test("1. Send with blocked === true is rejected", async () => {
    const blocked: ClassifyResult = {
      ...paidDraft(cache),
      blocked: true,
      blockReason: "daily_cap",
    };
    assert.equal(canSend(blocked, false), false);
    await assert.rejects(
      () => send({ prompt: "x", classify: blocked, fanOutEnabled: false }, { registry, cache, budget }),
      (err: unknown) => err instanceof SendRejectedError,
    );
    assert.equal(registry.totalCallCount(), 0);
  });

  test("2. Missing or non-finite estCostUsd is rejected", async () => {
    const base = paidDraft(cache);
    for (const bad of [NaN, Infinity, -Infinity]) {
      const result = { ...base, estCostUsd: bad, blocked: false };
      await assert.rejects(
        () => send({ prompt: "hi", classify: result, fanOutEnabled: false }, { registry, cache, budget }),
        (err: unknown) => err instanceof SendRejectedError && (err as SendRejectedError).code === "missing_estimate",
      );
    }
    assert.equal(registry.totalCallCount(), 0);
  });

  test("3. fanOutEnabled false: classify ticks 0; after Send mock call count === 1", async () => {
    assert.equal(registry.totalCallCount(), 0);
    const prompt = "Draft a summary of the product launch announcement in five bullets.";
    const result = classify(req({ prompt, fanOutEnabled: false }), { cache });
    assert.equal(registry.totalCallCount(), 0, "classify must not tick any backend mock");
    assert.equal(result.fanOut, false);
    assert.equal(result.blocked, false);
    assert.ok(Number.isFinite(result.estCostUsd));
    assert.notEqual(result.owner, "local");
    assert.ok(result.estCostUsd > 0);

    await send({ prompt, classify: result, fanOutEnabled: false }, { registry, cache, budget });
    assert.equal(registry.paidCallCount(), 1);
    assert.equal(registry.totalCallCount(), 1);
    assert.equal(registry.ownersCalled().length, 1);
  });

  test("4. Retry after 429 does not increment the mock counter", async () => {
    const prompt = "Draft a polite email thanking the customer for their feedback.";
    const result = classify(req({ prompt }), { cache });
    assert.equal(result.fanOut, false);
    const owner = result.owner;
    assert.ok(owner === "chatgpt" || owner === "cursor" || owner === "claude");
    registry.get(owner).queue429();

    const out = await send(
      { prompt, classify: result, fanOutEnabled: false, requestId: "retry-429" },
      { registry, cache, budget },
    );
    assert.equal(registry.get(owner).callCount, 1, "retry must not increment mock counter");
    assert.equal(registry.paidCallCount(), 1);
    assert.ok(out.ok);
  });

  test("5. fanOutEnabled === false but fanOut !== false fails", async () => {
    const result: ClassifyResult = {
      ...paidDraft(cache),
      fanOut: { owners: ["chatgpt", "claude"], estCostUsd: 0.02 },
      blocked: false,
    };
    assert.equal(canSend(result, false), false);
    await assert.rejects(
      () => send({ prompt: "hello", classify: result, fanOutEnabled: false }, { registry, cache, budget }),
      (err: unknown) => err instanceof SendRejectedError && (err as SendRejectedError).code === "fanout_mismatch",
    );
    assert.equal(registry.totalCallCount(), 0);
  });

  test("6. claude/chatgpt payload containing a repo path fails", () => {
    const dumps = [
      "please read /Users/ada/src/app/main.ts",
      "cd ~/src/widgets && ls",
      "open AndroidStudioProjects/Foo/app",
      "cat .git/config for remotes",
    ];
    for (const payload of dumps) {
      assert.equal(payloadContainsRepoPath(payload), true, payload);
      assert.throws(() => assertNoRepoDump("claude", payload), (err: unknown) => err instanceof SendRejectedError);
      assert.throws(() => assertNoRepoDump("chatgpt", payload), (err: unknown) => err instanceof SendRejectedError);
    }
    const brief = buildBrief(
      "claude",
      "Explain this code from /Users/ada/src/app and ~/src/widgets and AndroidStudioProjects/Foo and .git",
    );
    assert.equal(payloadContainsRepoPath(brief), false, "briefs must strip repo dumps");
  });

  test("7. Paid owner with estCostUsd === 0 cannot Send", async () => {
    const result: ClassifyResult = {
      owner: "claude",
      estTokensIn: 10,
      estTokensOut: 10,
      estCostUsd: 0,
      fanOut: false,
      cacheHit: false,
      blocked: false,
      reason: "forced zero",
    };
    assert.equal(canSend(result, false), false);
    await assert.rejects(
      () => send({ prompt: "reason about this", classify: result, fanOutEnabled: false }, { registry, cache, budget }),
      (err: unknown) => err instanceof SendRejectedError && (err as SendRejectedError).code === "missing_estimate",
    );
    for (const owner of ["chatgpt", "cursor", "claude"] as const) {
      const r = { ...result, owner, estCostUsd: 0 };
      assert.equal(canSend(r, false), false);
    }
    assert.equal(registry.totalCallCount(), 0);
  });

  test("8. No silent two-model path when fan-out is off", async () => {
    const prompt = "Draft a summary plus a subject line for this changelog.";
    const result = classify(req({ prompt, fanOutEnabled: false }), { cache });
    assert.equal(result.fanOut, false);
    await send({ prompt, classify: result, fanOutEnabled: false }, { registry, cache, budget });
    assert.equal(registry.paidCallCount(), 1);
    assert.equal(registry.ownersCalled().length, 1);
    const called = registry.ownersCalled();
    assert.equal(called.filter((o) => o !== "local").length, 1);
  });
});

describe("caps, cache, keys, history, stop", () => {
  test("daily cap refuses instead of blowing the cap", () => {
    const result = classify(
      req({
        prompt: "Draft a summary of the board memo.",
        dailySpentUsd: 19.999,
        dailyCapUsd: 20,
        perRunCapUsd: 5,
      }),
    );
    assert.equal(result.blocked, true);
    assert.equal(result.blockReason, "daily_cap");
    assert.equal(canSend(result, false), false);
  });

  test("per-run cap refuses", () => {
    const result = classify(
      req({
        prompt: "Reason through a long architecture: " + "x".repeat(8000),
        perRunCapUsd: 0.00000001,
        dailyCapUsd: 100,
      }),
    );
    assert.equal(result.blocked, true);
    assert.equal(result.blockReason, "per_run_cap");
  });

  test("identical prompts cache-hit local and do not tick mocks", async () => {
    const registry = new MockRegistry();
    const cache = new PromptCache();
    const budget = new Budget();
    const prompt = "Draft a one-line summary of the incident.";
    const first = classify(req({ prompt }), { cache });
    assert.equal(first.cacheHit, false);
    await send({ prompt, classify: first, fanOutEnabled: false }, { registry, cache, budget });
    const after = registry.totalCallCount();
    const second = classify(req({ prompt }), { cache });
    assert.equal(second.cacheHit, true);
    assert.equal(second.owner, "local");
    assert.equal(second.estCostUsd, 0);
    assert.equal(second.blocked, false);
    assert.equal(registry.totalCallCount(), after, "classify cache hit must not tick mocks");
  });

  test("legal zero is local + cacheHit only", () => {
    const c = new PromptCache();
    c.set("never-seen-xyz", "ok", "chatgpt");
    const hit = classify(req({ prompt: "never-seen-xyz" }), { cache: c });
    assert.equal(hit.owner, "local");
    assert.equal(hit.cacheHit, true);
    assert.equal(hit.estCostUsd, 0);
    assert.equal(canSend(hit, false), true);
  });

  test("classify never guesses 0 for paid owners", () => {
    const samples = [
      "Draft a tweet.",
      "Review the PR and the files in this repo.",
      "Reason through this algorithm and prove the invariant.",
    ];
    for (const prompt of samples) {
      const r = classify(req({ prompt, dailyCapUsd: 100, perRunCapUsd: 10 }));
      if (r.owner !== "local") {
        assert.ok(r.estCostUsd > 0, `${r.owner} estCostUsd should be > 0`);
        assert.ok(Number.isFinite(r.estCostUsd));
      }
    }
  });

  test("keychain file is ciphertext, never plaintext", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steward-kc-"));
    const kc = new FileBackedKeychain(dir);
    await kc.set("openai", "sk-secret-value-do-not-store-plain");
    const files = readdirSync(dir);
    assert.ok(files.length >= 1);
    for (const f of files) {
      const buf = readFileSync(join(dir, f), "utf8");
      assert.equal(buf.includes("sk-secret-value-do-not-store-plain"), false);
    }
    assert.equal(await kc.get("openai"), "sk-secret-value-do-not-store-plain");
  });

  test("history records tokens in/out", () => {
    const dir = mkdtempSync(join(tmpdir(), "steward-hist-"));
    const hist = new SqliteHistory(join(dir, "runs.sqlite"));
    hist.record({
      id: "r1",
      owner: "chatgpt",
      promptPreview: "Draft a summary",
      tokensIn: 12,
      tokensOut: 40,
      costUsd: 0.001,
      blocked: 0,
      cacheHit: 0,
      degraded: 0,
    });
    const rows = hist.list(10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokensIn, 12);
    assert.equal(rows[0].tokensOut, 40);
    hist.close();
  });

  test("Stop cancels in-flight calls", async () => {
    const registry = new MockRegistry();
    const stop = new StopController();
    stop.stop();
    const result = classify(req({ prompt: "Draft a summary of the notes." }));
    await assert.rejects(
      () =>
        send(
          { prompt: "Draft a summary of the notes.", classify: result, fanOutEnabled: false, signal: stop.signal },
          { registry, cache: new PromptCache(), budget: new Budget() },
        ),
      (err: unknown) => err instanceof SendRejectedError && (err as SendRejectedError).code === "stopped",
    );
  });

  test("Steward UI-facing sendEnabled stays dead until unblocked + finite cost", () => {
    const s = new Steward({
      registry: new MockRegistry(),
      cache: new PromptCache(),
      budget: new Budget(),
      historyFile: join(mkdtempSync(join(tmpdir(), "st-h-")), "runs.sqlite"),
      keychainDir: mkdtempSync(join(tmpdir(), "st-k-")),
    });
    const blocked = s.classify(
      req({ prompt: "Draft a summary.", dailySpentUsd: 20, dailyCapUsd: 20, perRunCapUsd: 0.00000001 }),
    );
    assert.equal(s.sendEnabled(blocked, false), false);
    const ok = s.classify(req({ prompt: "Draft a summary of the launch post." }));
    assert.equal(ok.blocked, false);
    assert.ok(Number.isFinite(ok.estCostUsd));
    assert.equal(s.sendEnabled(ok, false), true);
  });

  test("owner heuristic: chatgpt drafts, cursor repo, claude reasoning", () => {
    const d = classify(req({ prompt: "Draft a summary of the meeting notes." }));
    assert.equal(d.owner, "chatgpt");
    const c = classify(req({ prompt: "Review this pull request and the files in the repo." }));
    assert.equal(c.owner, "cursor");
    const k = classify(req({ prompt: "Reason through this architecture and prove the algorithm invariant." }));
    assert.equal(k.owner, "claude");
  });

  test("assertSendable is the single gate used by canSend", () => {
    const good = paidDraft();
    assert.doesNotThrow(() => assertSendable(good, false));
    assert.equal(canSend(good, false), true);
  });
});
