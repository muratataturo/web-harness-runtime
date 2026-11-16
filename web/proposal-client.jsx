import React, { useState, useEffect } from "react";
const labels = {
  discovery: "発見を楽しむ",
  relax: "ゆったり過ごす",
  photo: "記録を残す",
};
function saved(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
export function ProposalChooser({ data }) {
  const options = data.artifact.proposalSet.options,
    key = "proposal:" + data.review.revision;
  const [selected, setSelected] = useState(() =>
    options.some((o) => o.id === saved(key))
      ? saved(key)
      : data.proposalRanking.recommendedId,
  );
  const option = options.find((o) => o.id === selected) ?? options[0];
  const choose = (id) => {
    setSelected(id);
    save(key, id);
    document.dispatchEvent(
      new CustomEvent("proposal-change", { detail: { id } }),
    );
  };
  const step = data.plan?.steps.find((s) => s.id === option.stepId);
  return (
    <section className="proposal-section" data-selected-proposal={option.id}>
      <div className="proposal-heading">
        <span className="eyebrow">
          {data.artifact.kind === "journey-map"
            ? "ONE DAY, THREE WAYS"
            : "YOUR NEXT STEP, THREE WAYS"}
        </span>
        <h2>
          {data.artifact.kind === "journey-map"
            ? "どんな時間にしたい？"
            : "どの一歩から試したい？"}
        </h2>
        <p>
          {data.artifact.kind === "journey-map"
            ? "同じ場所と予算でも、楽しみ方は選べます。行動と残る成果を見比べてください。"
            : "同じ節目でも、試し方は選べます。進め方と残る成果を見比べてください。"}
        </p>
      </div>
      <a className="proposal-review-link" href="#ux-review">
        表示中の案を10秒でレビュー ↓
      </a>
      <div className="proposal-tabs" aria-label="比較する案">
        {options.map((o) => (
          <button
            type="button"
            key={o.id}
            aria-pressed={selected === o.id}
            onClick={() => choose(o.id)}
          >
            {labels[o.theme]}
          </button>
        ))}
      </div>
      <div className="proposal-options">
        {options.map((o, i) => (
          <article
            key={o.id}
            data-proposal-id={o.id}
            className={
              "proposal-option theme-" +
              o.theme +
              (selected === o.id ? " selected" : "")
            }
          >
            <span className="proposal-number">
              0{i + 1} / {labels[o.theme]}
            </span>
            {data.proposalRanking.recommendedId === o.id && (
              <span className="proposal-recommended">希望からの初期提案</span>
            )}
            <h3>{o.title}</h3>
            <p>{o.benefit}</p>
            <dl>
              <dt>すること</dt>
              <dd>{o.activity}</dd>
              <dt>残るもの</dt>
              <dd>{o.deliverable}</dd>
            </dl>
            <details className="proposal-detail">
              <summary>違いと向き・不向きを見る</summary>
              <dl>
                <dt>定番との違い</dt>
                <dd>{o.difference}</dd>
                <dt>こんなときは別の案へ</dt>
                <dd>{o.tradeoff}</dd>
              </dl>
            </details>
            <button
              type="button"
              className="proposal-pick"
              aria-pressed={selected === o.id}
              onClick={() => choose(o.id)}
            >
              {selected === o.id ? "この案を表示中" : "この案を見てみる"}
            </button>
          </article>
        ))}
      </div>
      <div className="proposal-selected" aria-live="polite">
        <div>
          <span className="eyebrow">YOUR PICK / {labels[option.theme]}</span>
          <h3>{option.title}</h3>
          <p>{option.activity}</p>
          <p>
            <strong>小さな成果：</strong>
            {option.deliverable}
          </p>
        </div>
        <aside>
          <strong>
            {step
              ? `${step.when}の活動枠から${option.minutes}分`
              : `まず${option.minutes}分試す提案`}
          </strong>
          <p>
            {step
              ? `${step.where}。時刻・所要時間は元の見積です。`
              : "元の節目の中で試す小さな行動です。"}
          </p>
          <a
            href="#visual-artifact"
            {...(data.artifact.kind === "journey-map"
              ? { "data-map-stop": option.anchorId }
              : {})}
          >
            場所・節目を確認 ↗
          </a>
          <p className="proposal-scope">
            表示する過ごし方だけを切り替えます。元の行程・費用・未確認事項は保持します。
          </p>
        </aside>
      </div>
      <p className="proposal-ranking">
        {data.proposalRanking.reason} {data.proposalRanking.assessment}
      </p>
    </section>
  );
}
export function TenSecondReview({ data }) {
  const options = data.artifact.proposalSet.options;
  const initial = saved("proposal:" + data.review.revision);
  const [chosen, setChosen] = useState(
    options.some((o) => o.id === initial)
      ? initial
      : data.proposalRanking.recommendedId,
  );
  const [phase, setPhase] = useState("idle"),
    [elapsed, setElapsed] = useState(0),
    [reviewed, setReviewed] = useState(null),
    [answers, setAnswers] = useState({}),
    [appeal, setAppeal] = useState(null),
    [issues, setIssues] = useState([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const change = (e) => {
      if (options.some((o) => o.id === e.detail?.id)) {
        setChosen(e.detail.id);
        if (phase === "exposing") {
          setPhase("idle");
          setElapsed(0);
          setMessage(
            "表示する案が変わりました。もう一度レビューを開始できます。",
          );
        }
      }
    };
    document.addEventListener("proposal-change", change);
    return () => document.removeEventListener("proposal-change", change);
  }, [phase]);
  useEffect(() => {
    if (phase !== "exposing") return;
    let last = performance.now(),
      visible = document.visibilityState === "visible";
    const visibility = () => {
      last = performance.now();
      visible = document.visibilityState === "visible";
    };
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(() => {
      const now = performance.now();
      if (visible) setElapsed((v) => Math.min(10000, v + now - last));
      last = now;
    }, 100);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [phase]);
  useEffect(() => {
    if (phase === "exposing" && elapsed >= 10000) {
      setPhase("rating");
      document.getElementById("ux-review")?.scrollIntoView({ block: "start" });
    }
  }, [elapsed, phase]);
  const start = () => {
    setReviewed(chosen);
    setElapsed(0);
    setAnswers({});
    setAppeal(null);
    setIssues([]);
    setMessage("");
    setPhase("exposing");
    const card = [...document.querySelectorAll(".proposal-option")].find(
      (n) => n.dataset.proposalId === chosen,
    );
    (card ?? document.getElementById("proposal-comparison"))?.scrollIntoView({
      block: "start",
    });
  };
  const complete =
    ["understood", "uncertaintyVisible", "nextActionClear"].every(
      (k) => typeof answers[k] === "boolean",
    ) && appeal !== null;
  const submit = async () => {
    if (!complete || elapsed < 10000 || busy) return;
    setBusy(true);
    try {
      let reviewerId = saved("ux-reviewer-v2");
      if (!reviewerId) {
        reviewerId = crypto.randomUUID();
        save("ux-reviewer-v2", reviewerId);
      }
      const payload = {
        protocol: "web-harness-ux-review-v2",
        taskId: data.review.taskId,
        designVersion: "ten-second-v2",
        reviewerId,
        artifactRevision: data.review.revision,
        proposalId: reviewed,
        exposureMs: Math.round(elapsed),
        ...answers,
        appeal,
        issues,
      };
      if (data.review.endpoint) {
        const response = await fetch(data.review.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok)
          throw Error(
            "保存できませんでした。接続先と回答の版を確認してください。",
          );
        await response.json();
        setMessage("レビューを保存しました。次の改善で参照します。");
      } else {
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: "application/json",
          }),
          url = URL.createObjectURL(blob),
          a = document.createElement("a");
        a.href = url;
        a.download = "ux-review-" + data.review.taskId + ".json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage(
          "レビューJSONを書き出しました。runtimeへ取り込むまで未保存です。",
        );
      }
      setPhase("done");
    } catch (e) {
      setMessage(e.message || "レビューを保存できませんでした。");
    } finally {
      setBusy(false);
    }
  };
  const issueLabels = {
    too_dense: "情報が多い",
    unclear_difference: "案の違いが分かりにくい",
    not_for_me: "自分の希望に合わない",
    unrealistic: "実行が難しそう",
    hard_to_read: "文字が読みにくい",
  };
  return (
    <section className="ux-review-panel">
      <span className="eyebrow">TEN SECONDS, YOUR IMPRESSION</span>
      <h2>10秒見て、どう感じましたか？</h2>
      <p>
        表示中の案を見てから、率直に評価してください。自動検査を人の評価に数えません。
      </p>
      {phase === "idle" && (
        <button type="button" className="review-start" onClick={start}>
          表示中の案で10秒レビューを始める
        </button>
      )}
      {phase === "exposing" && (
        <div className="review-timer" role="status">
          レビュー中 · あと{Math.ceil((10000 - elapsed) / 1000)}秒{" "}
          <small>タブを離れている時間は数えません</small>
        </div>
      )}
      {phase === "rating" && (
        <div className="review-form">
          <p>
            評価する案：
            <strong>{options.find((o) => o.id === reviewed)?.title}</strong>
          </p>
          {[
            ["understood", "どんな過ごし方か分かりましたか？"],
            ["uncertaintyVisible", "未確認の点が分かりましたか？"],
            ["nextActionClear", "次にすることが分かりましたか？"],
          ].map(([key, label]) => (
            <fieldset key={key}>
              <legend>{label}</legend>
              {[
                [true, "はい"],
                [false, "いいえ"],
              ].map(([value, text]) => (
                <label key={text}>
                  <input
                    type="radio"
                    name={"review-" + key}
                    checked={answers[key] === value}
                    onChange={() => setAnswers((a) => ({ ...a, [key]: value }))}
                  />
                  {text}
                </label>
              ))}
            </fieldset>
          ))}
          <fieldset>
            <legend>
              この案に魅力を感じますか？（1：感じない〜5：感じる）
            </legend>
            {[1, 2, 3, 4, 5].map((n) => (
              <label key={n}>
                <input
                  type="radio"
                  name="review-appeal"
                  checked={appeal === n}
                  onChange={() => setAppeal(n)}
                />
                {n}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>改善してほしい点（任意）</legend>
            {Object.entries(issueLabels).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={issues.includes(key)}
                  onChange={() =>
                    setIssues((v) =>
                      v.includes(key)
                        ? v.filter((x) => x !== key)
                        : [...v, key],
                    )
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="review-start"
            onClick={submit}
            disabled={!complete || busy}
          >
            {busy
              ? "保存中…"
              : data.review.endpoint
                ? "自分の評価を保存"
                : "自分の評価をJSONに書き出す"}
          </button>
        </div>
      )}
      {phase === "done" && (
        <button
          type="button"
          className="review-start"
          onClick={() => setPhase("idle")}
        >
          別の案もレビューする
        </button>
      )}
      {message && (
        <p className="review-message" role="status">
          {message}
        </p>
      )}
      <p className="review-footnote">
        自己申告のレビューです。同じブラウザ・版・案の再回答は、改善への集計では最新だけを使います。
        {data.review.endpoint
          ? ""
          : "このHTMLはファイル表示のため、送信せずJSONとして保存します。"}
      </p>
    </section>
  );
}
