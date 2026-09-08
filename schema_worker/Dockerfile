FROM python:3.11-slim

WORKDIR /app

# Copy project files
COPY pyproject.toml .

# FastAPI deps for the worker API. Deliberately no `uv` here anymore — the sandbox entrypoint
# installs the *target* package with plain pip into a scratch dir (see sandbox_entrypoint.py),
# since this image now plays two roles and needs nothing extra for either.
RUN pip install hatchling fastapi uvicorn pydantic

# Uncomment if deploying the worker itself inside a container with the Docker socket mounted in
# (see the DEPLOYMENT note in main.py for the tradeoff vs. running the worker as a plain host
# process instead, which needs no docker CLI in this image at all):
# RUN apt-get update && apt-get install -y --no-install-recommends docker.io && rm -rf /var/lib/apt/lists/*

COPY introspection.py main.py extract_cli.py sandbox_entrypoint.py ./

EXPOSE 8000

# Default: run the API worker. The same image is also launched with an overridden command
# (`python /app/sandbox_entrypoint.py ...`) as the disposable per-request sandbox — see main.py.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
