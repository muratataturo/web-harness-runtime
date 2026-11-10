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
      ? 'Rakuten<span class="wordmark-sub">HARNESS WORKSPACE</span>'
      : 'RECRUIT<span class="wordmark-sub">HARNESS WORKSPACE</span>';
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
    state.stream?.close();
    state.stream = null;
    state.streamId = null;
    state.run = null;
    state.signature = "";
    $("#artifact-jump").hidden = true;
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
function progressHtml(r) {
  const events = r.activities ?? [],
    last = events.at(-1),
    stages = [
      ["prepare", "準備"],
      ["plan", "条件整理"],
      ["read", "ページ取得"],
      ["verify", "根拠確認"],
      ["answer", "回答"],
    ];
  const finishedStages = new Set(
    events.filter((e) => e.status === "done").map((e) => e.stage),
  );
  return `<div class="stream-heading"><span class="pulse" aria-hidden="true"></span><span>${esc(last?.title ?? r.phase)}</span><span class="live-pill" id="stream-state">接続中</span></div><div class="stage-track">${stages.map(([key, label]) => `<span class="stage ${key === last?.stage ? "active" : finishedStages.has(key) ? "done" : ""}">${label}</span>`).join("")}</div><div class="stream-counts"><span>取得記録 <strong>${last?.pages ?? 0}</strong></span><span>保存した根拠 <strong>${last?.evidence ?? 0}</strong></span><span>経過 <strong id="stream-elapsed">${Math.max(0, Math.floor((Date.now() - new Date(r.createdAt)) / 1000))}s</strong></span></div><ol class="stream-timeline" aria-label="調査の進捗">${
    events
      .slice(-7)
      .map(
        (e) =>
          `<li><span class="event-dot ${e.status}">${e.status === "done" ? "✓" : e.status === "error" ? "!" : "◌"}</span><div><strong>${esc(e.title)}${e.status === "error" ? " · 取得できず" : ""}</strong>${e.url ? `<small>${esc(new URL(e.url).hostname + new URL(e.url).pathname)}</small>` : ""}</div><time>${new Date(e.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).slice(0, 8)}</time></li>`,
      )
      .join("") ||
    '<li><span class="event-dot">◌</span><div><strong>実行環境の応答を待っています</strong><small>取得の開始が届き次第、ここに順次表示します。</small></div></li>'
  }</ol>`;
}
function artifactsHtml(r) {
  const cards = r.artifacts ?? [];
  if (!cards.length) return "";
  return `<section class="artifact-shelf"><h3 class="shelf-heading">調査で確認したリンク <small>${cards.filter((a) => a.state === "captured").length}件取得 · ${r.input.source === "replay" ? "保存済み実測" : "調査成果物"}</small></h3><div class="artifact-grid">${cards.map((a) => `<article class="artifact-card"><button class="artifact-open" data-artifact="${esc(a.id)}" title="${esc(a.url)}"><div class="artifact-domain"><span>${esc(new URL(a.url).hostname)}</span><b class="artifact-status ${a.state === "unavailable" ? "error" : ""}">${a.state === "unavailable" ? "取得不可" : "取得済み"}${a.statusCode ? " / " + a.statusCode : ""}</b></div><strong>${esc(a.title)}</strong><p>${esc(a.preview)}</p></button><footer><button class="artifact-preview-link" data-artifact="${esc(a.id)}">プレビューを開く</button><a href="${link(a.url)}" title="${esc(a.url)}" target="_blank" rel="noopener noreferrer">元のページ ↗</a></footer></article>`).join("")}</div></section>`;
}

function updateLive(r) {
  const stream = $("#stream-view");
  if (stream) stream.innerHTML = progressHtml(r);
  const shelf = $("#live-artifacts");
  if (shelf) {
    const cards = artifactsHtml(r);
    if (shelf.lastCards !== cards) {
      shelf.innerHTML = cards;
      shelf.lastCards = cards;
    }
  }
  const jump = $("#artifact-jump");
  const count = r.artifacts?.length ?? 0;
  jump.hidden = !count;
  jump.textContent = `取得リンク ${count}`;
  const badge = $("#stream-state");
  if (badge)
    badge.textContent =
      state.stream?.readyState === EventSource.OPEN ? "● LIVE" : "再接続中";
}
function watch(r) {
  if (
    state.streamId === r.id &&
    ["running", "needs_input"].includes(r.status) &&
    state.stream
  )
    return;
  state.stream?.close();
  state.stream = null;
  state.streamId = null;
  if (!["running", "needs_input"].includes(r.status)) return;
  const es = new EventSource(`/api/runs/${r.id}/events`);
  state.stream = es;
  state.streamId = r.id;
  es.addEventListener("run", (event) => {
    if (state.run?.id !== r.id) return;
    try {
      const next = JSON.parse(event.data);
      render(next);
      if (next.status !== "running") void history();
    } catch {
      notice("進捗の更新を読み込めませんでした");
    }
  });
  es.onopen = () => {
    const b = $("#stream-state");
    if (b) b.textContent = "● LIVE";
  };
  es.onerror = () => {
    const b = $("#stream-state");
    if (b) b.textContent = "再接続中";
  };
}
async function previewArtifact(id) {
  const r = state.run;
  if (!r) return;
  $("#artifact-content").innerHTML =
    "<p>保存された取得内容を読み込んでいます…</p>";
  $("#artifact-dialog").showModal();
  try {
    const a = await api(`/api/runs/${r.id}/artifacts/${id}`);
    if (state.run?.id !== r.id) return;
    $("#artifact-content").innerHTML =
      `<span class="run-tag">${a.state === "unavailable" ? "取得できなかったページ" : "取得したページの成果物"}</span><h2>${esc(a.title)}</h2><div class="artifact-meta">${esc(a.url)}<br>${esc(a.capturedAt)} · ${esc(a.method)}${a.statusCode ? " · HTTP " + a.statusCode : ""}</div><div class="artifact-preview-body">${esc(a.body)}</div><p class="artifact-meta">${a.state === "unavailable" ? "取得に失敗した記録です。ページ本文の取得成功を示すものではありません。" : a.excerptOnly ? "この表示は保存された本文抜粋・引用です。全文取得ではありません。" : "取得した時点の本文です。現在のページを埋め込んだ表示ではありません。"}</p>${a.quotes.length ? "<h3>回答に使った引用</h3>" + a.quotes.map((q) => `<blockquote class="artifact-quote">${esc(q.quote)}</blockquote>`).join("") : ""}<a class="artifact-external" href="${link(a.url)}" target="_blank" rel="noopener noreferrer">元のページを開く ↗</a>`;
  } catch (e) {
    $("#artifact-content").textContent = e.message;
  }
}
function render(r) {
  if (state.run?.id === r.id && (r.updateSeq ?? 0) < (state.run.updateSeq ?? 0))
    return;
  if (state.run?.id !== r.id) {
    if (r.input.example) state.example = r.input.example;
    $("#chat-query").value = r.input.query;
    $("#chat-urls").value = r.input.urls.join("\n");
    $("#chat-mode").value = r.input.mode;
    $("#data-source").value = r.input.source;
    $("#chat-agent").value = r.input.agent;
    modeHint();
  }
  state.run = r;
  localStorage.setItem("harness.run", r.id);
  watch(r);
  const signature = JSON.stringify([
    r.id,
    r.status,
    r.revision,
    r.gate?.id,
    r.taskId,
    r.task?.answer,
    r.decisions,
    r.error,
  ]);
  if (signature === state.signature) {
    updateLive(r);
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
    html += `<div class="progress-box"><div id="stream-view" aria-live="polite" aria-atomic="false">${progressHtml(r)}</div><details><summary>詳細ログ</summary><pre id="progress-lines">${esc(r.progress.slice(-8).join("\n"))}</pre></details><button class="cancel-run" id="cancel-run">調査を停止</button></div>`;
  html += `<div id="live-artifacts">${artifactsHtml(r)}</div>`;
  if (r.task?.answer)
    html += `<div class="result-actions"><button id="copy-answer">回答をコピー</button><a href="/api/runs/${esc(r.id)}" target="_blank" rel="noopener">回答・引用・実行記録 JSON ↗</a></div>`;
  $("#conversation").innerHTML = html;
  inspection(r);
  updateLive(r);
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
  if (r.status !== "needs_input" || r.gate?.kind !== "direction")
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
  const artifact = e.target.closest("[data-artifact]");
  if (artifact) {
    await previewArtifact(artifact.dataset.artifact);
    return;
  }
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
  location.assign("/chat");
};
$("#mobile-nav").onclick = () => $(".rail").classList.toggle("open");
$("#usage-toggle").onclick = () => $("#usage").showModal();
$("#artifact-close").onclick = () => $("#artifact-dialog").close();
$("#artifact-jump").onclick = () =>
  $(".artifact-shelf")?.scrollIntoView({ block: "start" });
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
    const id =
      new URLSearchParams(location.search).get("run") ??
      localStorage.getItem("harness.run");
    if (id && /^[a-zA-Z0-9-]+$/.test(id)) render(await api("/api/runs/" + id));
  } catch (e) {
    notice(e.message);
  }
  modeHint();
}
setInterval(async () => {
  const r = state.run;
  if (r?.status === "running") {
    const elapsed = $("#stream-elapsed");
    if (elapsed)
      elapsed.textContent =
        Math.max(0, Math.floor((Date.now() - new Date(r.createdAt)) / 1000)) +
        "s";
  }
  if (
    r?.status === "running" &&
    !state.busy &&
    state.stream?.readyState !== EventSource.OPEN
  ) {
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
