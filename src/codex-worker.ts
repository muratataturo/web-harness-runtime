import { mkdir } from "node:fs/promises";
import { CodexAgent } from "./codex.js";

/** A per-account VM keeps the official CLI's login on its own retained disk. */
await mkdir("/sandbox/.codex", { recursive: true, mode: 0o700 });
if (process.argv.includes("--check")) {
  const client = new CodexAgent({
    cwd: "/sandbox",
    signal: AbortSignal.timeout(15000),
    onStep: async () => {},
  });
  try {
    const auth = await client.initialize();
    console.log(
      JSON.stringify({
        authenticated: true,
        authentication: auth.authentication,
        models: (await client.models()).map((m) => m.model),
      }),
    );
  } catch {
    console.log(
      JSON.stringify({
        authenticated: false,
        authentication: "chatgpt-required",
      }),
    );
    process.exitCode = 1;
  } finally {
    await client.close();
  }
} else {
  console.log(
    "Codex account worker ready. Use sandbox codex login for initial sign-in.",
  );
  const timer = setInterval(() => {}, 60000);
  const stop = () => {
    clearInterval(timer);
    process.exitCode = 0;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
