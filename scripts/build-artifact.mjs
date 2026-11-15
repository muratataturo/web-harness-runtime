import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
await build({
  entryPoints: ["web/artifact-client.jsx"],
  bundle: true,
  format: "iife",
  minify: true,
  legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: "web/artifact-client.bundle.js",
  loader: { ".png": "dataurl" },
  metafile: true,
});

const notices = await Promise.all(
  [
    "node_modules/@astryxdesign/theme-neutral/LICENSE",
    "node_modules/react/LICENSE",
    "node_modules/react-dom/LICENSE",
    "node_modules/leaflet/LICENSE",
    "node_modules/@mapbox/vector-tile/LICENSE.txt",
    "node_modules/@mapbox/point-geometry/LICENSE",
    "node_modules/pbf/LICENSE",
  ].map((p) => readFile(p, "utf8")),
);
const notice =
  "/*! Bundled licenses: Astryx (Meta), React, React DOM, Leaflet, Mapbox vector-tile, point-geometry, Pbf\n" +
  notices.join("\n\n") +
  "\n*/\n";
const js = await readFile("web/artifact-client.bundle.js", "utf8");
await writeFile("web/artifact-client.bundle.js", notice + js);
