FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY tasks.py ./

CMD ["uv", "run", "celery", "-A", "tasks", "worker", "--loglevel=info", "-Q", "ingestion_tasks", "-c", "2"]
