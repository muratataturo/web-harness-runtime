import { readFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
export const strataStateRoot = () =>
  resolve(
    process.env.STRATA_STATE_DIR ??
      join(process.env.RUNTIME_DIR ?? ".runtime", "strata-colab"),
  );
export async function strataSettings(root = strataStateRoot()) {
  const managed = await readFile(join(root, "connection.json"), "utf8")
    .then(JSON.parse)
    .catch((e) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
  if (
    managed &&
    (typeof managed.baseUrl !== "string" ||
      typeof managed.keyFile !== "string" ||
      !isAbsolute(managed.keyFile) ||
      typeof managed.model !== "string" ||
      !/^strata-colab\/[a-zA-Z0-9._:-]+$/.test(managed.model))
  )
    throw Error("Strataの管理接続が不正です。legacy設定へfallbackしません");
  return {
    baseUrl:
      process.env.STRATA_BASE_URL ??
      managed?.baseUrl ??
      "http://127.0.0.1:18081/v1",
    keyFile:
      process.env.STRATA_KEY_FILE ??
      managed?.keyFile ??
      "/private/tmp/strata-colab-api-key",
    model:
      process.env.OPENCODE_MODEL ??
      managed?.model ??
      "strata-colab/qwen3.8-flash-next-iq2_xs",
    managed: !!managed,
  };
}
