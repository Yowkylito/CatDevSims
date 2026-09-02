/**
 * Spend-first composer.
 * The UI never calls a backend. All classify/send/stop go through window.__STEWARD__
 * (Tauri invoke on Mac, mock bridge in dev).
 */
const $ = (id) => document.getElementById(id);

function bridge() {
  if (window.__STEWARD__) return window.__STEWARD__;
  throw new Error("Steward core bridge missing — UI must not call backends itself");
}

let last = null;
let fanOutEnabled = false;

function money(n) {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(4)}`;
}

function renderBudget(snap) {
  $("daily-label").textContent = `${money(snap.dailySpentUsd)} / ${money(snap.dailyCapUsd)}`;
  $("monthly-label").textContent = `${money(snap.monthlySpentUsd)} / ${money(snap.monthlyCapUsd)}`;
  $("daily-fill").style.width = `${Math.min(100, (snap.dailyFraction ?? 0) * 100)}%`;
  $("monthly-fill").style.width = `${Math.min(100, (snap.monthlyFraction ?? 0) * 100)}%`;
}

function gateSend(result) {
  const unblocked = result && result.blocked === false && Number.isFinite(result.estCostUsd);
  const paidOk = result && (result.owner === "local" || result.estCostUsd > 0);
  const fanOk = !fanOutEnabled ? result && result.fanOut === false : true;
  $("send-btn").disabled = !(unblocked && paidOk && fanOk);
}

function showClassify(result) {
  last = result;
  $("owner-pill").textContent = `owner: ${result.owner}${result.cacheHit ? " (cache)" : ""}`;
  $("cost-pill").textContent = `est. ${money(result.estCostUsd)}`;
  $("reason").textContent = result.reason + (result.blocked ? ` — blocked (${result.blockReason || "yes"})` : "");
  gateSend(result);
}

$("fanout").addEventListener("change", (e) => {
  fanOutEnabled = e.target.checked;
  last = null;
  $("send-btn").disabled = true;
  $("reason").textContent = "Re-classify after changing fan-out.";
});

$("classify-btn").addEventListener("click", async () => {
  const prompt = $("prompt").value;
  const result = await bridge().classify({
    prompt,
    fanOutEnabled,
    dailySpentUsd: bridge().budget().dailySpentUsd,
    dailyCapUsd: bridge().budget().dailyCapUsd,
    perRunCapUsd: bridge().budget().perRunCapUsd ?? 5,
  });
  renderBudget(bridge().budget());
  showClassify(result);
  $("out").textContent = JSON.stringify(
    {
      owner: result.owner,
      estCostUsd: result.estCostUsd,
      blocked: result.blocked,
      fanOut: result.fanOut,
      cacheHit: result.cacheHit,
    },
    null,
    2,
  );
});

$("send-btn").addEventListener("click", async () => {
  if (!last || $("send-btn").disabled) return;
  $("send-btn").disabled = true;
  try {
    const out = await bridge().send($("prompt").value, last, fanOutEnabled);
    $("out").textContent = out.text || JSON.stringify(out, null, 2);
    renderBudget(bridge().budget());
  } catch (err) {
    $("out").textContent = String(err && err.message ? err.message : err);
  } finally {
    gateSend(last);
  }
});

$("stop-btn").addEventListener("click", () => {
  bridge().stop();
  $("out").textContent = "Stop: in-flight calls cancelled.";
});

$("prompt").addEventListener("input", () => {
  last = null;
  $("send-btn").disabled = true;
});

window.addEventListener("DOMContentLoaded", () => {
  if (!window.__STEWARD__) {
    $("out").textContent =
      "Mock bridge not injected. In Tauri, src-tauri registers classify/send/stop. Send stays dead.";
  } else {
    renderBudget(window.__STEWARD__.budget());
  }
  $("send-btn").disabled = true;
});
