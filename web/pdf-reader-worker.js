// Host-owned parser. No URLs, scripts, or resource fetches from a PDF are executed.
import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy, createIsomorphicCanvasFactory } from "unpdf";
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
  const rendering = workerData.pageNumber !== undefined;
  const Factory = rendering
    ? await createIsomorphicCanvasFactory(() => import("@napi-rs/canvas"))
    : undefined;
  // Also bound intermediate canvases, not only the final viewport.
  const CanvasFactory =
    Factory &&
    class extends Factory {
      create(w, h) {
        if (!Number.isFinite(w * h) || w <= 0 || h <= 0 || w * h > 16_000_000)
          throw Error("PDF中間描画は1600万画素までです");
        return super.create(w, h);
      }
      reset(c, w, h) {
        if (!Number.isFinite(w * h) || w <= 0 || h <= 0 || w * h > 16_000_000)
          throw Error("PDF中間描画は1600万画素までです");
        return super.reset(c, w, h);
      }
    };
  pdf = await getDocumentProxy(new Uint8Array(workerData.bytes), {
    ...(CanvasFactory ? { CanvasFactory } : {}),
    isEvalSupported: false,
    cMapUrl: join(resourceRoot, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: join(resourceRoot, "standard_fonts") + "/",
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    maxImageSize: rendering ? 16_000_000 : 1_000_000,
    stopAtErrors: true,
  });
  if (pdf.numPages > 20) throw Error("PDFは20ページまでです");
  if (rendering) {
    const n = workerData.pageNumber;
    if (!Number.isSafeInteger(n) || n < 1 || n > pdf.numPages)
      throw Error("PDFのページ番号が範囲外です");
    const page = await pdf.getPage(n);
    const initial = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 2000 / Math.max(initial.width, initial.height));
    const viewport = page.getViewport({ scale });
    const canvas = new CanvasFactory().create(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({
      canvas: canvas.canvas,
      canvasContext: canvas.context,
      viewport,
    }).promise;
    const png = canvas.canvas.toBuffer("image/png");
    if (png.length > 4 * 1024 * 1024) throw Error("PDF画像のサイズ上限です");
    parentPort.postMessage({
      png,
      width: canvas.canvas.width,
      height: canvas.canvas.height,
    });
    new CanvasFactory().destroy(canvas);
  } else {
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
  }
} catch (error) {
  parentPort.postMessage({
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  await pdf?.destroy();
}
