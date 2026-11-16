// Host-owned parser. No URLs, scripts, or resource fetches from a PDF are executed.
import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const resourceRoot = dirname(
  fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
);
globalThis.fetch = async () => {
  throw Error("PDFの外部リソース取得は無効です");
};
let pdf;
try {
  pdf = await getDocumentProxy(new Uint8Array(workerData), {
    isEvalSupported: false,
    cMapUrl: join(resourceRoot, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: join(resourceRoot, "standard_fonts") + "/",
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    maxImageSize: 1_000_000,
    stopAtErrors: true,
  });
  if (pdf.numPages > 20) throw Error("PDFは20ページまでです");
  const pages = [];
  let size = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) =>
        "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
      )
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    size += text.length;
    if (size > 120000) throw Error("PDF本文の上限です");
    pages.push(`【PDF ${i}/${pdf.numPages}ページ】\n${text}`);
    page.cleanup();
  }
  if (pages.every((p) => p.replace(/^.*\n/, "").trim().length < 6))
    throw Error(
      "PDFに抽出できる本文がありません。画像のみの文書は文字を推測しません",
    );
  parentPort.postMessage({ text: pages.join("\n\n"), pages: pdf.numPages });
} catch (error) {
  parentPort.postMessage({
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  await pdf?.destroy();
}
