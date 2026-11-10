const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const link = (u) => {
  try {
    return new URL(u).protocol === "https:" ? esc(u) : "#";
  } catch {
    return "#";
  }
};
const welcomeHtml = $("#conversation").innerHTML;
const state = {
  run: null,
  examples: [],
  example: "day-out",
  config: null,
  history: [],
  busy: false,
  signature: "",
  selection: null,
};
async function api(path, body) {
  const r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const v = await r.json();
  if (!r.ok) throw Error(v.error ?? "接続できませんでした");
  return v;
}
function notice(text) {
  $("#notice").textContent = text;
  $("#notice").classList.add("visible");
  clearTimeout(notice.timer);
  notice.timer = setTimeout(
    () => $("#notice").classList.remove("visible"),
    6000,
  );
}
function theme(brand) {
  document.body.dataset.brand = brand;
  $("#brand-name").innerHTML =
    brand === "rakuten"
      ? 'Rakuten<span class="wordmark-sub">inspired / HARNESS</span>'
      : 'RECRUIT<span class="wordmark-sub">inspired / HARNESS</span>';
  document
    .querySelectorAll(".brand-switch button")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.brand === brand)),
    );
  localStorage.setItem("harness.brand", brand);
}
function modeHint() {
  const auto = $("#chat-mode").value === "auto";
  $("#mode-help").textContent = auto
    ? "推奨案で進めます。未確認が残れば明記し、承認待ちなしで回答します。"
    : "推奨案と選択の影響を見て、あなたが決定。選ぶまで調査を始めません。";
  $("#source-help").textContent =
    $("#data-source").value === "live"
      ? "外部の公開サイトとモデルに接続し、選択したエンジンの利用枠を使います。"
      : "保存済みの当時の回答を再生。入力を変えて新しく調べるには実調査を選んでください。";
}
function sample(id) {
  state.example = id;
  const p = state.examples.find((p) => p.id === id);
  if (!p) return;
  $("#chat-query").value = p.query;
  $("#chat-urls").value = p.urls.join("\n");
  if (state.run) {
    state.run = null;
    state.signature = "";
    localStorage.removeItem("harness.run");
    $("#conversation").innerHTML = welcomeHtml;
    $("#inspection").innerHTML =
      "<p>新しい相談の根拠・時間をここに表示します。</p>";
  }
  $("#chat-query").focus();
  $("#chat-query").setSelectionRange(0, 0);
  $("#chat-query").scrollTop = 0;
}
async function history() {
  state.history = await api("/api/runs");
  $("#sessions").innerHTML = state.history
    .slice(0, 30)
    .map(
      (r) =>
        `<button data-run="${esc(r.id)}" class="${state.run?.id === r.id ? "active" : ""}">${r.input.source === "replay" ? "↺ " : "◉ "}${esc(r.input.query.slice(0, 34))}</button>`,
    )
    .join("");
}
function statusText(r) {
  return (
    {
      running: "調べています",
      needs_input: "あなたの選択を待っています",
      succeeded: "確認できました",
      completed_partial: "未確認を明記した提案",
      failed: "調査を完了できませんでした",
      cancelled: "停止しました",
      interrupted: "前のプロセスで中断",
    }[r.status] ?? r.status
  );
}
function inspection(r) {
  const t = r.task,
    m = t?.metrics,
    x = t?.execution;
  $("#inspection").innerHTML =
    `<section class="inspect-section"><h3>データと実行場所</h3><strong>${r.input.source === "replay" ? "保存済みの実測を再生" : "公開サイトを実調査"}</strong><small>${esc(r.input.agent)} / ${esc(t?.model ?? r.input.model ?? "既定モデル")}</small><small>${r.input.source === "replay" ? "以下の時間・費用は元の実測。今回の再生は推論なし。" : r.target === "openshell" ? "OpenShell指定。取得後にsandbox IDを記録。" : "ローカルプロセス・VM隔離なし"}</small>${x ? `<small>元の実行先：${esc(x.target)} ${esc(x.sandboxName ?? "")}</small><small>${esc(x.sandboxId ?? "")}</small>` : ""}</section><section class="inspect-section"><h3>時間とコスト</h3>${m ? `<strong>${((x?.elapsedMs ?? m.elapsedMs) / 1000).toFixed(1)} 秒</strong><small>準備・成果物回収込み（実測に記録された範囲）</small><p>${m.tokens?.totalTokens?.toLocaleString() ?? "未取得"} tokens</p><p>追加API課金 ${m.billing.additionalApiUsd === null ? "不明" : `$${m.billing.additionalApiUsd}`}</p><small>サブスク配賦・追加クレジット・VM/GPU費は未算定。総実費0ではありません。</small>` : "<small>実行後に取得できた計測値を表示します。</small>"}</section><section class="inspect-section"><h3>引用と出典</h3>${
      t?.evidence
        ?.slice(0, 12)
        .map(
          (e) =>
            `<a href="${link(e.url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(e.url).hostname)} ↗</a><blockquote>${esc(e.quote)}</blockquote>`,
        )
        .join("") ?? "<small>まだ根拠は保存されていません。</small>"
    }</section><section class="inspect-section"><h3>未確認・制約</h3>${t?.answer?.limitations?.map((l) => `<p>${esc(l)}</p>`).join("") ?? "<small>取得結果と一緒に表示します。</small>"}</section>`;
}
function render(r) {
  state.run = r;
  localStorage.setItem("harness.run", r.id);
  $("#chat-mode").value = r.input.mode;
  $("#data-source").value = r.input.source;
  $("#chat-agent").value = r.input.agent;
  modeHint();
  const signature = JSON.stringify([
    r.status,
    r.revision,
    r.gate?.id,
    r.taskId,
    r.task?.answer,
    r.decisions,
    r.error,
  ]);
  if (signature === state.signature) {
    const pre = $("#progress-lines");
    if (pre) pre.textContent = r.progress.slice(-8).join("\n");
    return;
  }
  state.signature = signature;
  let html = `<div class="message user"><div class="speaker">あなた</div>${esc(r.input.query).replaceAll("\n", "<br>")}</div><div class="message system"><span class="run-tag">${r.input.source === "replay" ? "実測の再生 · 追加推論なし" : "実調査"} / ${esc(r.input.mode)}</span><br>${esc(statusText(r))}</div>`;
  if (r.reviewWarnings?.length)
    html += `<aside class="review-warning" role="note"><strong>掲載情報の照合結果</strong>${r.reviewWarnings.map((w) => `<p>${esc(w)}</p>`).join("")}</aside>`;
  html += r.decisions
    .map(
      (d) =>
        `<div class="decision-receipt">✓ ${d.decidedBy === "runtime" ? "Auto が推奨案を選択" : "あなたが選択"} · ${esc({ balance: "余白と予算を大切に", experience: "体験・こだわりを優先", return_partial: "未確認を明記して受け取る", research_more: "同じ条件で追加調査", add_url: "公式URLを追加" }[d.choiceId] ?? d.choiceId)}</div>`,
    )
    .join("");
  if (r.task?.answer)
    html += `<article class="message"><div class="speaker">HARNESS / 根拠をつないだ提案</div><div class="answer">${esc(r.task.answer.summary.replaceAll("\\n", "\n"))}</div></article>`;
  if (r.error)
    html += `<div class="message">${esc(r.error)}<p>取得できなかった内容を、確認済みとして表示していません。</p></div>`;
  if (r.gate) {
    state.selection =
      r.gate.choices.find((c) => c.recommended)?.id ?? r.gate.choices[0].id;
    html += `<form class="gate-card" id="decision-form"><span class="run-tag">${r.gate.kind === "direction" ? "あなたのこだわり" : "未確認事項の扱い"}</span><h2>${esc(r.gate.title)}</h2><p>${esc(r.gate.reason)}</p><div class="gate-options">${r.gate.choices.map((c) => `<label class="gate-choice"><input type="radio" name="choice" value="${esc(c.id)}" ${c.id === state.selection ? "checked" : ""}><span><strong>${esc(c.title)}${c.recommended ? '<b class="recommended">おすすめ</b>' : ""}</strong><small>${esc(c.tradeoff)}</small></span></label>`).join("")}</div>${r.gate.choices.some((c) => c.id === "add_url") ? '<textarea class="gate-urls" id="extra-urls" rows="2" placeholder="URL追加を選んだ場合：同一候補の公式詳細URLを1行に1つ"></textarea>' : ""}<button class="gate-confirm" type="submit">この選択で進む →</button><p>おすすめは自動送信されません。押すと選択を保存して再開します。</p></form>`;
  }
  if (r.status === "running")
    html += `<div class="progress-box" role="status">◌ ${esc(r.phase)}<details><summary>取得の進み具合</summary><pre id="progress-lines">${esc(r.progress.slice(-8).join("\n"))}</pre></details><button class="cancel-run" id="cancel-run">調査を停止</button></div>`;
  if (r.task?.answer)
    html += `<div class="result-actions"><button id="copy-answer">回答をコピー</button><a href="/api/runs/${esc(r.id)}" target="_blank" rel="noopener">回答・引用・実行記録 JSON ↗</a></div>`;
  $("#conversation").innerHTML = html;
  inspection(r);
  $("#decision-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.busy) return;
    state.busy = true;
    const button = e.submitter;
    button.disabled = true;
    try {
      const choiceId = new FormData(e.target).get("choice");
      const additionalUrls = ($("#extra-urls")?.value ?? "")
        .split(/\s+/)
        .filter(Boolean);
      const next = await api(`/api/runs/${r.id}/decision`, {
        gateId: r.gate.id,
        revision: r.revision,
        choiceId,
        additionalUrls,
      });
      render(next);
      await history();
    } catch (e) {
      notice(e.message);
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  });
  $("#cancel-run")?.addEventListener("click", async () => {
    try {
      render(await api(`/api/runs/${r.id}/cancel`, {}));
    } catch (e) {
      notice(e.message);
    }
  });
  $("#copy-answer")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(
        [
          r.reviewWarnings?.length
            ? "掲載情報の照合結果：\n" + r.reviewWarnings.join("\n")
            : "",
          r.task.answer.summary.replaceAll("\\n", "\n"),
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      notice("回答をコピーしました");
    } catch {
      notice("ブラウザのコピー権限を確認してください");
    }
  });
  $("#conversation").scrollTop = $("#conversation").scrollHeight;
}
$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  state.busy = true;
  $("#send-chat").disabled = true;
  try {
    const source = $("#data-source").value;
    const def = state.examples.find((p) => p.id === state.example);
    if (source === "replay" && $("#chat-query").value !== def?.query)
      throw Error(
        "保存済み実測は元の条件で再生します。例を選び直すか「実調査」を選んでください。",
      );
    const r = await api("/api/runs", {
      query: $("#chat-query").value,
      urls: $("#chat-urls").value.split(/\s+/).filter(Boolean),
      mode: $("#chat-mode").value,
      source,
      agent: $("#chat-agent").value,
      example: state.example,
      confirmLive: source === "live",
    });
    render(r);
    await history();
  } catch (e) {
    notice(e.message);
  } finally {
    state.busy = false;
    $("#send-chat").disabled = false;
  }
});
document.addEventListener("click", async (e) => {
  const brand = e.target.closest("[data-brand]");
  if (brand?.tagName === "BUTTON") theme(brand.dataset.brand);
  const ex = e.target.closest("[data-example]");
  if (ex) {
    sample(ex.dataset.example);
    $(".rail").classList.remove("open");
  }
  const h = e.target.closest("[data-run]");
  if (h) {
    try {
      state.signature = "";
      render(await api("/api/runs/" + h.dataset.run));
      $(".rail").classList.remove("open");
    } catch (e) {
      notice(e.message);
    }
  }
});
$("#new-chat").onclick = () => {
  localStorage.removeItem("harness.run");
  location.reload();
};
$("#mobile-nav").onclick = () => $(".rail").classList.toggle("open");
$("#usage-toggle").onclick = () => $("#usage").showModal();
$("#usage-close").onclick = () => $("#usage").close();
$("#chat-mode").onchange = modeHint;
$("#data-source").onchange = modeHint;
async function init() {
  theme(
    localStorage.getItem("harness.brand") === "rakuten" ? "rakuten" : "recruit",
  );
  try {
    const [config, examples] = await Promise.all([
      api("/api/runtime"),
      api("/api/examples"),
    ]);
    state.config = config;
    state.examples = examples;
    $("#runtime-badge").textContent =
      config.executor === "openshell"
        ? "◉ OpenShell / VM executor"
        : "◉ Local runtime";
    $("#chat-agent").value = config.defaultAgent;
    sample("day-out");
    await history();
    const id = localStorage.getItem("harness.run");
    if (id) render(await api("/api/runs/" + id));
  } catch (e) {
    notice(e.message);
  }
  modeHint();
}
setInterval(async () => {
  const r = state.run;
  if (r?.status === "running" && !state.busy) {
    try {
      const next = await api("/api/runs/" + r.id);
      if (state.run?.id === next.id) {
        render(next);
        if (next.status !== "running") await history();
      }
    } catch (e) {
      notice(e.message);
    }
  }
}, 1500);
void init();
