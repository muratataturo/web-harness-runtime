import { Worker } from "node:worker_threads";
/** Parse in a bounded worker so a hostile PDF cannot block the runtime event loop. */
export async function extractPdf(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<{ text: string; pages: number }> {
  signal.throwIfAborted();
  if (
    bytes.byteLength > 16 * 1024 * 1024 ||
    Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-"
  )
    throw Error("PDFの形式または取得サイズ上限が不正です");
  const worker = new Worker(
    new URL("../web/pdf-reader-worker.js", import.meta.url),
    {
      workerData: bytes,
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 8,
      },
    },
  );
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("PDF解析は8秒までです")),
        8000,
      );
      const aborted = () =>
        reject(signal.reason ?? Error("PDF解析を中止しました"));
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
      };
      worker.once("message", (value) => {
        cleanup();
        value.error ? reject(Error(value.error)) : resolve(value);
      });
      worker.once("error", (error) => {
        cleanup();
        reject(error);
      });
      worker.once("exit", (code) => {
        cleanup();
        reject(Error(`PDF解析workerが終了しました (${code})`));
      });
    });
  } finally {
    await worker.terminate();
  }
}
