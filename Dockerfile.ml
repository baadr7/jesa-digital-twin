FROM python:3.11

WORKDIR /app

# Install dependencies required by the ML inference service
COPY requirements.txt .
RUN pip install --no-cache-dir paho-mqtt pandas==3.0.3 numpy==2.4.6 scipy==1.17.1
RUN pip install --no-cache-dir scikit-learn==1.9.0 xgboost==3.2.0 imbalanced-learn==0.14.2 joblib==1.5.3
RUN pip install --no-cache-dir torch==2.13.0

# Copy source code and models
COPY uns/ ./uns/
COPY notebooks/models/ ./notebooks/models/

ENV PYTHONPATH=/app
ENV MQTT_HOST=mosquitto
ENV MQTT_PORT=1883
ENV MODEL_DIR=/app/notebooks/models

CMD ["python", "uns/ml_inference_service.py"]
