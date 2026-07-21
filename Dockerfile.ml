FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install dependencies required by the ML inference service
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip
RUN pip install --no-cache-dir \
    paho-mqtt==2.1.0 \
    pandas==2.2.2 \
    numpy==1.26.4 \
    scipy==1.13.1 \
    scikit-learn==1.5.1 \
    xgboost==2.1.1 \
    imbalanced-learn==0.12.3 \
    joblib==1.4.2 \
    torch==2.3.1

# Copy source code and models
COPY uns/ ./uns/
COPY notebooks/models/ ./notebooks/models/

ENV PYTHONPATH=/app
ENV MQTT_HOST=mosquitto
ENV MQTT_PORT=1883
ENV MODEL_DIR=/app/notebooks/models

CMD ["python", "uns/ml_inference_service.py"]
