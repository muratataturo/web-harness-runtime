const $ = (s) => document.querySelector(s);
const state = {
  goal: null,
  history: [],
  tab: "plan",
  day: null,
  filter: null,
  mode: "demo",
  interactionMode: "approval",
  config: null,
  signature: "",
  navigation: 0,
  busy: false,
  choices: new Map(),
  notes: new Map(),
  budgets: new Map(),
};
const agentInfo = {
  concierge: ["Concierge", "全体をつなぐ、まとめ役"],
  stay: ["Stay", "宿と、くつろぎの時間"],
  food: ["Food", "おいしい時間を探す"],
  explore: ["Explore", "景色と体験を探す"],
  reviewer: ["Reviewer", "見落としを、もう一度"],
  career: ["Career", "働き方と、その先"],
  home: ["Home", "暮らしの場所を探す"],
  car: ["Mobility", "毎日の移動を考える"],
  you: ["あなた", ""],
};
const e = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const safeHref = (url) => {
  try {
    return new URL(url).protocol === "https:" ? url : "#";
  } catch {
    return "#";
  }
};
const avatar = (id, cls = "") =>
  `<span class="bot-avatar ${e(id)} ${cls}" aria-hidden="true"><span class="bot-ear"></span></span>`;
const time = (value) =>
  new Date(value).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
const statusLabels = {
  awaiting_direction: "あなたの選択を待っています",
  researching: "チームが調べています",
  awaiting_delight: "こだわりを選ぶ",
  synthesizing: "プランを整えています",
  completed: "プランができました",
  blocked: "候補を確認できませんでした",
  cancelled: "停止しました",
  interrupted: "再計画が必要です",
};
const workLabels = {
  pending: "順番待ち",
  running: "作業中",
  succeeded: "完了",
  failed: "取得できず",
  skipped: "保留",
};
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "接続に失敗しました");
  return data;
}
function notify(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("visible");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(
    () => $("#toast").classList.remove("visible"),
    4500,
  );
}
function landscape(life = false) {
  return `<svg class="landscape" viewBox="0 0 330 140" role="img" aria-label="${life ? "街と海のイラスト" : "箱根の山と湖のイラスト"}"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#e9e9d9"/><stop offset="1" stop-color="#dcdfc9"/></linearGradient></defs><rect x="3" y="3" width="324" height="134" rx="4" fill="url(#sky)"/><circle cx="252" cy="34" r="14" fill="#d5bc84"/>${life ? '<path d="M3 84Q80 73 145 82T327 78V137H3Z" fill="#a3bba5"/><path d="M3 99Q115 88 327 104V137H3Z" fill="#6c998b"/><path d="M40 94V59L67 40 93 59V94Z" fill="#7a8a66"/><path d="M114 99V75L141 58 168 75V99Z" fill="#94a17d"/><path d="M202 94V65L221 52 240 65V94Z" fill="#8c9776"/><rect x="59" y="70" width="13" height="24" fill="#d6dbc0"/><rect x="132" y="78" width="14" height="21" fill="#dce0c9"/><path d="M17 123L313 114" stroke="#d9ddc6" stroke-width="2"/>' : '<path d="M3 91L65 30 124 84 184 40 251 96 284 66 327 94V137H3Z" fill="#a4af89"/><path d="M3 110L71 72 139 109 206 66 280 108 327 96V137H3Z" fill="#71876b"/><path d="M3 114Q100 105 172 117T327 111V137H3Z" fill="#8aaca0"/><path d="M77 126Q155 117 257 129" stroke="#c0cfb8" stroke-width="1.3" fill="none"/><path d="M122 132Q167 127 208 133" stroke="#c0cfb8" stroke-width="1" fill="none"/><path d="M269 113V84M258 92H280M262 88H277M261 90V113M277 90V113" stroke="#a87953" stroke-width="3" fill="none"/>'}<path d="M21 25H63M34 19H76" stroke="#d4d8bf" stroke-width="2" stroke-linecap="round"/><path d="M287 45l5-3 5 3" stroke="#a4ad8e" fill="none" stroke-width="1.3"/></svg>`;
}
function roster() {
  const ids =
    state.goal?.scenario === "life"
      ? ["concierge", "career", "home", "car", "reviewer"]
      : ["concierge", "stay", "food", "explore", "reviewer"];
  $("#team-count").textContent = ids.length;
  $("#roster").innerHTML = ids
    .map((id) => {
      const working = state.goal?.tasks.some(
        (t) => t.agent === id && t.status === "running",
      );
      return `<button class="agent-row ${state.filter === id ? "active" : ""}" data-agent="${id}" aria-label="${agentInfo[id][0]}の発言を表示">${avatar(id)}<span><strong>${agentInfo[id][0]}</strong><small>${agentInfo[id][1]}</small></span><span class="presence ${working ? "working" : ""}">${working ? "● 作業中" : "·"}</span></button>`;
    })
    .join("");
  $("#history-count").textContent = state.history.length || "";
  $("#history").innerHTML =
    state.history
      .slice(0, 12)
      .map(
        (g) =>
          `<button data-goal="${e(g.id)}" class="${state.goal?.id === g.id ? "active" : ""}"><i></i><span>${e(g.title)}</span></button>`,
      )
      .join("") || '<div class="empty-state">ここに相談の履歴が残ります</div>';
}
function phaseBar() {
  if (!state.goal) {
    $("#phase-bar").innerHTML = "";
    return;
  }
  const statuses = [
    "awaiting_direction",
    "researching",
    "awaiting_delight",
    "completed",
  ];
  let index = statuses.indexOf(state.goal.status);
  if (state.goal.status === "synthesizing") index = 3;
  const labels =
    state.goal.scenario === "travel"
      ? ["旅の軸を決める", "チームで調べる", "ご褒美を選ぶ", "プラン完成"]
      : [
          "暮らしの軸を決める",
          "チームで調べる",
          "次の一歩を選ぶ",
          "プラン完成",
        ];
  $("#phase-bar").innerHTML = labels
    .map(
      (label, i) =>
        `${i ? '<span class="phase-separator" aria-hidden="true">›</span>' : ""}<span class="phase-item ${index === i ? "current" : index > i ? "done" : ""}" ${index === i ? 'aria-current="step"' : ""}><span>${index > i ? "✓" : i + 1}</span>${label}</span>`,
    )
    .join("");
}
function welcome() {
  return `<section class="welcome"><div class="welcome-icon" aria-hidden="true">✳</div><div class="eyebrow">A LITTLE HELP. A BIGGER POSSIBILITY.</div><h2>かなえたいことを、<br><span>頼れるチームと。</span></h2><p>旅の計画も、これからの暮らしも。<br>得意なことを持ち寄って、調べて、見直して。<br>あなたは、大切なところを選んでください。</p><button class="starter-card" data-start="travel"><span class="starter-art">↗</span><span><strong>余白のある、2泊3日の旅</strong><small>温泉・ごはん・寄り道を、一緒に考える</small></span><span class="arrow">→</span></button><button class="starter-card" data-start="life"><span class="starter-art life">⌂</span><span><strong>暮らしから考える、人生の次の一歩</strong><small>仕事・住まい・車。つながりまで、考える</small></span><span class="arrow">→</span></button><div class="welcome-foot"><span><i>✓</i> 大切な選択は、あなたに</span><span><i>✓</i> チームが互いにレビュー</span></div></section>`;
}
function renderMessage(message) {
  const id = message.from,
    label = agentInfo[id]?.[0] ?? id,
    kind = {
      handoff: "引き継ぎ",
      review: "レビュー",
      revision: "見直し",
      request: "依頼",
    }[message.kind];
  return `<article class="message ${id === "you" ? "user" : ""} ${message.kind}" data-message-id="${e(message.id)}"><div class="message-name ${e(id)}">${id === "you" ? "" : avatar(id)}<strong>${e(label)}</strong><time datetime="${e(message.createdAt)}">${time(message.createdAt)}</time>${kind ? `<span class="message-kind">${kind}${message.taskId ? " · " + e(message.to === "concierge" ? "チーム" : (agentInfo[message.to]?.[0] ?? message.to)) : ""}</span>` : ""}</div><div class="message-bubble">${e(message.text)}</div></article>`;
}
function renderGate(gate) {
  if (gate.status === "expired") return "";
  if (gate.status === "approved")
    return `<div class="decision-receipt">✓ ${e(gate.choices.find((c) => c.id === gate.selected)?.title)}<span>${gate.decidedBy === "runtime" ? "Autoで自動選択" : "あなたが選択"} · v${gate.revision}</span></div>`;
  const chosen =
    state.choices.get(gate.id) ??
    gate.choices.find((c) => c.recommended)?.id ??
    gate.choices[0].id;
  const note = state.notes.get(gate.id) ?? "";
  const budget = state.budgets.get(gate.id) ?? state.goal.budget;
  return `<form class="approval-card" data-gate="${e(gate.id)}"><div class="approval-kicker">✦ あなたに選んでほしいこと<span>選択待ち · v${gate.revision}</span></div><h2>${e(gate.title)}</h2><p class="approval-description">${e(gate.description)}</p><fieldset class="choice-list" aria-label="${e(gate.title)}"><legend class="sr-only">${e(gate.title)}</legend>${gate.choices.map((choice) => `<label class="choice"><input type="radio" name="choice-${e(gate.id)}" value="${e(choice.id)}" ${chosen === choice.id ? "checked" : ""} required><span class="choice-title">${e(choice.title)}${choice.recommended ? '<span class="recommended">おすすめ</span>' : ""}</span><p class="choice-description">${e(choice.description)}</p><p class="choice-tradeoff">↳ ${e(choice.tradeoff)}</p></label>`).join("")}</fieldset><textarea class="note-input" data-note="${e(gate.id)}" maxlength="1000" rows="1" placeholder="ほかに大切にしたいことがあれば（任意）" aria-label="追加のこだわり">${e(note)}</textarea><div class="approval-controls">${gate.kind === "direction" ? `<label class="budget-field">${state.goal.scenario === "travel" ? "旅全体の予算" : "月の固定費の目安"}<span>¥</span><input type="number" name="budget" data-budget="${e(gate.id)}" value="${e(budget)}" min="10000" max="2000000" step="1000" required aria-label="予算"></label>` : '<span class="budget-field">後から、見直すこともできます</span>'}<button type="submit" class="primary-button">${gate.kind === "direction" ? "この方針で調べる" : "この案でプランを整える"} <span>→</span></button></div><p class="approval-assurance">♧ ${state.goal.mode === "demo" ? "体験用のサンプル。予約・応募・購入にはつながりません。" : "この承認は調査方針の選択です。予約・応募・購入は行いません。"}</p></form>`;
}
function renderThread() {
  const box = $("#thread-scroll"),
    oldTop = box.scrollTop,
    atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  if (!state.goal) {
    $("#thread").innerHTML = welcome();
    return;
  }
  const goal = state.goal;
  const messages = goal.messages.filter(
    (m) =>
      m.revision === goal.revision &&
      (!state.filter || m.from === state.filter || m.to === state.filter),
  );
  let html = `<div class="date-divider">今日 <span>·</span> ${goal.mode === "demo" ? "体験用のチーム会話" : "実サイトを調査するチーム会話"} <span>·</span> v${goal.revision}</div>`;
  if (state.filter)
    html += `<div class="agent-filter">${e(agentInfo[state.filter][0])} に関連する発言を表示<button data-action="all-agents">すべての発言を見る ×</button></div>`;
  const gates = goal.gates.filter((g) => g.revision === goal.revision);
  const placed = new Set();
  for (const message of messages) {
    html += renderMessage(message);
    for (const gate of gates.filter((g) => g.afterMessageId === message.id)) {
      html += renderGate(gate);
      placed.add(gate.id);
    }
  }
  for (const gate of gates.filter((g) => !placed.has(g.id)))
    html += renderGate(gate);
  if (["researching", "synthesizing"].includes(goal.status))
    html += `<div class="working-message" role="status"><span class="thinking-dots"><i></i><i></i><i></i></span>${goal.status === "researching" ? "チームが調べています。大切な選択があれば、お声がけします。" : "選んだこだわりを、プランに反映しています。"}</div>`;
  if (goal.status === "completed")
    html += `<div class="complete-card"><strong>✓ ${goal.mode === "demo" ? "あなたらしいプランの、たたき台ができました" : "調査した候補をまとめました"}</strong><p>${goal.mode === "demo" ? "右のプランで流れを確認できます。気になるところは、チームに伝えて見直しましょう。" : "確認できた情報と、まだ確認が必要な情報を一緒に表示しています。"}</p><button data-action="view-plan">プランを見てみる ↗</button> <button data-action="replan">方針を見直す</button></div>`;
  if (["blocked", "cancelled", "interrupted"].includes(goal.status))
    html += `<div class="stopped-card">${goal.status === "blocked" ? "確認できる候補がありません。取得できなかった理由はComputerのプラン欄で確認できます。" : goal.status === "interrupted" ? "途中で作業が止まりました。履歴を残しています。新しい方針で、もう一度進められます。" : "チームの作業を停止しました。履歴は残っています。"}<button data-action="replan">方針を選び直す →</button></div>`;
  $("#thread").innerHTML = html;
  requestAnimationFrame(() => {
    if (atBottom || oldTop === 0) box.scrollTop = box.scrollHeight;
    else box.scrollTop = oldTop;
  });
}
function notebook() {
  const life = state.goal?.scenario === "life";
  const done = state.goal?.status === "completed";
  return `<section class="notebook"><div class="notebook-topline">${life ? "YOUR NEXT CHAPTER" : "A LITTLE TRAVEL NOTE"}<span>DEMO</span></div>${landscape(life)}<div class="notebook-intro"><div class="notebook-eyebrow">${life ? "LIFE, WITH A LITTLE MORE ROOM." : "HAKONE · 2 NIGHTS / 3 DAYS"}</div><h2>${life ? "好きな暮らしから、<br>次の一歩を。" : "予定より、<br>余白を連れて。"}</h2><p>${life ? "働く場所、住む街、週末の過ごし方。<br>別々の選択を、つなげて考える。" : "温泉と、おいしいごはん。<br>急がない3日間を、チームとつくる。"}</p></div><div class="notebook-divider"></div><div class="notebook-stats"><div><strong>${life ? "3つ" : "2泊3日"}</strong>${life ? "仕事・家・車" : "旅の長さ"}</div><div><strong>${life ? "湘南" : "2人"}</strong>${life ? "体験用エリア" : "旅のメンバー"}</div><div><strong>${life ? "¥180,000" : "¥80,000"}</strong>${life ? "月の目安" : "旅全体の目安"}</div></div><div class="notebook-quote">“${life ? "一度に全部を決めなくてもいい。" : "いちばんの楽しみは、あなたが決める。"}”<span>あなたと、頼れるチームで。</span></div></section>`;
}
function planView() {
  const goal = state.goal;
  if (goal?.status === "blocked")
    return `<div class="empty-state"><div class="empty-icon">○</div><strong>確認できる候補がありませんでした</strong>取得できない部分を、架空の候補で補っていません。</div><div class="warning-block">${goal.limitations.map(e).join("<br>")}</div><button class="replan-button" data-action="replan">方針を見直す</button>`;
  if (!goal?.plan.length) {
    return (
      notebook() +
      `<div class="side-section-label">${goal ? "チームの調査先" : "この体験で使うサービス"}<span>${goal ? "最大2件を並列実行" : "ひとつの目標を、横断して"}</span></div><div class="source-badges">${(goal?.scenario === "life" ? ["Indeed", "SUUMO", "カーセンサー"] : ["じゃらん", "Hot Pepper グルメ"]).map((s) => `<span class="source-badge">${s}</span>`).join("")}</div><div class="side-info"><strong>${goal ? "あなたの選択が、プランの軸に。" : "話しかけたら、チームが動き出します。"}</strong>${goal ? "調べる途中で見つかったこだわりどころは、会話に戻します。" : "まず左の相談から始めてください。宿、食事、移動。つながるところまで考えます。"}${goal?.mode === "live" ? "<br>実調査中です。ここはまだ体験イラストで、実サイトの画面配信ではありません。" : "<br>このComputerは体験表示です。実VMには接続していません。"}</div>`
    );
  }
  const days = [...new Set(goal.plan.map((p) => p.day))];
  if (!days.includes(state.day)) state.day = days[0];
  return `<div class="plan-summary"><strong>${e(goal.title)}</strong><p>${goal.highlights.map(e).join("<br>")}</p><div class="plan-budget"><span>${goal.scenario === "travel" ? "旅全体の予算" : "月の目安"}</span><strong>¥${goal.budget.toLocaleString()}</strong><span>${goal.mode === "demo" ? "参考設定" : "指定予算・合算未検証"}</span></div></div><div class="day-tabs" role="tablist" aria-label="プランの項目">${days.map((d) => `<button role="tab" aria-selected="${state.day === d}" data-day="${e(d)}" class="${state.day === d ? "selected" : ""}">${e(d)}</button>`).join("")}</div><div class="plan-timeline">${goal.plan
    .filter((p) => p.day === state.day)
    .map(
      (p) =>
        `<article class="plan-event"><div class="event-time">${e(p.time)}</div><div class="event-card"><h3>${e(p.title)}</h3><p>${e(p.description)}</p>${p.price ? `<div class="event-price">${e(p.price)}</div>` : ""}<div class="event-source"><span class="sample-label">${p.demo ? "体験データ" : "取得した候補"}</span><a href="${e(safeHref(p.url))}" target="_blank" rel="noopener noreferrer">${e(p.source)} ↗</a></div></div></article>`,
    )
    .join(
      "",
    )}</div>${goal.limitations.length ? `<div class="warning-block">${goal.limitations.map(e).join("<br>")}</div>` : ""}<button class="replan-button" data-action="replan">↺ 方針を見直す</button>`;
}
function tasksView() {
  const goal = state.goal;
  if (!goal?.tasks.length)
    return '<div class="empty-state"><div class="empty-icon">✳</div><strong>まずは、方針を選びましょう。</strong>選んだ方針に合わせて、<br>チームが作業を分担します。</div>';
  const running = goal.tasks.filter((t) => t.status === "running").length,
    done = goal.tasks.filter((t) => t.status === "succeeded").length;
  return `<div class="task-stats"><span><strong>${running}/${goal.concurrency}</strong>同時実行</span><span><strong>${done}/${goal.tasks.length}</strong>完了</span></div>${goal.tasks.map((t) => `<article class="task-card"><div class="task-card-top">${avatar(t.agent)}<h3>${e(t.title)}</h3><span class="task-status ${e(t.status)}">${workLabels[t.status]}</span></div><p>${e(t.source)} · ${t.round > 1 ? `再調査 ${t.round}回目` : "初回調査"}${t.runtimeTaskId ? "<br>実調査 " + e(t.runtimeTaskId.slice(0, 8)) : ""}${t.execution ? "<br>" + (t.execution.target === "openshell" ? "OpenShell: " + e(t.execution.sandboxName) : "local · ホストプロセス") : ""}</p>${t.dependsOn.length ? `<div class="depends">↳ ${t.dependsOn.map((id) => e(goal.tasks.find((w) => w.id === id)?.title ?? id)).join("・")} の後</div>` : ""}${t.note ? `<p>${e(t.note.slice(0, 250))}</p>` : ""}</article>`).join("")}<div class="side-info"><strong>独立した作業は並行して。</strong>他の条件が決まらないと進められない作業は、先に進めません。レビューで気づいた点は、担当に戻して見直します。${goal.mode === "demo" ? "<br>体験モードの調査・レビュー内容はシナリオに沿って再生しています。" : ""}</div>`;
}
function activityView() {
  const messages =
    state.goal?.messages.filter(
      (m) =>
        m.revision === state.goal.revision &&
        ["handoff", "request", "review", "revision"].includes(m.kind),
    ) ?? [];
  if (!messages.length)
    return '<div class="empty-state"><div class="empty-icon">⇄</div><strong>チームのやりとりが、ここに。</strong>誰から誰に、何を引き継いだか。<br>レビューと見直しの理由も追えます。</div>';
  return `<div class="side-section-label">チーム内の引き継ぎ<span>内部メッセージ · v1</span></div>${messages.map((m) => `<article class="activity-entry"><time>${time(m.createdAt)}</time><div class="activity-route">${e(agentInfo[m.from][0])} → ${e(agentInfo[m.to][0])} <span class="sample-label">${e(m.kind)}</span></div><p>${e(m.text)}</p><code>goal:${e(m.goalId.slice(0, 8))} · rev:${m.revision} · hop:${m.hop}${m.taskId ? " · task:" + e(m.taskId) : ""}</code></article>`).join("")}<div class="side-info">内部A2Aの記録です。外部A2Aプロトコル互換を示す表示ではありません。</div>`;
}
function renderComputer() {
  $("#computer-content").innerHTML =
    state.tab === "plan"
      ? planView()
      : state.tab === "tasks"
        ? tasksView()
        : activityView();
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)),
    );
  $("#plan-count").textContent = state.goal?.plan.length || "";
  $("#computer-state").innerHTML =
    "<i></i> " +
    (state.goal?.mode === "live"
      ? state.goal.executionTarget === "openshell"
        ? state.goal.tasks.some((t) => t.execution?.target === "openshell")
          ? "OpenShell実行記録あり"
          : "OpenShell指定（発行未確認）"
        : "ローカル実調査"
      : "体験用");
  $("#computer-footer-label").textContent =
    state.goal?.mode === "live"
      ? state.goal.executionTarget === "openshell"
        ? "OpenShell adapter · 画面配信なし"
        : "ローカルruntime · OpenShell未接続"
      : "シミュレーション · VM未接続";
  $("#export-button").disabled = !state.goal;
}
function render() {
  const goal = state.goal;
  $("#thread-title").textContent = goal?.title ?? "あなたのチーム";
  $("#thread-subtitle").textContent = goal
    ? goal.scenario === "travel"
      ? "Concierge · Stay · Food · Explore"
      : "Concierge · Career · Home · Mobility"
    : "一緒に考えて、いい選択を。";
  $("#stop-task").hidden =
    !goal ||
    ["completed", "blocked", "cancelled", "interrupted"].includes(goal.status);
  $("#goal-status").textContent = goal
    ? statusLabels[goal.status]
    : "相談をはじめる";
  $("#goal-status").classList.toggle(
    "waiting",
    !!goal?.status.startsWith("awaiting"),
  );
  const mode = goal?.mode ?? state.mode;
  $("#interaction-mode").value = goal?.interactionMode ?? state.interactionMode;
  $("#interaction-mode").disabled = !!goal;
  $("#interaction-hint").textContent =
    (goal?.interactionMode ?? state.interactionMode) === "auto"
      ? "おすすめと判断の影響を記録して進みます。未確認事項は回答に残します。予約・購入は行いません。"
      : "推奨案・選択の影響を見て承認。選択後に再開します。進め方の変更は新しい相談から。";
  $("#mode-label").textContent =
    mode === "demo" ? "体験モード" : "実調査モード";
  $("#mode-description").textContent =
    mode === "demo"
      ? "架空のデータで、チームとの進め方を試せます"
      : state.config?.agent === "claude-code"
        ? "公開サイトから調査 · Claude Codeの利用枠を使用"
        : state.config?.agent === "codex"
          ? "公開サイトから調査 · Codexの利用枠を使用"
          : state.config?.agent === "opencode"
            ? "公開サイトから調査 · OpenCode × Strataの既存GPUを使用"
            : "公開サイトから調査 · OpenRouter無料モデル";
  $("#mode-button").textContent =
    mode === "demo" ? "実調査に切り替え ↗" : "体験モードに戻る ↗";
  $("#composer-input").placeholder = goal
    ? "追加のこだわりを伝えて、方針を見直す…"
    : "チームに、かなえたいことを伝える…";
  $("#composer-hint").textContent = goal
    ? "大切な条件が変わったら、チームに伝えてください。"
    : "小さなこだわりから、大きな計画まで。";
  roster();
  phaseBar();
  renderThread();
  renderComputer();
}
async function refreshHistory() {
  state.history = await api("/api/goals");
  roster();
}
async function start(scenario, text) {
  if (state.busy) return;
  state.busy = true;
  state.navigation++;
  try {
    state.goal = await api("/api/goals", {
      method: "POST",
      body: JSON.stringify({
        scenario,
        text,
        mode: state.mode,
        interactionMode: state.interactionMode,
        confirmLive: state.mode === "live",
      }),
    });
    state.signature = JSON.stringify(state.goal);
    state.filter = null;
    state.day = null;
    localStorage.setItem("relay.goal", state.goal.id);
    $("#new-dialog").close();
    render();
    await refreshHistory();
    $("#thread-scroll").scrollTop = 0;
  } catch (err) {
    notify(err.message);
  } finally {
    state.busy = false;
  }
}
async function openGoal(id) {
  const navigation = ++state.navigation;
  try {
    const goal = await api("/api/goals/" + encodeURIComponent(id));
    if (navigation !== state.navigation) return;
    state.goal = goal;
    state.mode = goal.mode;
    state.signature = JSON.stringify(state.goal);
    state.filter = null;
    state.day = null;
    render();
    $(".app-shell").classList.remove("mobile-nav");
    localStorage.setItem("relay.goal", id);
  } catch (err) {
    notify(err.message);
  }
}
async function decide(form) {
  if (state.busy) return;
  const gateId = form.dataset.gate;
  const gate = state.goal.gates.find((g) => g.id === gateId);
  const choiceId = form.querySelector("input[type=radio]:checked")?.value;
  if (!choiceId) return;
  state.busy = true;
  const submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  try {
    state.goal = await api(`/api/goals/${state.goal.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        gateId,
        revision: state.goal.revision,
        choiceId,
        note: form.querySelector("[data-note]").value,
        budget:
          gate.kind === "direction"
            ? Number(form.querySelector("[name=budget]").value)
            : undefined,
      }),
    });
    state.signature = "";
    state.filter = null;
    render();
    notify("選んだこだわりを、チームに伝えました。");
  } catch (err) {
    notify(err.message);
    submit.disabled = false;
  } finally {
    state.busy = false;
  }
}
async function replan(text) {
  if (!state.goal) return;
  try {
    state.goal = await api(`/api/goals/${state.goal.id}/revise`, {
      method: "POST",
      body: JSON.stringify(text ? { text } : {}),
    });
    state.signature = "";
    state.filter = null;
    state.day = null;
    render();
    notify("新しい方針で、選び直せます。");
  } catch (err) {
    notify(err.message);
  }
}
function showComputer() {
  const shell = $(".app-shell");
  shell.classList.remove("computer-closed");
  if (innerWidth <= 1000) shell.classList.add("mobile-computer");
  $("#computer-toggle").setAttribute("aria-expanded", "true");
}
async function environment() {
  $("#environment-content").innerHTML =
    '<p class="env-description">実行環境を確認しています…</p>';
  $("#environment-dialog").showModal();
  let sandbox;
  try {
    sandbox = await api("/api/sandbox");
  } catch {
    sandbox = { available: false };
  }
  $("#environment-content").innerHTML =
    `<div class="env-row">実行モード<span>${state.goal?.mode === "live" ? (state.config?.executor === "openshell" ? "OpenShell指定（タスクのsandbox IDで確認）" : "ローカル実調査 · VM隔離なし") : "シナリオ体験（API使用なし）"}</span></div><div class="env-row">調査エンジン<span>${state.config?.agent === "claude-code" ? (state.config?.claudeReady ? "Claude Code · サブスク認証確認済み" : "Claude Code · 認証を確認してください") : state.config?.agent === "codex" ? (state.config?.codexReady ? "Codex · ChatGPTログイン確認済み" : state.config?.codexWorkerPhase === "Stopped" ? "Codex · VM停止中（実行時に認証確認）" : "Codex · ログインを確認してください") : state.config?.agent === "opencode" ? (state.config?.opencodeReady ? "OpenCode × Strata · 既存GPU接続確認済み" : "OpenCode × Strata · 接続を確認してください") : state.config?.localKeyConfigured ? "pi + OpenRouter · 無料モデル" : "OpenRouter認証を確認してください"}</span></div><div class="env-row">OpenShell CLI<span>${sandbox.available ? (sandbox.checks?.some((c) => c.label === "gateway-status") ? "gateway接続確認済み" : "導入済み（gatewayは未確認）") : "未接続（CLI/gatewayを確認）"}</span></div><div class="env-row">self-host VM<span>${state.config?.executor === "openshell" ? "OpenShell adapter選択済み・接続状態はCLIで確認" : "未接続 · 発行していません"}</span></div><div class="env-row">エージェント間通信<span>内部A2A · 配送ID/改訂/引き継ぎ上限あり</span></div><p class="env-description">この画面のComputerは体験表示です。実調査モードは設定された local/OpenShell executor で選択した調査エンジンと agent-browser を使います。Codexは専用MicroVMまたはlocal、Claude Code/OpenCodeはlocalで実行します。OpenShellの発行計画は既存のpi + OpenRouter構成を使います。</p><pre class="env-code">npm start -- sandbox plan '調査すること' \\\n  --gateway my-vm --url https://www.jalan.net/</pre><p class="dialog-note">OpenShellの実キーはgateway側のproviderで保持します。ブラウザにAPIキーは送信しません。</p>`;
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.start) {
    await start(button.dataset.start);
    return;
  }
  if (button.dataset.scenario) {
    await start(button.dataset.scenario);
    return;
  }
  if (button.dataset.goal) {
    await openGoal(button.dataset.goal);
    return;
  }
  if (button.dataset.agent) {
    state.filter = button.dataset.agent;
    render();
    return;
  }
  if (button.dataset.action === "all-agents") {
    state.filter = null;
    render();
    return;
  }
  if (button.dataset.tab) {
    state.tab = button.dataset.tab;
    renderComputer();
    return;
  }
  if (button.dataset.day) {
    state.day = button.dataset.day;
    renderComputer();
    return;
  }
  if (button.dataset.action === "view-plan") {
    state.tab = "plan";
    renderComputer();
    showComputer();
    return;
  }
  if (button.dataset.action === "replan") {
    await replan();
    return;
  }
  if (button.hasAttribute("data-close-dialog")) {
    button.closest("dialog").close();
    return;
  }
});
$("#thread").addEventListener("submit", (event) => {
  const form = event.target.closest("[data-gate]");
  if (form) {
    event.preventDefault();
    void decide(form);
  }
});
$("#thread").addEventListener("input", (event) => {
  const target = event.target,
    form = target.closest("[data-gate]");
  if (!form) return;
  if (target.type === "radio")
    state.choices.set(form.dataset.gate, target.value);
  if (target.dataset.note) state.notes.set(target.dataset.note, target.value);
  if (target.dataset.budget)
    state.budgets.set(target.dataset.budget, target.value);
});
$("#new-thread").onclick = () => {
  $("#new-dialog").showModal();
  $(".app-shell").classList.remove("mobile-nav");
};
$("#composer-plus").onclick = () => $("#new-dialog").showModal();
$("#mobile-menu").onclick = () =>
  $(".app-shell").classList.toggle("mobile-nav");
$("#computer-toggle").onclick = () => {
  const shell = $(".app-shell");
  if (innerWidth <= 1000) {
    shell.classList.toggle("mobile-computer");
  } else {
    shell.classList.toggle("computer-closed");
  }
  $("#computer-toggle").setAttribute(
    "aria-expanded",
    String(!shell.classList.contains("computer-closed")),
  );
};
$("#close-computer").onclick = () => {
  $(".app-shell").classList.remove("mobile-computer");
  $(".app-shell").classList.add("computer-closed");
  $("#computer-toggle").setAttribute("aria-expanded", "false");
};
$("#environment-button").onclick = environment;
$("#stop-task").onclick = async () => {
  if (!state.goal) return;
  const id = state.goal.id;
  try {
    const goal = await api(`/api/goals/${id}/cancel`, {
      method: "POST",
      body: "{}",
    });
    if (state.goal?.id === id) {
      state.goal = goal;
      state.signature = "";
      render();
      notify("作業を停止しました。");
    }
  } catch (err) {
    notify(err.message);
  }
};
$("#mode-button").onclick = () => {
  const current = state.goal?.mode ?? state.mode;
  if (current === "demo") {
    if (!state.config?.liveAvailable) {
      notify(
        state.config?.agent === "claude-code"
          ? "claude auth login と npm start -- claude-doctor で認証を確認してください。"
          : state.config?.agent === "codex"
            ? state.config?.executor === "openshell"
              ? "npm run sandbox:local -- codex-login でVM内のログインを確認してください。"
              : "codex login と npm start -- codex-doctor でログインを確認してください。"
            : state.config?.agent === "opencode"
              ? "既存Strataの接続と npm start -- doctor --agent opencode を確認してください。"
              : ".envにOPENROUTER_API_KEYを設定してください。",
      );
      return;
    }
    state.mode = "live";
  } else state.mode = "demo";
  state.navigation++;
  state.goal = null;
  state.signature = "";
  state.filter = null;
  localStorage.removeItem("relay.goal");
  render();
  notify(
    state.mode === "live"
      ? "実調査モードです。相談を選んでください。"
      : "体験モードに切り替えました。",
  );
};
$("#composer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("#composer-input").value.trim();
  if (!text) return;
  if (state.goal) await replan(state.goal.text + "\n追加のこだわり：" + text);
  else
    await start(
      /仕事|暮ら|転職|家|車|就職|住ま/.test(text) ? "life" : "travel",
      text,
    );
  $("#composer-input").value = "";
  $("#composer-input").style.height = "";
});
$("#composer-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("#composer-form").requestSubmit();
  }
});
$("#composer-input").addEventListener("input", (event) => {
  event.target.style.height = "auto";
  event.target.style.height = Math.min(90, event.target.scrollHeight) + "px";
});
$("#export-button").onclick = () => {
  if (!state.goal) return;
  const data = JSON.stringify(state.goal, null, 2);
  const url = URL.createObjectURL(
    new Blob([data], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `relay-${state.goal.id.slice(0, 8)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  notify("選択履歴とプランを保存しました。");
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape")
    $(".app-shell").classList.remove("mobile-nav", "mobile-computer");
  if (
    event.key.toLowerCase() === "n" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)
  )
    $("#new-dialog").showModal();
});
async function poll() {
  if (
    state.goal &&
    ["researching", "synthesizing"].includes(state.goal.status) &&
    !state.busy
  ) {
    const goalId = state.goal.id,
      navigation = state.navigation;
    try {
      const goal = await api("/api/goals/" + goalId);
      if (navigation !== state.navigation || state.goal?.id !== goalId) {
        setTimeout(poll, 1000);
        return;
      }
      const signature = JSON.stringify(goal);
      if (signature !== state.signature) {
        state.signature = signature;
        state.goal = goal;
        render();
        if (!["researching", "synthesizing"].includes(goal.status))
          await refreshHistory();
      }
    } catch (err) {
      notify(err.message);
    }
  }
  setTimeout(poll, 1000);
}
async function init() {
  render();
  try {
    state.config = await api("/api/config");
    await refreshHistory();
    const saved = localStorage.getItem("relay.goal");
    if (saved) await openGoal(saved);
  } catch (err) {
    notify(err.message);
  }
  void poll();
}
void init();

$("#interaction-mode").onchange = (event) => {
  state.interactionMode = event.target.value;
  render();
};

async function runtimeApprovals() {
  const dialog = $("#runtime-approvals-dialog");
  if (!dialog.open) dialog.showModal();
  const loops = await api("/api/improvements");
  const pending = loops.filter(
    (l) => l.status === "needs_input" && l.approval?.status === "pending",
  );
  $("#runtime-approvals-content").innerHTML = pending.length
    ? pending
        .map((loop) => {
          const gate = loop.approval;
          return `<form class="runtime-approval-form" data-loop="${e(loop.id)}" data-approval="${e(gate.id)}"><h3>${e(gate.title)}</h3><p>${e(loop.query)}</p><p>${e(gate.reason)}</p><fieldset><legend>次の進め方</legend>${gate.choices.map((c) => `<label class="choice"><input type="radio" name="runtime-choice" value="${e(c.id)}" ${c.recommended ? "checked" : ""} required><strong>${e(c.title)}${c.recommended ? "（おすすめ）" : ""}</strong><p>${e(c.tradeoff)}</p></label>`).join("")}</fieldset><label data-runtime-url hidden>追加の公開詳細URL（1行1件・最大8件）<textarea name="urls" rows="2" aria-label="追加の公開詳細URL" disabled></textarea></label><button class="primary-button" type="submit">選んで続ける →</button><p class="runtime-decision-status" role="status"></p></form>`;
        })
        .join("")
    : "<p>現在、選択待ちの調査はありません。Autoは承認待ちを作りません。</p>";
}
$("#runtime-approvals-button").onclick = () =>
  runtimeApprovals().catch((err) => notify(err.message));
$("#runtime-approvals-content").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target.closest(".runtime-approval-form");
  if (!form) return;
  const values = new FormData(form),
    choiceId = values.get("runtime-choice");
  const status = form.querySelector(".runtime-decision-status"),
    button = form.querySelector("button");
  const additionalUrls = String(values.get("urls") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  button.disabled = true;
  status.textContent =
    choiceId === "return_partial"
      ? "提案を取り出しています…"
      : "選択を保存して追加調査中です。この画面を閉じても履歴は残ります。";
  try {
    const result = await api(
      `/api/improvements/${form.dataset.loop}/decision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvalId: form.dataset.approval,
          choiceId,
          additionalUrls,
        }),
      },
    );
    form.innerHTML = `<h3>選択を保存しました</h3><p>${e(result.task.answer?.summary ?? "回答なし")}</p><p>状態: ${e(result.loop.status)}。未確認対象: ${result.loop.best.gaps.length}件</p>${result.loop.best.gaps.map((g) => `<p>${e(g.url)}：${e(g.fields.join("・"))}</p>`).join("")}<p>最良タスク: ${e(result.task.id)}</p><button type="button" data-refresh-runtime-approvals>確認待ちを更新</button>`;
  } catch (err) {
    status.textContent = err.message;
    button.disabled = false;
  }
});
$("#runtime-approvals-content").addEventListener("click", (event) => {
  if (event.target.closest("[data-refresh-runtime-approvals]"))
    runtimeApprovals().catch((err) => notify(err.message));
});

$("#runtime-approvals-content").addEventListener("change", (event) => {
  const form = event.target.closest(".runtime-approval-form");
  if (!form || event.target.name !== "runtime-choice") return;
  const field = form.querySelector("[data-runtime-url]"),
    textarea = field.querySelector("textarea");
  const needsUrl = event.target.value === "add_url";
  field.hidden = !needsUrl;
  textarea.disabled = !needsUrl;
  textarea.required = needsUrl;
  if (!needsUrl) textarea.value = "";
});
