# syntax=docker/dockerfile:1

# Stage 1: Fetch llama.cpp builds for every platform the image may run on.
# Runs on the build host's architecture; the Linux build is chosen by TARGETARCH.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0 AS llama-fetcher
ARG TARGETARCH
WORKDIR /llama

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar && rm -rf /var/lib/apt/lists/*

COPY scripts/fetch-llama.ts ./scripts/
COPY packages/server/src/providers/local/llama-targets.ts ./packages/server/src/providers/local/

RUN case "$TARGETARCH" in \
      amd64) LINUX_TARGET=linux-x64-vulkan ;; \
      arm64) LINUX_TARGET=linux-arm64-vulkan ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" && exit 1 ;; \
    esac && \
    bun scripts/fetch-llama.ts darwin-arm64-metal "$LINUX_TARGET"

# Stage 2: Application Dependencies and Web Build
FROM oven/bun:1.4.0 AS app-builder
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/

RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/web ./packages/web

RUN bun run build:web

# Stage 3: Production Runtime
FROM oven/bun:1.4.0 AS runner
WORKDIR /app

# Install runtime system utilities, audio processing, and Vulkan / Mesa GPU drivers
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    mesa-vulkan-drivers \
    libvulkan1 \
    vulkan-tools \
    libva-drm2 \
    libdrm2 \
    && rm -rf /var/lib/apt/lists/*

# Copy built application and node_modules
COPY --from=app-builder /app /app

# Copy llama.cpp builds (vendor/llama/b10453/<target>/); the server picks one at runtime by platform
COPY --from=llama-fetcher /llama/vendor/llama /app/vendor/llama

ENV NODE_ENV=production \
    PORT=4470 \
    OLIVE_DATA_DIR=/app/data \
    OLIVE_CONFIG_DIR=/app/data/config \
    OLIVE_MEETINGS_DIR=/app/data/meetings \
    OLIVE_MODELS_DIR=/app/data/models \
    HF_HOME=/app/data/models/huggingface \
    TRANSFORMERS_CACHE=/app/data/models/huggingface

EXPOSE 4470
VOLUME ["/app/data"]

CMD ["bun", "run", "packages/server/src/index.ts"]
