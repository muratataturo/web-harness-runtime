import test from "node:test";
import assert from "node:assert/strict";
import { extractPdf } from "../src/pdf-reader.js";
import { readPublicHtml } from "../src/html-reader.js";
import { newTask } from "../src/runtime.js";
import { addEvidence } from "../src/evidence.js";
import { validateActionPlan } from "../src/answer-plan.js";
function pdf(pages = 1, japanese = false) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids = [];
  for (let i = 0; i < pages; i++) {
    const n = objects.length + 1;
    kids.push(`${n} 0 R`);
    const font = japanese
      ? "/Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UTF16-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 5 >> /FontDescriptor << /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [-92 -250 1010 922] /Ascent 752 /Descent -271 /CapHeight 752 /ItalicAngle 0 /StemV 80 >> /DW 1000 >>]"
      : "/Type /Font /Subtype /Type1 /BaseFont /Helvetica";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << ${font} >> >> >> /Contents ${n + 1} 0 R >>`,
    );
    const content = japanese
      ? `BT /F1 12 Tf 72 720 Td <${Buffer.from("カフェのお茶 1030円", "utf16le").swap16().toString("hex")}> Tj ET`
      : "BT /F1 12 Tf 72 720 Td (Cafe Coffee) Tj 0 -20 Td (850) Tj ET";
    objects.push(
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(text);
  text +=
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text);
}
test("bounded PDF extraction preserves text and page identity and rejects oversized page counts", async () => {
  const result = await extractPdf(pdf(), new AbortController().signal);
  assert.equal(result.pages, 1);
  assert.match(result.text, /PDF 1\/1/);
  assert.match(result.text, /Cafe Coffee/);
  assert.match(result.text, /850/);
  await assert.rejects(
    extractPdf(pdf(21), new AbortController().signal),
    /20ページ/,
  );
  await assert.rejects(
    extractPdf(Buffer.from("not a PDF"), new AbortController().signal),
    /形式/,
  );
  const c = new AbortController();
  c.abort();
  await assert.rejects(extractPdf(pdf(), c.signal));
});
test("Japanese PDF character maps keep menu names and prices rather than silently dropping them", async () => {
  const result = await extractPdf(pdf(1, true), new AbortController().signal);
  assert.match(result.text, /カフェのお茶/);
  assert.match(result.text, /1030円/);
});
test("public PDF uses the same navigation boundary, status checks and citation provenance as HTML", async () => {
  const url = "https://shop.create-restaurants.co.jp/0941/menu.pdf";
  const resolveHost = async () => [{ address: "93.184.216.34" }];
  const page = await readPublicHtml(
    url,
    ["shop.create-restaurants.co.jp"],
    new AbortController().signal,
    {
      resolveHost,
      fetcher: async () =>
        new Response(pdf(), { headers: { "content-type": "application/pdf" } }),
    },
  );
  assert.equal(page.acquisition?.kind, "public-pdf");
  assert.match(page.text, /Cafe Coffee/);
  const task = newTask({
    query: "カフェの価格",
    urls: [url],
    maxSteps: 5,
    maxPages: 2,
    timeoutSeconds: 5,
  });
  task.pages.push({ ...page, id: "p1" });
  const ev = addEvidence(
    task,
    "p1",
    page.text.slice(page.text.indexOf("Cafe Coffee")),
  );
  const plan = {
    steps: [],
    branches: [],
    budget: {
      items: [
        {
          id: "coffee",
          label: "Coffee",
          quantity: 1,
          unitYen: 850,
          basis: "published" as const,
          evidenceIds: [ev.id],
        },
      ],
      totalYen: 850,
    },
  };
  validateActionPlan(task, plan);
  plan.budget.items[0]!.unitYen = 950;
  plan.budget.totalYen = 950;
  assert.throws(() => validateActionPlan(task, plan), /掲載単価/);
  let calls = 0;
  const blocked = await readPublicHtml(
    url,
    ["shop.create-restaurants.co.jp"],
    new AbortController().signal,
    {
      resolveHost,
      fetcher: async () => {
        calls++;
        return new Response("denied", {
          status: 403,
          headers: { "content-type": "application/pdf" },
        });
      },
    },
  );
  assert.equal(blocked.acquisition?.status, 403);
  assert.equal(calls, 1);
  await assert.rejects(
    readPublicHtml(
      url,
      ["shop.create-restaurants.co.jp"],
      new AbortController().signal,
      {
        resolveHost: async () => [{ address: "127.0.0.1" }],
        fetcher: async () => {
          throw Error("must not fetch");
        },
      },
    ),
    /公開|プライベート|private|IP/i,
  );
});
