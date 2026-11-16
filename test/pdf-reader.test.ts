import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPdf,
  renderPdfPage,
  inspectPdfPage,
} from "../src/pdf-reader.js";
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
      : "1 0 0 rg 50 50 40 40 re f 0 0 0 rg BT /F1 12 Tf 72 720 Td (Cafe Coffee) Tj 0 -20 Td (850) Tj ET";
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

test("PDF rendering shows actual layout and color, bounds page numbers, and rejects changed source bytes", async () => {
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const input = pdf();
  const result = await renderPdfPage(input, 1, new AbortController().signal);
  assert.ok(result.width > 600 && result.height > 790);
  assert.ok(result.width * result.height <= 4_000_000);
  assert.equal(Buffer.from(result.png).subarray(1, 4).toString(), "PNG");
  const image = await loadImage(Buffer.from(result.png));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  assert.ok(
    pixels.some(
      (v, i) =>
        i % 4 === 0 && v > 200 && pixels[i + 1]! < 30 && pixels[i + 2]! < 30,
    ),
    "source red rectangle must remain red",
  );
  assert.ok(
    pixels.some((v, i) => i % 4 !== 3 && v < 100),
    "render must contain the source text pixels",
  );
  await assert.rejects(
    async () => renderPdfPage(input, 0, new AbortController().signal),
    /ページ/,
  );
  await assert.rejects(
    renderPdfPage(input, 2, new AbortController().signal),
    /ページ/,
  );
  const root = await mkdtemp(join(tmpdir(), "pdf-visual-"));
  try {
    const task = newTask({
      query: "カレンダー",
      urls: ["https://www.tokyo-zoo.net/file/calendar_2026_ueno.pdf"],
      maxSteps: 20,
      maxPages: 3,
      timeoutSeconds: 10,
    });
    const hash = createHash("sha256").update(input).digest("hex");
    task.pages.push({
      ...pageForInspection(task.urls[0]!),
      pdf: { sha256: hash, pages: 1 },
    });
    await mkdir(join(root, "pdf-assets"));
    await writeFile(join(root, "pdf-assets", hash + ".pdf"), input);
    const inspected = await inspectPdfPage(
      task,
      root,
      "p1",
      1,
      new AbortController().signal,
    );
    assert.equal(inspected.content[1]!.type, "image");
    assert.equal(task.pdfInspections?.length, 1);
    assert.equal(
      task.evidence.length,
      0,
      "visual interpretation is not a synthetic text quote",
    );
    await writeFile(join(root, "pdf-assets", hash + ".pdf"), pdf(2));
    await assert.rejects(
      inspectPdfPage(task, root, "p1", 1, new AbortController().signal),
      /完全性/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
function pageForInspection(url: string) {
  return {
    id: "p1",
    url,
    title: "カレンダー",
    text: "公開された開園カレンダー",
    links: [],
    truncated: false,
    capturedAt: new Date().toISOString(),
    acquisition: { kind: "public-pdf" as const, status: 200 },
  };
}

test("image-based PDF content above one megapixel is rendered rather than silently becoming a blank page", async () => {
  const { deflateSync } = await import("node:zlib");
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const pixels = Buffer.alloc(1100 * 1000 * 3);
  for (let i = 0; i < pixels.length; i += 3) pixels[i] = 255;
  const image = deflateSync(pixels).toString("latin1");
  const stream = "q 200 0 0 200 0 0 cm /Im1 Do Q";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 1100 /Height 1000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n${image}\nendstream`,
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = text.length;
  text +=
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const rendered = await renderPdfPage(
    Buffer.from(text, "latin1"),
    1,
    new AbortController().signal,
  );
  const decoded = await loadImage(Buffer.from(rendered.png));
  const canvas = createCanvas(decoded.width, decoded.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(decoded, 0, 0);
  const center = ctx.getImageData(
    Math.floor(decoded.width / 2),
    Math.floor(decoded.height / 2),
    1,
    1,
  ).data;
  assert.ok(
    center[0]! > 240 && center[1]! < 20 && center[2]! < 20,
    "the embedded red image must be visible",
  );
});
