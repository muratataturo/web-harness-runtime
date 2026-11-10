import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const snapshotAssets = [
  "web/index.html",
  "web/app.js",
  "web/style.css",
  "web/chat.html",
  "web/chat.js",
  "web/chat.css",
  "config/trusted-urls.json",
  "config/runtime-dependencies.json",
  "examples/recruit-day-out.json",
  "examples/recruit-life-plan.json",
  "docs/evidence/codex-strata.json",
  "docs/evidence/recruit-theme-results.json",
  "docs/evidence/delivery-results.json",
];
/** Deliberate allowlist: never package .env, auth caches, sessions, or node_modules. */
export async function buildRuntimeSnapshot(
  directory: string,
  project = fileURLToPath(new URL("../", import.meta.url)),
) {
  const dist = join(project, "dist");
  const files = (await readdir(dist, { withFileTypes: true }))
    .filter((e) => e.isFile() && /^[a-zA-Z0-9._-]+\.js$/.test(e.name))
    .map((e) => `dist/${e.name}`);
  if (!files.includes("dist/cli.js"))
    throw new Error("npm run buildを先に実行してください");
  const contents = new Map<string, Buffer>();
  for (const file of [...files, ...snapshotAssets])
    contents.set(file, await readFile(join(project, file)));
  contents.set("package.json", Buffer.from('{"type":"module","private":true}'));
  const digest = (value: Buffer | string) =>
    createHash("sha256").update(value).digest("hex");
  const hashes = Object.fromEntries(
    [...contents]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bytes]) => [name, digest(bytes)]),
  );
  const lock = await readFile(join(project, "package-lock.json"), "utf8")
    .then(JSON.parse)
    .catch(async (e) => {
      if (e.code !== "ENOENT") throw e;
      const map = JSON.parse(
        await readFile(
          join(project, "config/runtime-dependencies.json"),
          "utf8",
        ),
      );
      return {
        packages: Object.fromEntries(
          Object.entries(map).map(([name, value]) => [
            "node_modules/" + name,
            value,
          ]),
        ),
      };
    });
  const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  const dependencies = Object.fromEntries(
    Object.keys(pkg.dependencies ?? {})
      .sort()
      .map((name) => {
        const entry = lock.packages?.[`node_modules/${name}`];
        if (!entry?.version || !entry.integrity)
          throw new Error(`依存バージョンを検証できません: ${name}`);
        return [name, { version: entry.version, integrity: entry.integrity }];
      }),
  );
  const revision = digest(JSON.stringify({ hashes, dependencies })).slice(
    0,
    24,
  );
  const root = resolve(directory, "snapshot");
  for (const [name, bytes] of contents) {
    const parts = name.split("/");
    await mkdir(join(root, ...parts.slice(0, -1)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(root, name), bytes, { mode: 0o600 });
  }
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({ revision, hashes, dependencies }),
    { mode: 0o600 },
  );
  const archive = resolve(directory, "runtime.tar.gz");
  await promisify(execFile)(
    "tar",
    [
      "-czf",
      archive,
      "-C",
      root,
      "dist",
      "web",
      "config",
      "examples",
      "docs",
      "package.json",
      "manifest.json",
    ],
    { timeout: 30000 },
  );
  return { archive, revision };
}
export function snapshotInstallScript(revision: string, archive: string) {
  if (
    !/^[0-9a-f]{24}$/.test(revision) ||
    !/^\/sandbox\/bundles\/[a-zA-Z0-9.-]+\.tar\.gz$/.test(archive)
  )
    throw new Error("不正なruntime snapshotパス");
  const root = `/sandbox/runtime/${revision}`;
  return `const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto');const root=${JSON.stringify(root)};fs.mkdirSync(root,{recursive:true,mode:448});cp.execFileSync('/bin/tar',['-xzf',${JSON.stringify(archive)},'-C',root]);const m=JSON.parse(fs.readFileSync(root+'/manifest.json'));const hash=v=>crypto.createHash('sha256').update(v).digest('hex');if(m.revision!==${JSON.stringify(revision)})throw Error('runtime dependency/revision mismatch');const lock=JSON.parse(fs.readFileSync('/opt/web-harness/package-lock.json'));for(const [name,want]of Object.entries(m.dependencies)){const got=lock.packages['node_modules/'+name];if(!got||got.version!==want.version||got.integrity!==want.integrity)throw Error('runtime dependency/revision mismatch');}for(const [p,h] of Object.entries(m.hashes)){if(!((p.startsWith('dist/')&&p.endsWith('.js')&&p.split('/').length===2&&!p.includes('..'))||${JSON.stringify([...snapshotAssets, "package.json"])}.includes(p))||hash(fs.readFileSync(root+'/'+p))!==h)throw Error('runtime hash mismatch');}if(!fs.existsSync(root+'/node_modules'))fs.symlinkSync('/opt/web-harness/node_modules',root+'/node_modules','dir');console.log(JSON.stringify({revision:m.revision,verified:true}));`;
}
