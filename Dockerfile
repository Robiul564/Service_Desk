FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend backend
COPY frontend frontend

# Keep the SQLite file on a volume so data survives container restarts.
ENV DATABASE_URL=sqlite:////data/service_requests.db
VOLUME /data

WORKDIR /app/backend
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD python -c "import urllib.request, os; p=os.getenv('PORT','8000'); urllib.request.urlopen(f'http://localhost:{p}/api/health')"

CMD ["python", "run.py", "--host", "0.0.0.0"]
