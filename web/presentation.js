export const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** A view of the saved answer, with no new recommendation or inferred facts. */
export function answerBrief(task) {
  const candidates = task?.answer?.candidates ?? [];
  const matches = candidates.flatMap((c) => c.matches ?? []);
  const budgetLine = normalizeMarkdown(task?.answer?.summary)
    .split("\n")
    .find(
      (line) =>
        /^(?:[ABＡＢ]|案[AB])?(?:合計|総額)/.test(line.trim()) &&
        /円/.test(line),
    );
  const roleExcluded = (m) =>
    m.status === "unknown" &&
    /役割対象外|役割外|非適用/.test(m.explanation ?? "");
  const concerns = candidates.flatMap((c) =>
    (c.matches ?? [])
      .filter((m) => m.status !== "supported" && !roleExcluded(m))
      .map((m) => ({
        status: m.status,
        text:
          m.explanation ||
          task.criteria?.find((x) => x.id === m.criterionId)?.description,
      })),
  );
  if (task?.specificity?.status === "needs_detail")
    concerns.unshift({
      status: "unknown",
      text: `手順の具体性に確認不足：${task.specificity.issues?.[0] ?? "実行手順を確認してください"}`,
    });
  return {
    supported: matches.filter((m) => m.status === "supported").length,
    unknown: matches.filter((m) => m.status === "unknown").length,
    contradicted: matches.filter((m) => m.status === "contradicted").length,
    total: matches.length,
    roleExcluded: matches.filter(roleExcluded).length,
    budgetText:
      budgetLine
        ?.match(/[^。]+。?/g)
        ?.slice(0, 2)
        .join("") ?? null,
    facts:
      candidates[0]?.matches
        ?.filter((m) => m.status === "supported")
        .slice(0, 3)
        .map((m) => ({
          label:
            task.criteria?.find((c) => c.id === m.criterionId)?.description ??
            "確認内容",
          text: m.explanation,
        })) ?? [],
    concerns,
    limitation: task?.answer?.limitations?.[0] ?? null,
    capturedAt:
      task?.pages?.[0]?.capturedAt ??
      task?.evidence?.[0]?.capturedAt ??
      task?.updatedAt,
  };
}
export function safeLink(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function normalizeMarkdown(text) {
  return String(text ?? "")
    .replaceAll("\\n", "\n")
    .replace(/^【(.+?)】\s*$/gm, "## $1");
}
function inline(text) {
  // Tokenize before escaping. Source HTML is always text; only our own tags are emitted.
  const tokens = [];
  const token = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let s = String(text).replace(/\u0000/g, "");
  s = s.replace(/`([^`\n]+)`/g, (_, code) =>
    token(`<code>${escapeHtml(code)}</code>`),
  );
  s = s.replace(/!?\[([^\]\n]+)\]\(([^\s)]+)\)/g, (_, label, url) => {
    const href = safeLink(url);
    return token(
      href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
        : escapeHtml(label),
    );
  });
  s = escapeHtml(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)] ?? "");
}
/** Small, deliberate Markdown subset. No HTML, embeds, style, scripts or remote image execution. */
export function markdown(text) {
  const lines = normalizeMarkdown(text)
      .split("\n")
      .map((line) =>
        line.replace(
          /^(\d{1,2}:\d{2}(?:[〜~～–-]\d{1,2}:\d{2})?)(.*)$/,
          "- **$1** $2",
        ),
      ),
    output = [];
  let i = 0;
  const tableCells = (s) =>
    s
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((x) => x.trim());
  const special = (s) =>
    /^\s*(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s|---\s*$)/.test(s);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3);
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]))
        code.push(lines[i++]);
      i++;
      output.push(
        `<pre><code aria-label="${escapeHtml(language || "code")}">${escapeHtml(code.join("\n"))}</code></pre>`,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*---\s*$/.test(line)) {
      output.push("<hr>");
      i++;
      continue;
    }
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])
    ) {
      const headers = tableCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim())
        rows.push(tableCells(lines[i++]));
      output.push(
        `<div class="md-table"><table><thead><tr>${headers.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, n) => `<td>${inline(row[n] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      output.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    const list = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (list) {
      const ordered = /^\d/.test(list[1]),
        tag = ordered ? "ol" : "ul",
        items = [];
      while (i < lines.length) {
        const item = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push(`<li>${inline(item[2])}</li>`);
        i++;
      }
      output.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !special(lines[i]) &&
      !(lines[i].includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? ""))
    )
      para.push(lines[i++]);
    output.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return output.join("\n");
}
export function presentation(r) {
  const raw = normalizeMarkdown(r.task?.answer?.summary);
  const lines = raw.split("\n").filter((x) => x.trim());
  let title = (lines[0] ?? "調査から見えてきた選択肢").replace(
    /^#{1,6}\s+/,
    "",
  );
  let intro =
    lines.find((l) => l !== lines[0] && !/^#|^\d{1,2}:/.test(l)) ?? "";
  if (lines[0] && !/^#{1,6}\s/.test(lines[0])) {
    const firstSentence = title.match(/^.*?[。!?！？]/)?.[0] ?? title;
    const limit = Math.min(firstSentence.length, 80);
    const rest = title.slice(limit).trim();
    if (rest) {
      intro = rest + (intro ? "\n" + intro : "");
      title = title.slice(0, limit) + (limit < firstSentence.length ? "…" : "");
    }
  }
  const sections = [];
  let current = { title: "提案の概要", lines: [] };
  for (const line of raw.split("\n")) {
    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (h) {
      if (current.lines.some((l) => l.trim())) sections.push(current);
      current = { title: h[1], lines: [] };
    } else current.lines.push(line);
  }
  if (current.lines.some((l) => l.trim())) sections.push(current);
  const timeline =
    r.task?.answer?.actionPlan?.steps
      ?.map((s, stepIndex) => ({
        stepIndex,
        time: s.when,
        text: `${s.where} — ${s.action}${s.durationMinutes ? `（${s.durationMinutes}分の見積）` : ""}。${s.how} 完了の目安：${s.doneWhen}。${s.locationStatus === "unconfirmed" ? "場所の詳細は未確認。" : ""}`,
      }))
      .filter((s) => /^\d{1,2}:\d{2}$/.test(s.time)) ??
    lines.flatMap((line) => {
      const m = line.match(/^(\d{1,2}:\d{2}(?:[〜~～–-]\d{1,2}:\d{2})?)(.*)$/);
      return m ? [{ time: m[1], text: m[2].trim() }] : [];
    });
  return {
    raw,
    title,
    sections,
    timeline,
    intro,
  };
}
