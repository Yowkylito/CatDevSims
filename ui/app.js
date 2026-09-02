/* Steward composer. Live classify is local/free. Send stays dead without a finite estimate. */

const CHATGPT_IN = 0.15 / 1e6;
const CHATGPT_OUT = 0.60 / 1e6;
const CLAUDE_IN = 3.0 / 1e6;
const CLAUDE_OUT = 15.0 / 1e6;
const CURSOR_PER_1K = 0.002;

const state = {
  dailySpent: Number(localStorage.getItem("steward.dailySpent") || "0"),
  dailyCap: Number(localStorage.getItem("steward.dailyCap") || "5"),
  perRunCap: Number(localStorage.getItem("steward.perRunCap") || "1"),
  classify: null,
  abort: null,
  inFlight: false,
};

const $ = (id) => document.getElementById(id);

function hasTauri() {
  return !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
}

async function invoke(cmd, args) {
  const fn =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI__?.invoke ||
    window.__TAURI_INTERNALS__?.invoke;
  if (!fn) throw new Error("no tauri invoke");
  return fn(cmd, args);
}

function estimateTokens(prompt) {
  if (!prompt || !prompt.trim()) return [0, 0];
  const tin = Math.max(1, Math.ceil(prompt.length / 4));
  const tout = Math.ceil(tin * 0.5) + 32;
  return [tin, tout];
}

function estimateCost(owner, tin, tout) {
  if (owner === "local") return 0;
  if (owner === "chatgpt") return tin * CHATGPT_IN + tout * CHATGPT_OUT;
  if (owner === "claude") return tin * CLAUDE_IN + tout * CLAUDE_OUT;
  if (owner === "cursor") return ((tin + tout) / 1000) * CURSOR_PER_1K;
  return NaN;
}

function hasPathLike(prompt) {
  return prompt.split(/\s+/).some((raw) => {
    const t = raw.replace(/[.,;:()[\]{}"'`]/g, "");
    if (t.includes("://")) return false;
    if (t.includes("/") || t.includes("\\")) return true;
    return /\.(rs|ts|tsx|js|jsx|py|go|java|kt|toml|json|md|yml|yaml)$/i.test(t);
  });
}

function pickOwner(prompt) {
  const p = prompt.toLowerCase();
  const cursorKeys = [
    "pull request", "merge request", "this pr", "open a pr", "diff", "commit",
    "branch", "repo", "codebase", "working tree", "merge conflict",
  ];
  if (hasPathLike(prompt) || cursorKeys.some((k) => p.includes(k)) || p.split(/[^a-z0-9]+/).includes("pr")) {
    return "cursor";
  }
  const draftKeys = ["draft", "summar", "rewrite", "email", "bullet", "outline", "tldr", "proofread", "blurb"];
  if (draftKeys.some((k) => p.includes(k))) return "chatgpt";
  const claudeKeys = [
    "reason", "implement", "architect", "algorithm", "refactor", "prove",
    "step by step", "write a function", "debug", "complexity",
  ];
  if (prompt.length > 800 || claudeKeys.some((k) => p.includes(k))) return "claude";
  if (prompt.length > 280 || /fn |def |function |impl |class |```/.test(p)) return "claude";
  return "chatgpt";
}

function classifyLocal(prompt, fanOutEnabled) {
  const cacheKey = "steward.cache." + prompt;
  if (localStorage.getItem(cacheKey)) {
    return {
      owner: "local",
      estTokensIn: 0,
      estTokensOut: 0,
      estCostUsd: 0,
      fanOut: false,
      cacheHit: true,
      blocked: false,
      reason: "cache hit — local, $0, no backend",
    };
  }
  const owner = pickOwner(prompt);
  const [tin, tout] = estimateTokens(prompt);
  let cost = estimateCost(owner, tin, tout);
  const fanOut = fanOutEnabled
    ? { owners: [owner], estCostUsd: Number.isFinite(cost) ? cost : 0 }
    : false;

  const paid = owner === "chatgpt" || owner === "cursor" || owner === "claude";
  if (!Number.isFinite(cost) || (paid && (cost === 0 || (tin === 0 && tout === 0)))) {
    return {
      owner, estTokensIn: tin, estTokensOut: tout, estCostUsd: 0, fanOut,
      cacheHit: false, blocked: true, blockReason: "missing_estimate",
      reason: "no finite cost estimate — send is dead",
    };
  }
  if (paid && cost > state.perRunCap) {
    return {
      owner, estTokensIn: tin, estTokensOut: tout, estCostUsd: cost, fanOut,
      cacheHit: false, blocked: true, blockReason: "per_run_cap",
      reason: `${owner} est $${cost.toFixed(6)} exceeds per-run cap $${state.perRunCap.toFixed(2)}`,
    };
  }
  const remaining = state.dailyCap - state.dailySpent;
  if (paid && cost > remaining) {
    return {
      owner, estTokensIn: tin, estTokensOut: tout, estCostUsd: cost, fanOut,
      cacheHit: false, blocked: true, blockReason: "daily_cap",
      reason: `${owner} est $${cost.toFixed(6)} exceeds remaining daily $${remaining.toFixed(2)}`,
    };
  }
  return {
    owner, estTokensIn: tin, estTokensOut: tout, estCostUsd: cost, fanOut,
    cacheHit: false, blocked: false,
    reason: `${owner} · est $${cost.toFixed(6)} · ${tin} in / ${tout} out`,
  };
}

function sendEnabled(c) {
  if (!c) return false;
  if (c.blocked) return false;
  if (!Number.isFinite(c.estCostUsd)) return false;
  const paid = c.owner === "chatgpt" || c.owner === "cursor" || c.owner === "claude";
  if (paid && c.estCostUsd === 0) return false;
  return true;
}

function paintBudget() {
  const monthlyCap = state.dailyCap * 20;
  const monthlySpent = state.dailySpent;
  $("daily-fig").textContent = `$${state.dailySpent.toFixed(4)} / $${state.dailyCap.toFixed(2)}`;
  $("monthly-fig").textContent = `$${monthlySpent.toFixed(4)} / $${monthlyCap.toFixed(2)}`;
  const dp = Math.min(100, (state.dailySpent / state.dailyCap) * 100 || 0);
  const mp = Math.min(100, (monthlySpent / monthlyCap) * 100 || 0);
  $("daily-fill").style.width = dp + "%";
  $("monthly-fill").style.width = mp + "%";
  $("daily-fill").className = "fill" + (dp >= 100 ? " over" : dp >= 80 ? " warn" : "");
  $("monthly-fill").className = "fill" + (mp >= 100 ? " over" : mp >= 80 ? " warn" : "");
}

function paintClassify(c) {
  state.classify = c;
  $("owner").textContent = c.owner;
  $("owner").className = "owner" + (c.blocked ? " blocked-owner" : "");
  $("cost").textContent = Number.isFinite(c.estCostUsd)
    ? `$${c.estCostUsd.toFixed(6)}`
    : "$non-finite";
  $("tokens").textContent = `${c.estTokensIn} / ${c.estTokensOut}`;
  $("reason").textContent = c.reason;
  if (c.blocked) {
    $("block").classList.remove("hidden");
    $("block").textContent = `BLOCKED (${c.blockReason || "unknown"}) — send is dead`;
  } else {
    $("block").classList.add("hidden");
  }
  $("send").disabled = !sendEnabled(c) || state.inFlight;
}

async function refreshClassify() {
  const prompt = $("prompt").value;
  const fanOutEnabled = $("fanout").checked;
  let c;
  if (hasTauri()) {
    try {
      c = await invoke("classify_prompt", { prompt, fanOutEnabled });
    } catch (e) {
      c = classifyLocal(prompt, fanOutEnabled);
    }
  } else {
    c = classifyLocal(prompt, fanOutEnabled);
  }
  paintClassify(c);
}

async function doSend() {
  const c = state.classify;
  if (!sendEnabled(c)) return;
  const prompt = $("prompt").value;
  const fanOutEnabled = $("fanout").checked;
  state.inFlight = true;
  $("send").disabled = true;
  $("call-flag").classList.remove("hidden");
  $("output").textContent = "backend call in flight (not hidden behind animation)";
  state.abort = new AbortController();

  try {
    let out;
    if (hasTauri()) {
      out = await invoke("send_prompt", { prompt, fanOutEnabled });
    } else {
      if (c.cacheHit && c.owner === "local") {
        out = {
          ok: true,
          owner: "local",
          text: localStorage.getItem("steward.cache." + prompt) || "(cache)",
          degraded: false,
          costUsd: 0,
        };
      } else {
        const payload = (c.owner === "claude" || c.owner === "chatgpt")
          ? "Brief (no repo dump):\n" + prompt.slice(0, 720)
          : prompt;
        if ((c.owner === "claude" || c.owner === "chatgpt") &&
            (/\/Users\//.test(payload) || /[A-Za-z]:[\\/]/.test(payload))) {
          throw new Error("claude/chatgpt payload must not contain a repo path");
        }
        out = {
          ok: true,
          owner: c.owner,
          text: `[${c.owner} mock] ${payload}`,
          degraded: false,
          costUsd: c.estCostUsd,
        };
        localStorage.setItem("steward.cache." + prompt, out.text);
      }
    }
    $("output").textContent = JSON.stringify(out, null, 2);
    if (out.ok && out.costUsd > 0) {
      state.dailySpent += out.costUsd;
      localStorage.setItem("steward.dailySpent", String(state.dailySpent));
      paintBudget();
    }
    if (hasTauri()) {
      try {
        const n = await invoke("mock_call_count");
        $("mock-count").textContent = "mock calls: " + n;
      } catch (_) { /* ignore */ }
    }
  } catch (err) {
    $("output").textContent = "SEND DEAD: " + (err.message || String(err));
  } finally {
    state.inFlight = false;
    $("call-flag").classList.add("hidden");
    $("send").disabled = !sendEnabled(state.classify);
    refreshClassify();
  }
}

function doStop() {
  if (state.abort) state.abort.abort();
  if (hasTauri()) {
    invoke("stop_send", {}).catch(() => {});
  }
  state.inFlight = false;
  $("call-flag").classList.add("hidden");
  $("output").textContent = "stopped";
  $("send").disabled = !sendEnabled(state.classify);
}

$("prompt").addEventListener("input", refreshClassify);
$("fanout").addEventListener("change", refreshClassify);
$("send").addEventListener("click", doSend);
$("stop").addEventListener("click", doStop);

$("env-badge").textContent = hasTauri() ? "tauri + local heuristic" : "browser heuristic (no tauri)";
paintBudget();
refreshClassify();
