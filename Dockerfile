# syntax=docker/dockerfile:1

# Stage 1: Build Frontend SPA with Vite + pnpm
FROM node:22-slim AS web-builder
WORKDIR /frontend

RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY frontend/ ./
RUN pnpm run build

# Stage 2: Production Python 3.12 Runtime with uv & FFmpeg
FROM python:3.12-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Dependencies first: this layer (incl. the compiled ctc-forced-aligner sdist)
# stays cached across source-only changes.
COPY backend/pyproject.toml backend/uv.lock backend/.python-version ./backend/
WORKDIR /app/backend
RUN --mount=type=cache,id=uv,target=/root/.cache/uv \
    apt-get update && apt-get install -y --no-install-recommends build-essential \
    && uv sync --frozen --no-dev --no-install-project \
    && apt-get purge -y build-essential && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY backend/src ./src
COPY backend/alembic.ini ./alembic.ini
COPY backend/migrations ./migrations
RUN --mount=type=cache,id=uv,target=/root/.cache/uv \
    uv sync --frozen --no-dev

COPY --from=web-builder /frontend/dist /app/frontend/dist
COPY CHANGELOG.md /app/CHANGELOG.md

ENV PORT=4470 \
    OLIVE_DOCKER=1 \
    OLIVE_BIND_HOST=0.0.0.0 \
    OLIVE_BIND_PORT=4470 \
    OLIVE_WEB_ROOT=/app/frontend/dist \
    OLIVE_DATA_DIR=/app/data \
    OLIVE_CONFIG_DIR=/app/data/config \
    OLIVE_MEETINGS_DIR=/app/data/meetings \
    OLIVE_MODELS_DIR=/app/models \
    HF_HOME=/app/models/huggingface \
    TRANSFORMERS_CACHE=/app/models/huggingface \
    OTEL_SDK_DISABLED=true \
    HF_HUB_DISABLE_TELEMETRY=1

EXPOSE 4470
# NOTE: no VOLUME directives on purpose — /app/models must be an explicitly mounted
# persistent volume (named volume or bind mount). If it is not a mount, or is not
# writable, the server refuses to start with an explanatory error instead of
# silently downloading multi-GB models into throwaway container storage.
# Run with e.g.: -v olive_data:/app/data -v olive_models:/app/models

CMD ["uv", "run", "--no-dev", "olive", "serve"]
