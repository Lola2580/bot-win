(function () {
  "use strict";

  const RESULT_API =
    "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";
  const PLANNER_BASE =
    "https://wingo.oss-ap-southeast-7.aliyuncs.com/WinGo_1_";

  const CFG = {
    betAmount: 10,
    mode: "planner",
    payout: 1.96,
    martingaleMode: "auto",
    multiplier: 2,
    manualSequence: [10, 20, 40, 80, 160],
    maxConsecutiveLosses: 5,
    maxSessionLoss: 1000,
    triggerLevel: 0,
  };

  const S = {
    running: false, busy: false,
    consecutiveLosses: 0,
    obsLossStreak: 0,
    armed: false,
    wins: 0, losses: 0, paperPL: 0,
    latestIssue: null, latestNumber: null,
    lastCheck: "—",
    signals: [], settled: new Set(),
    plannerCorrect: 0, plannerTotal: 0,
    lastError: "", stopReason: "",
    timer: null,
  };

  const $ = (id) => document.getElementById("wg-" + id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[WINGO-BOT]", ...a);

  // ---------- DATA ----------
  function getList(j) {
    return ([j?.data?.list, j?.data?.data?.list, j?.list,
             j?.data?.records, j?.records].find(Array.isArray) || []);
  }
  function normalizeRow(row) {
    const ri = row?.issueNumber ?? row?.issue ?? row?.period;
    const rn = row?.number ?? row?.result ?? row?.openNumber;
    if (ri == null || rn == null) return null;
    const issue = String(ri), number = Number(rn);
    if (!/^\d+$/.test(issue) || !Number.isInteger(number) || number < 0 || number > 9)
      return null;
    return { issue, number, side: number >= 5 ? "BIG" : "SMALL" };
  }
  async function fetchResults() {
    const r = await fetch(RESULT_API + "?_=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("Results HTTP " + r.status);
    const j = await r.json();
    const rows = getList(j).map(normalizeRow).filter(Boolean);
    if (!rows.length) throw new Error("Results: unrecognized");
    rows.sort((a, b) => (BigInt(a.issue) > BigInt(b.issue) ? -1 : 1));
    return rows;
  }
  const nextIssue = (i) => (BigInt(i) + 1n).toString();
  async function fetchPlanner(target) {
    const r = await fetch(PLANNER_BASE + target + "_planner4_bs_plan",
      { cache: "no-store" });
    if (!r.ok) throw new Error("Planner HTTP " + r.status);
    const j = await r.json();
    const raw = String(j?.content?.bs ?? "").toLowerCase();
    if (raw === "b") return "BIG";
    if (raw === "s") return "SMALL";
    throw new Error("Planner: no content.bs");
  }

  // ---------- STAKE MATH ----------
  function parseSeq(str) {
    return String(str).split(/[,\s]+/)
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => Math.round(n * 100) / 100);
  }
  function currentStake() {
    const lvl = S.consecutiveLosses;
    let stake;
    if (CFG.martingaleMode === "manual") {
      const seq = CFG.manualSequence;
      stake = seq.length ? seq[Math.min(lvl, seq.length - 1)] : CFG.betAmount;
    } else {
      stake = CFG.betAmount * Math.pow(CFG.multiplier, lvl);
    }
    return Math.round(stake * 100) / 100;
  }
  function totalRisk() {
    if (CFG.martingaleMode === "manual") {
      return Math.round(CFG.manualSequence.reduce((a, b) => a + b, 0) * 100) / 100;
    }
    let sum = 0;
    for (let i = 0; i < CFG.maxConsecutiveLosses; i++) {
      sum += CFG.betAmount * Math.pow(CFG.multiplier, i);
    }
    return Math.round(sum * 100) / 100;
  }

  function onWin() {
    S.armed = false;
    S.consecutiveLosses = 0;
    S.obsLossStreak = 0;
  }
  function onLoss() {
    S.consecutiveLosses += 1;
    const maxL = CFG.martingaleMode === "manual"
      ? CFG.manualSequence.length
      : CFG.maxConsecutiveLosses;
    if (S.consecutiveLosses >= Math.max(1, maxL)) {
      stopBot(`Max levels (${maxL}) reached`);
    }
  }

  // ---------- BET ----------
  async function placeRealBet(side, amount) {
    const btn = document.querySelector(
      side === "BIG" ? ".Betting__C-foot-b" : ".Betting__C-foot-s");
    if (!btn) throw new Error("Bet button missing for " + side);
    btn.click();
    await sleep(1200);
    const inputs = Array.from(document.querySelectorAll('input[type="number"]'));
    const input = inputs.find((el) => Number(el.value) > 0) || inputs[0];
    if (!input) throw new Error("Amount input missing");
    input.value = String(amount);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(400);
    const b2 = Array.from(document.querySelectorAll("button"))
      .find((b) => /total|₹\s*\d|confirm|place/i.test((b.innerText || "").trim()));
    if (!b2) throw new Error("Confirm button missing");
    b2.click();
    await sleep(700);
  }

  // ---------- SIGNALS ----------
  function addSignal(target, side, wasBet) {
    if (S.signals.some((x) => x.target === target)) return;
    S.signals.unshift({
      target, side,
      stake: wasBet ? currentStake() : 0,
      level: wasBet ? S.consecutiveLosses + 1 : 0,
      status: "PENDING", actual: null, number: null,
      timestamp: new Date().toLocaleTimeString(),
      wasBet: !!wasBet,
    });
    S.signals = S.signals.slice(0, 50);
    render();
  }
  function settleAvailable(rows) {
    for (const sig of S.signals) {
      if (sig.status !== "PENDING") continue;
      const res = rows.find((r) => r.issue === sig.target);
      if (!res || S.settled.has(sig.target)) continue;
      S.settled.add(sig.target);
      sig.actual = res.side;
      sig.number = res.number;
      S.plannerTotal++;

      const won = sig.side === res.side;
      if (won) {
        S.plannerCorrect++;
        sig.status = "WIN";
        if (sig.wasBet) {
          S.wins++;
          S.paperPL += sig.stake * (CFG.payout - 1);
          onWin();
        } else {
          S.obsLossStreak = 0;
        }
      } else {
        sig.status = "LOSS";
        if (sig.wasBet) {
          S.losses++;
          S.paperPL -= sig.stake;
          onLoss();
        } else {
          if ((CFG.triggerLevel || 0) > 0) {
            S.obsLossStreak += 1;
            if (S.obsLossStreak >= CFG.triggerLevel) {
              S.armed = true;
              S.consecutiveLosses = 0;
              S.obsLossStreak = 0;
            }
          }
        }
      }

      if (S.paperPL <= -CFG.maxSessionLoss) {
        stopBot(`Max session loss ₹${CFG.maxSessionLoss}`);
      }
    }
  }

  async function tick() {
    if (!S.running || S.busy) return;
    S.busy = true;
    try {
      const rows = await fetchResults();
      const latest = rows[0];
      S.latestIssue = latest.issue;
      S.latestNumber = latest.number;
      S.lastCheck = new Date().toLocaleTimeString();
      S.lastError = "";
      settleAvailable(rows);
      const target = nextIssue(latest.issue);
      const known = S.signals.some((x) => x.target === target);
      if (!known) {
        let side;
        if (CFG.mode === "planner") side = await fetchPlanner(target);
        else if (CFG.mode === "random") side = Math.random() > 0.5 ? "BIG" : "SMALL";
        else if (CFG.mode === "big") side = "BIG";
        else side = "SMALL";
        const conf = await fetchResults();
        if (conf[0].issue === latest.issue) {
          if ((CFG.triggerLevel || 0) === 0) S.armed = true;
          const shouldBet = S.armed;
          addSignal(target, side, shouldBet);
          if (shouldBet) {
            try { await placeRealBet(side, currentStake()); }
            catch (e) {
              S.lastError = "Bet: " + (e.message || String(e));
              stopBot("Bet failed");
            }
          }
        }
      }
      const final = await fetchResults();
      settleAvailable(final);
      S.latestIssue = final[0].issue;
      S.latestNumber = final[0].number;
      render();
    } catch (e) {
      S.lastError = e.message || String(e); render();
    } finally { S.busy = false; }
  }

  // ---------- CSS ----------
  const CSS = `
    @keyframes wgPulse {
      0%,100% { box-shadow: 0 0 0 0 rgba(34,211,238,0.55); }
      50%     { box-shadow: 0 0 0 10px rgba(34,211,238,0); }
    }
    @keyframes wgFadeIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }

        .wg-panel {
      position: relative;
      background: rgba(15, 18, 32, 0.85); /* Thoda dark kiya taaki text saaf dikhe */
      backdrop-filter: blur(28px) saturate(180%);
      -webkit-backdrop-filter: blur(28px) saturate(180%);
      border-radius: 16px;
      padding: 12px;
      width: 100%;            /* Full width */
      max-width: 100%;        /* Mobile pe poora screen cover kare */
      max-height: 95dvh;      /* Dynamic viewport height (address bar hide/show handle karega) */
      overflow-y: auto;
      color: #e8e6f0;
      font: 12px/1.4 system-ui, -apple-system, sans-serif;
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 20px 60px rgba(0,0,0,0.9);
      animation: wgFadeIn 0.28s ease;
      scrollbar-width: none; 
      -ms-overflow-style: none;
    }
    .wg-panel::-webkit-scrollbar { display: none; width: 0; height: 0; }
    .wg-panel::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 20px;
      background:
        radial-gradient(circle at 15% 0%, rgba(103,232,249,0.10), transparent 55%),
        radial-gradient(circle at 100% 100%, rgba(245,197,24,0.08), transparent 55%);
      pointer-events: none;
    }
    .wg-panel::after {
      content: '';
      position: absolute;
      top: 0; left: 20%;
      width: 60%;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(245,197,24,0.5), rgba(103,232,249,0.5), transparent);
      pointer-events: none;
    }
    .wg-panel > * { position: relative; z-index: 1; }

    .wg-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 10px; padding-bottom: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }
    .wg-brand { display: flex; align-items: center; gap: 7px; }
    .wg-brand-icon {
      width: 26px; height: 26px;
      background: linear-gradient(135deg, #f5c518, #f59e0b);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px;
      box-shadow: 0 3px 10px rgba(245,197,24,0.35), inset 0 1px 0 rgba(255,255,255,0.4);
    }
    .wg-brand-title {
      font-size: 13px; font-weight: 800; letter-spacing: 0.3px;
      background: linear-gradient(135deg, #f5c518, #fde68a, #67e8f9);
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    .wg-brand-sub {
      font-size: 8.5px; color: #64748b; letter-spacing: 0.7px;
      text-transform: uppercase; margin-top: 1px;
    }
    .wg-status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #475569; transition: 0.3s;
    }
    .wg-status-dot.live {
      background: #22d3ee;
      animation: wgPulse 1.8s ease-out infinite;
    }
    .wg-close {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      width: 26px; height: 26px; border-radius: 8px;
      color: #94a3b8; cursor: pointer;
      font-size: 12px; transition: 0.2s;
      display: flex; align-items: center; justify-content: center;
    }
    .wg-close:hover { background: rgba(239,68,68,0.15); color: #f87171; border-color: rgba(239,68,68,0.3); }

    .wg-stat-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 5px;
      margin-bottom: 8px;
    }
    .wg-stat {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px; padding: 7px 9px;
    }
    .wg-stat:hover { border-color: rgba(103,232,249,0.2); }
    .wg-stat-label {
      font-size: 8px; text-transform: uppercase; letter-spacing: 1px;
      color: #64748b; font-weight: 700; margin-bottom: 1px;
    }
    .wg-stat-value {
      font-size: 12.5px; font-weight: 700;
      color: #f1f5f9;
      font-variant-numeric: tabular-nums;
    }
    .wg-stat-value.gold { color: #f5c518; }
    .wg-stat-value.cyan { color: #67e8f9; }

    .wg-acc-card {
      background: linear-gradient(135deg, rgba(103,232,249,0.10), rgba(245,197,24,0.08));
      border: 1px solid rgba(103,232,249,0.2);
      border-radius: 10px; padding: 8px 10px;
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 8px;
    }
    .wg-acc-label {
      font-size: 9px; color: #94a3b8;
      text-transform: uppercase; letter-spacing: 1px; font-weight: 700;
    }
    .wg-acc-value {
      font-size: 13px; font-weight: 800;
      font-variant-numeric: tabular-nums;
    }

    .wg-wlp {
      display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px;
      margin-bottom: 8px;
    }
    .wg-wlp-item {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 9px; padding: 7px;
      text-align: center;
    }
    .wg-wlp-label {
      font-size: 8px; color: #64748b; text-transform: uppercase;
      letter-spacing: 1px; font-weight: 700;
    }
    .wg-wlp-value {
      font-size: 12.5px; font-weight: 800; margin-top: 1px;
      font-variant-numeric: tabular-nums;
    }

    .wg-section {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px; padding: 9px 10px;
      margin-bottom: 8px;
      transition: border-color 0.2s;
    }
    .wg-section:hover { border-color: rgba(103,232,249,0.18); }
    .wg-section-title {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 7px;
    }
    .wg-section-title-text {
      font-size: 9px; color: #94a3b8; text-transform: uppercase;
      letter-spacing: 1px; font-weight: 700;
    }

    .wg-tabs {
      display: flex; gap: 3px;
      background: rgba(0,0,0,0.3);
      padding: 3px; border-radius: 7px;
    }
    .wg-tab {
      flex: 1; padding: 4px 7px; border: 0;
      background: transparent; color: #64748b;
      font-size: 9.5px; font-weight: 700; border-radius: 5px;
      cursor: pointer; transition: 0.2s;
    }
    .wg-tab.active {
      background: linear-gradient(135deg, rgba(245,197,24,0.9), rgba(245,158,11,0.9));
      color: #0a0a14;
      box-shadow: 0 2px 8px rgba(245,197,24,0.3);
    }

    .wg-field { margin-bottom: 6px; }
    .wg-field:last-child { margin-bottom: 0; }
    .wg-field-label {
      font-size: 8.5px; color: #94a3b8;
      text-transform: uppercase; letter-spacing: 0.9px;
      font-weight: 700; margin-bottom: 3px; display: block;
    }
    .wg-input, .wg-select {
      width: 100%; padding: 7px 9px;
      background: rgba(0,0,0,0.35);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 7px;
      color: #f1f5f9; font-size: 12px; font-weight: 600;
      box-sizing: border-box; outline: none;
      font-variant-numeric: tabular-nums;
      transition: 0.2s;
    }
    .wg-input:focus, .wg-select:focus {
      border-color: rgba(245,197,24,0.6);
      box-shadow: 0 0 0 3px rgba(245,197,24,0.12);
    }
    .wg-input::placeholder { color: #475569; }
    .wg-input[readonly] {
      background: rgba(245,197,24,0.08);
      border-color: rgba(245,197,24,0.3);
      color: #f5c518;
      font-weight: 800;
      cursor: not-allowed;
    }

    .wg-presets { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 5px; }
    .wg-preset {
      padding: 3px 8px; font-size: 9.5px; font-weight: 700;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px; color: #cbd5e1;
      cursor: pointer; transition: 0.2s;
    }
    .wg-preset:hover {
      background: rgba(245,197,24,0.15);
      border-color: rgba(245,197,24,0.35);
      color: #f5c518;
    }

    .wg-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .wg-chip {
      padding: 2.5px 7px; font-size: 9px; font-weight: 700;
      background: rgba(103,232,249,0.08);
      border: 1px solid rgba(103,232,249,0.2);
      border-radius: 6px; color: #67e8f9;
      font-variant-numeric: tabular-nums;
    }
    .wg-chip.active {
      background: linear-gradient(135deg, rgba(245,197,24,0.9), rgba(245,158,11,0.9));
      color: #0a0a14; border-color: #f5c518;
      box-shadow: 0 2px 8px rgba(245,197,24,0.4);
    }
    .wg-chip-num { font-size: 7.5px; opacity: 0.65; margin-right: 2px; }

    .wg-risk-info {
      display: flex; justify-content: space-between;
      margin-top: 6px; padding-top: 6px;
      border-top: 1px solid rgba(255,255,255,0.06);
      font-size: 9.5px;
    }
    .wg-risk-info span { color: #94a3b8; }
    .wg-risk-info b { color: #f5c518; font-variant-numeric: tabular-nums; }

    .wg-controls {
      display: grid; grid-template-columns: 1fr 1fr; gap: 5px;
      margin-bottom: 5px;
    }
    .wg-btn {
      padding: 9px 8px; border: 0; border-radius: 9px;
      font-size: 10.5px; font-weight: 800; letter-spacing: 0.3px;
      cursor: pointer; transition: 0.15s;
      display: flex; align-items: center; justify-content: center; gap: 4px;
      text-transform: uppercase;
    }
    .wg-btn:active { transform: translateY(1px) scale(0.99); }
    .wg-btn-start {
      background: linear-gradient(135deg, #f5c518, #f59e0b);
      color: #0a0a14;
      box-shadow: 0 4px 14px rgba(245,197,24,0.35), inset 0 1px 0 rgba(255,255,255,0.3);
    }
    .wg-btn-start:hover { box-shadow: 0 6px 20px rgba(245,197,24,0.5); }
    .wg-btn-stop {
      background: linear-gradient(135deg, #dc2626, #991b1b);
      color: #fff;
      box-shadow: 0 4px 14px rgba(220,38,38,0.3), inset 0 1px 0 rgba(255,255,255,0.15);
    }
    .wg-btn-ghost {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.09);
      color: #cbd5e1;
    }
    .wg-btn-ghost:hover {
      background: rgba(255,255,255,0.09);
      border-color: rgba(255,255,255,0.15);
    }
    .wg-btn-arm {
      background: linear-gradient(135deg, rgba(34,211,238,0.85), rgba(8,145,178,0.85));
      color: #001f27;
      box-shadow: 0 4px 14px rgba(34,211,238,0.35);
    }
    .wg-btn-arm:hover { box-shadow: 0 6px 20px rgba(34,211,238,0.5); }
    .wg-btn-arm.on {
      background: linear-gradient(135deg, #f5c518, #f59e0b);
      color: #0a0a14;
      box-shadow: 0 4px 14px rgba(245,197,24,0.5);
    }

    .wg-footer-info {
      font-size: 9px; color: #64748b; line-height: 1.5;
      margin-top: 6px; padding-top: 6px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .wg-error {
      font-size: 9.5px; color: #f87171;
      margin-top: 4px; overflow-wrap: anywhere;
      font-family: monospace;
    }

    .wg-history-item {
      padding: 5px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      font-size: 10px;
    }
    .wg-history-item:last-child { border-bottom: 0; }
    .wg-history-head {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 2px;
    }
    .wg-history-period { font-weight: 700; color: #cbd5e1; font-family: monospace; font-size: 10px; }
    .wg-history-status { font-weight: 800; font-size: 9px; letter-spacing: 0.4px; }
    .wg-history-meta { color: #64748b; font-size: 9px; }
  `;

  // ---------- UI ----------
  let elements = {}, float, overlay;

  function render() {
    if (!elements.runningStatus) return;

    const stake = currentStake();
    const risk = totalRisk();

    const dot = $("dot");
    if (dot) dot.classList.toggle("live", S.running);

    $("status").textContent = S.running
      ? `${S.armed
          ? `ARMED · L${S.consecutiveLosses + 1} bet`
          : (CFG.triggerLevel > 0
              ? `WAITING (${S.obsLossStreak || 0}/${CFG.triggerLevel})`
              : "WAITING")} · ${S.lastCheck}`
      : S.stopReason ? `Stopped · ${S.stopReason}` : "Idle";
    $("status").style.color = S.running
      ? (S.armed ? "#f5c518" : "#67e8f9")
      : (S.stopReason ? "#f87171" : "#64748b");

    $("period").textContent = S.latestIssue || "—";
    $("result").textContent = S.latestNumber == null
      ? "—" : `${S.latestNumber} · ${S.latestNumber >= 5 ? "BIG" : "SMALL"}`;
    $("result").className = "wg-stat-value " +
      (S.latestNumber == null ? "" : S.latestNumber >= 5 ? "gold" : "cyan");

    const p = S.signals.find((x) => x.status === "PENDING");
    $("prediction").textContent = p ? p.side : "—";
    $("prediction").className = "wg-stat-value " +
      (p ? (p.side === "BIG" ? "gold" : "cyan") : "");
    $("target").textContent = p ? p.target : "—";

    const acc = S.plannerTotal ? (S.plannerCorrect / S.plannerTotal) * 100 : null;
    const accEl = $("acc");
    if (acc == null) {
      accEl.textContent = "—";
      accEl.style.color = "#64748b";
    } else {
      accEl.textContent = `${acc.toFixed(1)}% · ${S.plannerCorrect}/${S.plannerTotal}`;
      accEl.style.color = acc >= 52 ? "#34d399" : acc >= 48 ? "#f5c518" : "#f87171";
    }

    $("wins").textContent = S.wins;
    $("losses").textContent = S.losses;
    $("pl").textContent = `₹${S.paperPL.toFixed(2)}`;
    $("pl").style.color = S.paperPL >= 0 ? "#34d399" : "#f87171";

    $("current-stake").textContent = `₹${stake.toFixed(2)}`;
    $("total-risk").textContent = `₹${risk.toFixed(2)}`;

    const totalBetEl = $("total-bet");
    if (totalBetEl) totalBetEl.value = `₹${risk.toFixed(2)}`;

    const seq = CFG.martingaleMode === "manual"
      ? CFG.manualSequence
      : Array.from({ length: CFG.maxConsecutiveLosses },
          (_, i) => CFG.betAmount * Math.pow(CFG.multiplier, i));

    const chips = $("chips");
    if (chips) {
      const activeIdx = S.armed ? S.consecutiveLosses : -1;
      chips.innerHTML = seq.map((v, i) => {
        const active = i === activeIdx ? "active" : "";
        return `<span class="wg-chip ${active}"><span class="wg-chip-num">L${i + 1}</span>₹${v.toFixed(2)}</span>`;
      }).join("");
    }

    const hist = $("history");
    if (hist) {
      const h = S.signals.slice(0, 10);
      hist.innerHTML = h.length ? h.map((x) => {
        const color = x.status === "WIN" ? "#34d399"
          : x.status === "LOSS" ? "#f87171" : "#f5c518";
        const modeTag = x.wasBet ? `L${x.level} · ₹${x.stake.toFixed(2)}` : "OBS";
        return `<div class="wg-history-item">
          <div class="wg-history-head">
            <span class="wg-history-period">${x.target}</span>
            <span class="wg-history-status" style="color:${color}">${x.status}</span>
          </div>
          <div class="wg-history-meta">
            ${x.side} · ${modeTag}
            ${x.actual ? ` → ${x.actual} (${x.number})` : ""}
          </div>
        </div>`;
      }).join("") : '<div style="color:#64748b;font-size:9.5px;padding:4px 0;">No signals yet</div>';
    }

    $("error").textContent = S.lastError || "";
    $("error").style.display = S.lastError ? "block" : "none";

    if (window.__wingoArmUI) window.__wingoArmUI();
  }

  function buildUI() {
    if (!document.getElementById("wg-premium-css")) {
      const st = document.createElement("style");
      st.id = "wg-premium-css";
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    document.getElementById("wingo-float-icon")?.remove();
    document.getElementById("wingo-overlay")?.remove();

    float = document.createElement("div");
    float.id = "wingo-float-icon";
    float.style.cssText = `position:fixed;bottom:26px;right:18px;width:52px;height:52px;
      background:rgba(245,197,24,0.18);
      backdrop-filter:blur(18px) saturate(180%);
      -webkit-backdrop-filter:blur(18px) saturate(180%);
      border:1px solid rgba(245,197,24,0.45);
      border-radius:50%;
      box-shadow:0 12px 28px rgba(245,197,24,0.35),
        0 0 0 1px rgba(255,255,255,0.08) inset,
        0 1px 0 rgba(255,255,255,0.25) inset;
      display:flex;align-items:center;justify-content:center;font-size:22px;
      cursor:grab;touch-action:none;user-select:none;z-index:999999;
      transition:transform 0.2s, box-shadow 0.2s;`;
    float.textContent = "🎯";
    float.onmouseenter = () => { float.style.transform = "scale(1.08)"; };
    float.onmouseleave = () => { float.style.transform = "scale(1)"; };
    document.body.appendChild(float);

    (() => {
      let active = false, sx = 0, sy = 0, moved = false;
      const start = (cx, cy) => {
        const r = float.getBoundingClientRect();
        active = true; moved = false; sx = cx - r.left; sy = cy - r.top;
      };
      const move = (cx, cy) => {
        if (!active) return;
        moved = true;
        float.style.left = cx - sx + "px";
        float.style.top = cy - sy + "px";
        float.style.right = "auto"; float.style.bottom = "auto";
      };
      const end = () => { setTimeout(() => { active = false; }, 50); };
      float.addEventListener("mousedown", (e) => { e.preventDefault(); start(e.clientX, e.clientY); });
      document.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
      document.addEventListener("mouseup", end);
      float.addEventListener("touchstart", (e) => { const t = e.touches[0]; if (t) { e.preventDefault(); start(t.clientX, t.clientY); } }, { passive: false });
      document.addEventListener("touchmove", (e) => { const t = e.touches[0]; if (t) { e.preventDefault(); move(t.clientX, t.clientY); } }, { passive: false });
      document.addEventListener("touchend", end);
      float.addEventListener("click", () => {
        if (moved) return;
        overlay.style.display = "flex";
        render();
      });
    })();

    overlay = document.createElement("div");
    overlay.id = "wingo-overlay";
       overlay.style.cssText = `position:fixed;inset:0;z-index:2147483647;
      background:rgba(0,0,0,0.85);backdrop-filter:blur(5px);
      -webkit-backdrop-filter:blur(5px);
      display:none;align-items:center;justify-content:center;
      padding:8px; /* 14px se kam karke 8px kiya */`;
    overlay.innerHTML = `
      <div class="wg-panel">
        <div class="wg-header">
          <div class="wg-brand">
            <div class="wg-brand-icon">⚡</div>
            <div>
              <div class="wg-brand-title">WINGO</div>
              <div class="wg-brand-sub">Real · v9</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:7px;">
            <div id="wg-dot" class="wg-status-dot"></div>
            <button id="wg-close" class="wg-close">✕</button>
          </div>
        </div>

        <div class="wg-stat-grid">
          <div class="wg-stat">
            <div class="wg-stat-label">Latest Period</div>
            <div id="wg-period" class="wg-stat-value">—</div>
          </div>
          <div class="wg-stat">
            <div class="wg-stat-label">Latest Result</div>
            <div id="wg-result" class="wg-stat-value">—</div>
          </div>
          <div class="wg-stat">
            <div class="wg-stat-label">Prediction</div>
            <div id="wg-prediction" class="wg-stat-value">—</div>
          </div>
          <div class="wg-stat">
            <div class="wg-stat-label">Target Period</div>
            <div id="wg-target" class="wg-stat-value">—</div>
          </div>
        </div>

        <div class="wg-acc-card">
          <span class="wg-acc-label">🧠 Planner Accuracy</span>
          <b id="wg-acc" class="wg-acc-value">—</b>
        </div>

        <div class="wg-wlp">
          <div class="wg-wlp-item">
            <div class="wg-wlp-label">Wins</div>
            <div id="wg-wins" class="wg-wlp-value" style="color:#34d399;">0</div>
          </div>
          <div class="wg-wlp-item">
            <div class="wg-wlp-label">Losses</div>
            <div id="wg-losses" class="wg-wlp-value" style="color:#f87171;">0</div>
          </div>
          <div class="wg-wlp-item">
            <div class="wg-wlp-label">P / L</div>
            <div id="wg-pl" class="wg-wlp-value" style="color:#34d399;">₹0</div>
          </div>
        </div>

        <div class="wg-section">
          <div class="wg-section-title">
            <span class="wg-section-title-text">💰 Martingale</span>
            <div class="wg-tabs" style="width:auto;">
              <button class="wg-tab active" data-mode="auto" id="wg-tab-auto">AUTO</button>
              <button class="wg-tab" data-mode="manual" id="wg-tab-manual">MANUAL</button>
            </div>
          </div>

          <div id="wg-auto-panel">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;">
              <div class="wg-field">
                <label class="wg-field-label">Bet ₹</label>
                <input id="wg-base" type="number" min="1" value="10" class="wg-input">
              </div>
              <div class="wg-field">
                <label class="wg-field-label">Mult</label>
                <input id="wg-mult" type="number" min="1.1" step="0.1" value="2" class="wg-input">
              </div>
              <div class="wg-field">
                <label class="wg-field-label">Levels</label>
                <input id="wg-levels" type="number" min="1" max="12" value="5" class="wg-input">
              </div>
            </div>
          </div>

          <div id="wg-manual-panel" style="display:none;">
            <div class="wg-field">
              <label class="wg-field-label">Custom Sequence</label>
              <input id="wg-seq" type="text" class="wg-input"
                placeholder="e.g. 10, 25, 60, 150, 400" value="10, 20, 40, 80, 160">
            </div>
            <div class="wg-presets">
              <button class="wg-preset" data-preset="flat">Flat</button>
              <button class="wg-preset" data-preset="15x">1.5×</button>
              <button class="wg-preset" data-preset="2x">2×</button>
              <button class="wg-preset" data-preset="3x">3×</button>
              <button class="wg-preset" data-preset="fib">Fib</button>
              <button class="wg-preset" data-preset="clear">Clear</button>
            </div>
          </div>

          <div class="wg-chips" id="wg-chips"></div>

          <div class="wg-field" style="margin-top:6px;margin-bottom:0;">
            <label class="wg-field-label">Total Bet ₹ (auto)</label>
            <input id="wg-total-bet" type="text" class="wg-input" readonly>
          </div>

          <div class="wg-risk-info">
            <span>Current: <b id="wg-current-stake">₹10</b></span>
            <span>Risk: <b id="wg-total-risk">₹310</b></span>
          </div>
        </div>

        <div class="wg-section" style="margin-top:0;">
          <div class="wg-section-title">
            <span class="wg-section-title-text">🎯 Loss Trigger</span>
            <span id="wg-arm-state" style="font-size:8.5px;font-weight:800;letter-spacing:0.7px;color:#64748b;">DISARMED</span>
          </div>

          <div class="wg-field" style="margin-bottom:6px;">
            <label class="wg-field-label">Trigger (0 = every, N = after N losses)</label>
            <input id="wg-trigger" type="number" min="0" max="10" value="0" class="wg-input">
          </div>

          <div class="wg-controls">
            <button id="wg-arm-on" class="wg-btn wg-btn-arm">ARM</button>
            <button id="wg-arm-off" class="wg-btn wg-btn-ghost">DISARM</button>
          </div>
        </div>

        <div class="wg-section">
          <div class="wg-field" style="margin-bottom:0;">
            <label class="wg-field-label">Prediction Mode</label>
            <select id="wg-mode" class="wg-select">
              <option value="planner" selected>🧠 Planner API</option>
              <option value="random">🎲 Random</option>
              <option value="big">🔺 Always BIG</option>
              <option value="small">🔻 Always SMALL</option>
            </select>
          </div>
        </div>

        <div class="wg-controls">
          <button id="wg-start" class="wg-btn wg-btn-start">▶ START</button>
          <button id="wg-stop" class="wg-btn wg-btn-stop">⏹ STOP</button>
        </div>
        <div class="wg-controls" style="grid-template-columns:1fr 1fr;">
          <button id="wg-reset" class="wg-btn wg-btn-ghost">↺ RESET</button>
        </div>

        <div style="margin-top:6px;font-size:9.5px;color:#64748b;">
          Status: <span id="wg-status">Idle</span>
        </div>
        <div class="wg-error" id="wg-error" style="display:none;"></div>

        <div class="wg-section" style="margin-top:8px;">
          <div class="wg-section-title">
            <span class="wg-section-title-text">📋 Recent Signals</span>
          </div>
          <div id="wg-history" style="max-height:130px;overflow:auto;scrollbar-width:none;-ms-overflow-style:none;"></div>
        </div>

        <div class="wg-footer-info">
          ⚠️ Real money. Martingale long-run loss. Total planned stake se zyada wallet mein na rakho.
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const historyEl = $("history");
    if (historyEl) {
      const s = document.createElement("style");
      s.textContent = "#wg-history::-webkit-scrollbar{display:none;}";
      document.head.appendChild(s);
    }

    elements = {
      runningStatus: $("status"),
      dot: $("dot"),
    };

    $("close").onclick = () => (overlay.style.display = "none");
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.style.display = "none";
    });

    $("tab-auto").onclick = () => switchTab("auto");
    $("tab-manual").onclick = () => switchTab("manual");

    overlay.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.onclick = () => applyPreset(btn.dataset.preset);
    });

    $("seq").addEventListener("input", (e) => {
      const seq = parseSeq(e.target.value);
      if (seq.length) {
        CFG.manualSequence = seq;
        render();
      }
    });

    ["base", "mult", "levels"].forEach((id) => {
      $(id).addEventListener("input", () => {
        CFG.betAmount = Math.max(1, Number($("base").value) || 10);
        CFG.multiplier = Math.max(1.1, Number($("mult").value) || 2);
        CFG.maxConsecutiveLosses = Math.min(12, Math.max(1, Math.floor(Number($("levels").value) || 5)));
        render();
      });
    });

    $("mode").addEventListener("change", (e) => { CFG.mode = e.target.value; });

    const triggerInput = $("trigger");
    if (triggerInput) {
      triggerInput.value = String(CFG.triggerLevel || 0);
      triggerInput.addEventListener("input", (e) => {
        const v = Math.max(0, Math.min(10, Math.floor(Number(e.target.value) || 0)));
        CFG.triggerLevel = v;
        e.target.value = String(v);
        render();
      });
    }

    const armStateEl = $("arm-state");
    const armOnBtn = $("arm-on");
    const armOffBtn = $("arm-off");

    function updateArmUI() {
      if (!armStateEl) return;
      if (S.armed) {
        armStateEl.textContent = "ARMED";
        armStateEl.style.color = "#f5c518";
        armOnBtn.classList.add("on");
        armOnBtn.textContent = "ARMED ✓";
      } else {
        armStateEl.textContent = "DISARMED";
        armStateEl.style.color = "#64748b";
        armOnBtn.classList.remove("on");
        armOnBtn.textContent = "ARM";
      }
    }
    window.__wingoArmUI = updateArmUI;

    armOnBtn.onclick = () => {
      if (!S.running) { alert("Bot start karo pehle."); return; }
      S.armed = true;
      S.consecutiveLosses = 0;
      S.obsLossStreak = 0;
      updateArmUI();
      render();
    };

    armOffBtn.onclick = () => {
      S.armed = false;
      S.consecutiveLosses = 0;
      S.obsLossStreak = 0;
      updateArmUI();
      render();
    };

    $("start").onclick = startBot;
    $("stop").onclick = () => stopBot("manual");
    $("reset").onclick = resetStats;

    updateArmUI();
    render();
  }

  function switchTab(mode) {
    CFG.martingaleMode = mode;
    $("tab-auto").classList.toggle("active", mode === "auto");
    $("tab-manual").classList.toggle("active", mode === "manual");
    $("auto-panel").style.display = mode === "auto" ? "block" : "none";
    $("manual-panel").style.display = mode === "manual" ? "block" : "none";
    render();
  }

  function applyPreset(name) {
    const base = Math.max(1, Number($("base").value) || CFG.betAmount);
    const levels = Math.max(1, Number($("levels").value) || CFG.maxConsecutiveLosses);
    let seq = [];
    if (name === "flat") {
      seq = Array.from({ length: levels }, () => base);
    } else if (name === "15x") {
      let v = base;
      for (let i = 0; i < levels; i++) { seq.push(Math.round(v * 100) / 100); v *= 1.5; }
    } else if (name === "2x") {
      let v = base;
      for (let i = 0; i < levels; i++) { seq.push(Math.round(v * 100) / 100); v *= 2; }
    } else if (name === "3x") {
      let v = base;
      for (let i = 0; i < levels; i++) { seq.push(Math.round(v * 100) / 100); v *= 3; }
    } else if (name === "fib") {
      let a = base, b = base;
      for (let i = 0; i < levels; i++) {
        seq.push(Math.round(a * 100) / 100);
        [a, b] = [b, a + b];
      }
    } else if (name === "clear") {
      seq = [];
    }
    if (seq.length || name === "clear") {
      CFG.manualSequence = seq;
      if (seq.length) $("seq").value = seq.join(", ");
      else $("seq").value = "";
      render();
    }
  }

  function startBot() {
    if (S.running) return;

    CFG.betAmount = Math.max(1, Number($("base").value) || CFG.betAmount);
    CFG.multiplier = Math.max(1.1, Number($("mult").value) || CFG.multiplier);
    CFG.maxConsecutiveLosses = Math.min(12, Math.max(1, Math.floor(Number($("levels").value) || 5)));
    CFG.mode = $("mode").value || CFG.mode;

    const t = Math.max(0, Math.min(10, Math.floor(Number($("trigger").value) || 0)));
    CFG.triggerLevel = t;
    $("trigger").value = String(t);

    if (CFG.martingaleMode === "manual") {
      const seq = parseSeq($("seq").value);
      if (!seq.length) { alert("Manual sequence is empty."); return; }
      CFG.manualSequence = seq;
    }

    if (!confirm(`⚠️ REAL BETTING\n\nTotal planned stake: ₹${totalRisk().toFixed(2)}\nTrigger: ${CFG.triggerLevel === 0 ? "every signal" : `after ${CFG.triggerLevel} losses`}\n\nReal money will be placed. Continue?`)) return;

    S.running = true;
    S.stopReason = "";
    S.armed = (CFG.triggerLevel || 0) === 0;
    S.consecutiveLosses = 0;
    S.obsLossStreak = 0;
    render();
    tick();
    S.timer = setInterval(() => { if (S.running && !S.busy) tick(); }, 2500);
  }

  function stopBot(reason = "") {
    S.running = false;
    S.stopReason = reason;
    clearInterval(S.timer);
    S.timer = null;
    render();
  }

  function resetStats() {
    if (!confirm("Reset all stats and signals?")) return;
    S.signals = []; S.settled.clear();
    S.wins = 0; S.losses = 0; S.paperPL = 0;
    S.plannerCorrect = 0; S.plannerTotal = 0;
    S.consecutiveLosses = 0;
    S.obsLossStreak = 0;
    S.armed = false;
    S.lastError = ""; S.stopReason = "";
    render();
  }

  buildUI();

  window.bot = {
    start: startBot,
    stop: () => stopBot("manual"),
    arm: () => {
      if (!S.running) { alert("Bot start karo pehle."); return; }
      S.armed = true; S.consecutiveLosses = 0; S.obsLossStreak = 0;
      render();
    },
    disarm: () => { S.armed = false; S.consecutiveLosses = 0; S.obsLossStreak = 0; render(); },
    setTriggerLevel: (n) => {
      const v = Math.max(0, Math.min(10, Math.floor(Number(n) || 0)));
      CFG.triggerLevel = v;
      if (document.getElementById("wg-trigger")) {
        document.getElementById("wg-trigger").value = String(v);
      }
      render();
    },
    status: () => ({
      running: S.running,
      mode: CFG.mode,
      martingale: CFG.martingaleMode,
      armed: S.armed,
      currentLevel: S.armed ? S.consecutiveLosses + 1 : 0,
      triggerLevel: CFG.triggerLevel || 0,
      obsLossStreak: S.obsLossStreak || 0,
      currentStake: currentStake(),
      totalRisk: totalRisk(),
      sequence: CFG.martingaleMode === "manual" ? CFG.manualSequence : null,
      wins: S.wins, losses: S.losses, pl: S.paperPL,
      plannerAcc: S.plannerTotal ? (S.plannerCorrect / S.plannerTotal) * 100 : null,
      samples: S.plannerTotal,
    }),
    setSequence: (arr) => {
      const s = parseSeq(arr.join(","));
      if (s.length) { CFG.manualSequence = s; $("seq").value = s.join(", "); render(); }
    },
    help: () => console.log("bot.start() | bot.stop() | bot.arm() | bot.disarm() | bot.setTriggerLevel(0) | bot.status()"),
  };
  log("✅ WINGO ULTIMATE v9 loaded (real mode only, manual trigger).");
})();
