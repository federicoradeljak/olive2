# syntax=docker/dockerfile:1

# Stage 1: Build Frontend SPA with Vite + pnpm
FROM node:22-slim AS web-builder
WORKDIR /frontend

RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

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

COPY backend/pyproject.toml backend/uv.lock backend/.python-version ./backend/
COPY backend/src ./backend/src
COPY backend/alembic.ini ./backend/alembic.ini
COPY backend/migrations ./backend/migrations

WORKDIR /app/backend
RUN uv sync --frozen --no-dev

COPY --from=web-builder /frontend/dist /app/frontend/dist

ENV PORT=4470 \
    OLIVE_BIND_HOST=0.0.0.0 \
    OLIVE_BIND_PORT=4470 \
    OLIVE_WEB_ROOT=/app/frontend/dist \
    OLIVE_DATA_DIR=/app/data \
    OLIVE_CONFIG_DIR=/app/data/config \
    OLIVE_MEETINGS_DIR=/app/data/meetings \
    OLIVE_MODELS_DIR=/app/data/models \
    HF_HOME=/app/data/models/huggingface \
    TRANSFORMERS_CACHE=/app/data/models/huggingface \
    OTEL_SDK_DISABLED=true \
    HF_HUB_DISABLE_TELEMETRY=1

EXPOSE 4470
VOLUME ["/app/data"]

CMD ["uv", "run", "--no-dev", "olive", "serve"]
