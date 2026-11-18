import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const python = process.env.VEHICLE3D_PYTHON || "python3";
const script = fileURLToPath(new URL("./runtime.py", import.meta.url));
const child = spawn(python, [script, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(`Vehicle3D: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
