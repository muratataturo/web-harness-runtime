# Build on the self-hosted gateway VM (or push the result to its registry).
# No secret, .env, browser profile, or runtime artifact is copied into this image.
FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/web-harness
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY examples ./examples
COPY benchmarks ./benchmarks
COPY config ./config
COPY web ./web
COPY infra/openshell/chromium /opt/web-harness/infra/openshell/chromium
RUN chmod 755 /opt/web-harness/infra/openshell/chromium \
    && ./node_modules/.bin/tsc \
    && npm prune --omit=dev \
    && mkdir -p /workspace /home/node/.agent-browser \
    && chown -R node:node /workspace /home/node
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/web-harness/infra/openshell/chromium \
    RUNTIME_DIR=/workspace/.runtime \
    PI_CODING_AGENT_DIR=/tmp/pi-agent
USER node
WORKDIR /workspace
CMD ["/usr/local/bin/node", "/opt/web-harness/dist/cli.js", "--help"]
