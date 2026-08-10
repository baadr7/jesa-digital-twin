FROM python:3.11.9-slim-bookworm

WORKDIR /app

# Prevent .pyc files being written to bind-mounted paths (WSL2 corrupts them)
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app
ENV PIP_NO_CACHE_DIR=1
# Redirect any residual pycache to tmpfs to avoid overlay-fs corruption
ENV PYTHONPYCACHEPREFIX=/tmp/pycache

COPY requirements.ml.txt ./requirements.ml.txt

RUN pip install -r requirements.ml.txt && \
    find /usr/local/lib/python3.11 -name "*.pyc" -delete && \
    find /usr/local/lib/python3.11 -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

COPY uns/__init__.py             ./uns/__init__.py
COPY uns/__main__.py             ./uns/__main__.py
COPY uns/config.py               ./uns/config.py
COPY uns/ml_inference_service.py ./uns/ml_inference_service.py

ENV MQTT_HOST=mosquitto
ENV MQTT_PORT=1883
ENV MODEL_DIR=/app/notebooks/models

CMD ["python", "-B", "uns/ml_inference_service.py"]
