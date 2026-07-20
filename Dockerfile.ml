FROM python:3.11-slim

WORKDIR /app

# Install dependencies required by the ML inference service
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir paho-mqtt scikit-learn xgboost pandas numpy torch joblib

# Copy source code and models
COPY uns/ ./uns/
COPY notebooks/models/ ./notebooks/models/

ENV PYTHONPATH=/app
ENV MQTT_HOST=mosquitto
ENV MQTT_PORT=1883
ENV MODEL_DIR=/app/notebooks/models

CMD ["python", "uns/ml_inference_service.py"]
