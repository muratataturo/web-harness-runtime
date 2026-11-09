#!/bin/sh
# No host mounts, API keys, or external network are passed to the smoke container.
set -eu
image=${1:-web-harness-runtime:local}
docker run --rm --network none "$image" /bin/sh -euc '
  node --version
  /opt/web-harness/node_modules/.bin/pi --version
  /opt/web-harness/node_modules/.bin/agent-browser --version
  "$AGENT_BROWSER_EXECUTABLE_PATH" --version
  node /opt/web-harness/dist/cli.js --help
  node /opt/web-harness/dist/cli.js trusted list --all
  node -e '\''const fs=require("node:fs");if(process.getuid()!==1000)throw Error("expected uid 1000");for(const p of ["/opt/web-harness/.env","/workspace/.env","/opt/web-harness/.git"])if(fs.existsSync(p))throw Error("unexpected host material: "+p);if(process.env.OPENROUTER_API_KEY)throw Error("unexpected credential");console.log("nonroot / no host secrets: OK")'\''
  /opt/web-harness/node_modules/.bin/agent-browser --session image-smoke --json open "data:text/html,<title>Sandbox smoke</title><h1>Ready</h1>"
  /opt/web-harness/node_modules/.bin/agent-browser --session image-smoke --json get title
  /opt/web-harness/node_modules/.bin/agent-browser --session image-smoke --json close
'
