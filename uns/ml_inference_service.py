"""
ML Inference Microservice
Listens to telemetry over MQTT and runs the machine learning models.
Currently implements real-time inference for A1 (Milling Machine).
"""
import os
import json
import logging
import time
import numpy as np
import paho.mqtt.client as mqtt
import joblib
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger("ml_inference")

MQTT_HOST = os.getenv("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MODEL_DIR = os.getenv("MODEL_DIR", "notebooks/models")

class A1Predictor:
    def __init__(self):
        log.info(f"Loading A1 model from {MODEL_DIR}/a1_classifier.joblib")
        try:
            bundle = joblib.load(f"{MODEL_DIR}/a1_classifier.joblib")
            self.model = bundle["model"]
            self.scaler = bundle["scaler"]
            self.type_encoder = bundle["type_encoder"]
        except Exception as e:
            log.error(f"Failed to load A1 model: {e}")
            self.model = None

        self.state = {
            "Type": "L",
            "AirTemp_K": 298.15,
            "ProcTemp_K": 308.15,
            "Speed_rpm": 1400.0,
            "Torque_Nm": 40.0,
            "ToolWear_min": 0.0
        }
        self.last_predict = 0.0

    def update(self, topic, value):
        topic_suffix = topic.split("A1/")[-1]
        if topic_suffix == "identification/type":
            self.state["Type"] = value
        elif topic_suffix == "process/air_temperature_k":
            self.state["AirTemp_K"] = float(value)
        elif topic_suffix == "process/process_temperature_k":
            self.state["ProcTemp_K"] = float(value)
        elif topic_suffix == "process/rotational_speed_rpm":
            self.state["Speed_rpm"] = float(value)
        elif topic_suffix == "process/torque_nm":
            self.state["Torque_Nm"] = float(value)
        elif topic_suffix == "process/tool_wear_min":
            self.state["ToolWear_min"] = float(value)
            
        # Predict every 1 second
        now = time.time()
        if now - self.last_predict >= 1.0:
            self.last_predict = now
            return self.predict()
        return None

    def predict(self):
        if not self.model:
            return None
        
        power_w = self.state["Torque_Nm"] * self.state["Speed_rpm"] * 2 * np.pi / 60
        delta_t_k = self.state["ProcTemp_K"] - self.state["AirTemp_K"]
        wear_torque = self.state["ToolWear_min"] * self.state["Torque_Nm"]
        type_enc = self.type_encoder.transform([[self.state["Type"]]])[0][0]
        
        # Order must match: AirTemp_K, ProcTemp_K, Speed_rpm, Torque_Nm, ToolWear_min, Power_W, DeltaT_K, WearTorque, Type_enc
        features = [
            self.state["AirTemp_K"],
            self.state["ProcTemp_K"],
            self.state["Speed_rpm"],
            self.state["Torque_Nm"],
            self.state["ToolWear_min"],
            power_w,
            delta_t_k,
            wear_torque,
            type_enc
        ]
        
        x = np.array([features])
        x_scaled = self.scaler.transform(x)
        pred = self.model.predict(x_scaled)[0]
        prob = self.model.predict_proba(x_scaled)[0][1]
        
        return {
            "machine_failure": int(pred),
            "failure_probability": float(prob)
        }

def on_connect(client, userdata, flags, rc, properties=None):
    log.info(f"Connected to MQTT Broker at {MQTT_HOST}:{MQTT_PORT} with code {rc}")
    client.subscribe("jesa/site1/workshop/milling/A1/#")

def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode())
        value = payload.get("v")
        if value is None: return
        
        a1_predictor = userdata["a1"]
        result = a1_predictor.update(msg.topic, value)
        
        if result is not None:
            out_topic = "jesa/site1/workshop/milling/A1/analytics/machine_failure"
            out_payload = json.dumps({
                "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "v": result["machine_failure"],
                "probability": result["failure_probability"]
            })
            client.publish(out_topic, out_payload, qos=0)
    except Exception as e:
        pass

def main():
    log.info("Starting ML Inference Service")
    a1_predictor = A1Predictor()
    
    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id="ml-inference-service",
        protocol=mqtt.MQTTv5,
        userdata={"a1": a1_predictor}
    )
    
    client.on_connect = on_connect
    client.on_message = on_message
    
    while True:
        try:
            client.connect(MQTT_HOST, MQTT_PORT, 60)
            break
        except ConnectionRefusedError:
            log.warning(f"Waiting for MQTT Broker at {MQTT_HOST}:{MQTT_PORT}...")
            time.sleep(5)
            
    client.loop_forever()

if __name__ == "__main__":
    main()
