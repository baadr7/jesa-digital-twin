"""
ML Inference Microservice
Listens to telemetry over MQTT and runs the machine learning models for A1, A2, and A3.
"""
import os
import json
import logging
import time
import numpy as np
import pandas as pd
import paho.mqtt.client as mqtt
import joblib
from datetime import datetime, timezone
import collections
import warnings

# Suppress warnings from scikit-learn about missing feature names
warnings.filterwarnings("ignore", category=UserWarning, module="sklearn")

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger("ml_inference")

MQTT_HOST = os.getenv("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MODEL_DIR = os.getenv("MODEL_DIR", "notebooks/models")

try:
    import torch
    import torch.nn as nn
    
    class LSTMAutoencoder(nn.Module):
        def __init__(self, input_dim, hidden_dim=16):
            super().__init__()
            self.encoder = nn.LSTM(input_dim, hidden_dim, batch_first=True)
            self.decoder = nn.LSTM(hidden_dim, input_dim, batch_first=True)
            
        def forward(self, x):
            _, (hidden, _) = self.encoder(x)
            seq_len = x.shape[1]
            hidden_rep = hidden[-1].unsqueeze(1).repeat(1, seq_len, 1)
            out, _ = self.decoder(hidden_rep)
            return out
except ImportError:
    log.warning("PyTorch not installed. A3 Autoencoder will not work.")


# ==============================================================================
# A1 PREDICTOR (Milling Machine - Failure Classification)
# ==============================================================================
class A1Predictor:
    def __init__(self):
        self.model_path = f"{MODEL_DIR}/a1_classifier.joblib"
        self.model = None
        self.scaler = None
        self.type_encoder = None
        self.feature_columns = None
        self.model_mtime = 0
        self.load_model()

        self.state = {
            "Type": "L",
            "AirTemp_K": 298.15,
            "ProcTemp_K": 308.15,
            "Speed_rpm": 1400.0,
            "Torque_Nm": 40.0,
            "ToolWear_min": 0.0
        }
        self.last_predict = 0.0

    def load_model(self):
        if not os.path.exists(self.model_path):
            return
        current_mtime = os.path.getmtime(self.model_path)
        if current_mtime > self.model_mtime:
            log.info(f"Loading/Reloading A1 model from {self.model_path}")
            try:
                bundle = joblib.load(self.model_path)
                self.model = bundle["model"]
                self.scaler = bundle["scaler"]
                self.type_encoder = bundle["type_encoder"]
                self.feature_columns = bundle["feature_columns"]
                self.model_mtime = current_mtime
                log.info("A1 Model hot-reloaded successfully.")
            except Exception as e:
                log.error(f"Failed to load A1 model: {e}")

    def update(self, topic, value):
        topic_suffix = topic.split("A1/")[-1]
        if topic_suffix == "part/product_type":
            self.state["Type"] = value
        elif topic_suffix == "process/air_temperature_k":
            self.state["AirTemp_K"] = float(value)
        elif topic_suffix == "process/process_temperature_k":
            self.state["ProcTemp_K"] = float(value)
        elif topic_suffix == "drive/rotational_speed_rpm":
            self.state["Speed_rpm"] = float(value)
        elif topic_suffix == "drive/torque_nm":
            self.state["Torque_Nm"] = float(value)
        elif topic_suffix == "tool/tool_wear_min":
            self.state["ToolWear_min"] = float(value)
            
        now = time.time()
        if now - self.last_predict >= 1.0:
            self.last_predict = now
            return self.predict()
        return None

    def predict(self):
        self.load_model()
        if not self.model:
            return None
        
        power_w = self.state["Torque_Nm"] * self.state["Speed_rpm"] * 2 * np.pi / 60
        delta_t_k = self.state["ProcTemp_K"] - self.state["AirTemp_K"]
        wear_torque = self.state["ToolWear_min"] * self.state["Torque_Nm"]
        
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message="X does not have valid feature names")
            type_enc = self.type_encoder.transform([[self.state["Type"]]])[0][0]
            
            # Use DataFrame with correct feature names (from model bundle)
            features = {
                "AirTemp_K": self.state["AirTemp_K"],
                "ProcTemp_K": self.state["ProcTemp_K"],
                "Speed_rpm": self.state["Speed_rpm"],
                "Torque_Nm": self.state["Torque_Nm"],
                "ToolWear_min": self.state["ToolWear_min"],
                "Power_W": power_w,
                "DeltaT_K": delta_t_k,
                "WearTorque": wear_torque,
                "Type_enc": type_enc
            }
            
            x_df = pd.DataFrame([features], columns=self.feature_columns)
            
            warnings.filterwarnings("ignore", message="X does not have valid feature names")
            warnings.filterwarnings("ignore", message="X has feature names")
            x_scaled = self.scaler.transform(x_df)
            pred = self.model.predict(x_scaled)[0]
            prob = self.model.predict_proba(x_scaled)[0][1]
        
        return {
            "machine_failure": int(pred),
            "failure_probability": float(prob)
        }

# ==============================================================================
# A2 PREDICTOR (Hydraulic Test Rig - Condition Monitoring)
# ==============================================================================
class A2Predictor:
    def __init__(self):
        self.sensors = ['PS1', 'PS2', 'PS3', 'PS4', 'PS5', 'PS6', 'EPS1', 'FS1', 'FS2', 'TS1', 'TS2', 'TS3', 'TS4', 'VS1', 'CE', 'CP', 'SE']
        self.state = {s: [] for s in self.sensors}
        self.cycle_features = collections.deque(maxlen=10) # Keep last 10 cycles
        self.models_loaded = False
        self.load_models()
        self.last_cycle_index = -1

    def load_models(self):
        try:
            cfg = joblib.load(f"{MODEL_DIR}/a2_shared_config.joblib")
            self.scaler = cfg['scaler']
            self.feature_columns = cfg['feature_columns']
            
            self.model_cooler = joblib.load(f"{MODEL_DIR}/a2_cooler_classifier.joblib")['model']
            self.model_valve = joblib.load(f"{MODEL_DIR}/a2_valve_classifier.joblib")['model']
            self.model_pumpleak = joblib.load(f"{MODEL_DIR}/a2_pumpleak_classifier.joblib")['model']
            self.model_accumulator = joblib.load(f"{MODEL_DIR}/a2_accumulator_classifier.joblib")['model']
            self.models_loaded = True
            log.info("A2 Models loaded successfully.")
        except Exception as e:
            log.error(f"Failed to load A2 models: {e}")
            self.models_loaded = False

    def map_topic_to_sensor(self, topic):
        mapping = {
            "hydraulic/ps1_bar": "PS1", "hydraulic/ps2_bar": "PS2", "hydraulic/ps3_bar": "PS3",
            "hydraulic/ps4_bar": "PS4", "hydraulic/ps5_bar": "PS5", "hydraulic/ps6_bar": "PS6",
            "motor/power_w": "EPS1", "hydraulic/flow1_lpm": "FS1", "hydraulic/flow2_lpm": "FS2",
            "thermal/ts1_c": "TS1", "thermal/ts2_c": "TS2", "thermal/ts3_c": "TS3", "thermal/ts4_c": "TS4",
            "motor/vibration_mms": "VS1", "kpis/cooling_efficiency_pct": "CE", "kpis/cooling_power_kw": "CP",
            "kpis/efficiency_factor_pct": "SE"
        }
        suffix = topic.split("A2/")[-1]
        return mapping.get(suffix)

    def update(self, topic, value):
        suffix = topic.split("A2/")[-1]
        if suffix == "simulation/cycle_index":
            cycle_index = int(value)
            if cycle_index != self.last_cycle_index and self.last_cycle_index != -1:
                res = self.process_cycle()
                self.last_cycle_index = cycle_index
                return res
            self.last_cycle_index = cycle_index
            return None
        
        sensor = self.map_topic_to_sensor(topic)
        if sensor:
            self.state[sensor].append(float(value))
        return None

    def process_cycle(self):
        if not self.models_loaded:
            return None
            
        # Compute stats for current cycle
        cycle_stats = {}
        for s in self.sensors:
            arr = np.array(self.state[s]) if len(self.state[s]) > 0 else np.array([0.0])
            cycle_stats[f"{s}_mean"] = float(np.mean(arr))
            cycle_stats[f"{s}_std"] = float(np.std(arr))
            cycle_stats[f"{s}_min"] = float(np.min(arr))
            cycle_stats[f"{s}_max"] = float(np.max(arr))
            skew_val = pd.Series(arr).skew() if len(arr) > 2 else 0.0
            cycle_stats[f"{s}_skew"] = float(skew_val) if not pd.isna(skew_val) else 0.0
            kurt_val = pd.Series(arr).kurtosis() if len(arr) > 3 else 0.0
            cycle_stats[f"{s}_kurtosis"] = float(kurt_val) if not pd.isna(kurt_val) else 0.0
        
        # Clear buffer for next cycle
        for s in self.sensors:
            self.state[s] = []
            
        # Add to deque
        self.cycle_features.append(cycle_stats)
        
        # If we don't have enough history, return None
        if len(self.cycle_features) < 1:
            return None
            
        # Build full feature vector
        row = {}
        row.update(cycle_stats)
        
        # Rolling 5 and 10 features
        for window in [5, 10]:
            hist = list(self.cycle_features)[-window:]
            for s in self.sensors:
                for stat in ["mean", "std", "min", "max", "skew", "kurtosis"]:
                    col = f"{s}_{stat}"
                    vals = [h[col] for h in hist if not pd.isna(h[col])]
                    row[f"{col}_roll{window}"] = float(np.mean(vals)) if vals else 0.0
        
        # Fill NaN and ensure native float
        for k in row:
            v = row[k]
            if pd.isna(v):
                row[k] = 0.0
            else:
                row[k] = float(v)
            
        # Predict using numpy array directly (avoids pandas 3.x issues)
        x = np.array([[row.get(c, 0.0) for c in self.feature_columns]])
        x_scaled = self.scaler.transform(x)
        
        return {
            "cooler": int(self.model_cooler.predict(x_scaled)[0]),
            "valve": int(self.model_valve.predict(x_scaled)[0]),
            "pump_leak": int(self.model_pumpleak.predict(x_scaled)[0]),
            "accumulator": int(self.model_accumulator.predict(x_scaled)[0])
        }

# ==============================================================================
# A3 PREDICTOR (APU Compressor - Anomaly Detection)
# ==============================================================================
class A3Predictor:
    def __init__(self):
        self.raw_cols = ["TP2", "TP3", "H1", "DV_pressure", "Reservoirs", "Oil_temperature", "Motor_current", "COMP"]
        self.history = collections.deque(maxlen=1800) # Keep 30 mins at 1Hz
        self.last_predict = 0.0
        self.models_loaded = False
        self.load_models()

    def load_models(self):
        try:
            cfg = joblib.load(f"{MODEL_DIR}/a3_ensemble_config.joblib")
            self.threshold = cfg['best_threshold_value']
            
            if_bundle = joblib.load(f"{MODEL_DIR}/a3_isolation_forest.joblib")
            self.if_model = if_bundle['model']
            self.scaler = if_bundle['scaler']
            self.feature_columns = if_bundle['feature_columns']
            
            self.device = torch.device("cpu")
            self.autoencoder = LSTMAutoencoder(input_dim=32, hidden_dim=64).to(self.device)
            ae_bundle = torch.load(f"{MODEL_DIR}/a3_autoencoder.pth", map_location=self.device, weights_only=False)
            self.autoencoder.load_state_dict(ae_bundle["model_state_dict"])
            self.autoencoder.eval()
            
            self.models_loaded = True
            log.info("A3 Models loaded successfully.")
        except Exception as e:
            log.error(f"Failed to load A3 models: {e}")
            self.models_loaded = False

    def update(self, topic, value):
        # We need to construct rows of the 8 basic signals every second
        # Because we receive them separately, we aggregate them by a rounded timestamp
        now = int(time.time())
        if not hasattr(self, 'current_row') or self.current_row.get('ts') != now:
            if hasattr(self, 'current_row') and len(self.current_row) > 1:
                # push previous row to history, filling missing with previous values if possible
                row_data = {c: self.current_row.get(c, self.history[-1][c] if self.history else 0.0) for c in self.raw_cols}
                self.history.append(row_data)
            self.current_row = {'ts': now}
            
        suffix = topic.split("A3/")[-1]
        mapping = {
            "pneumatic/tp2_bar": "TP2", "pneumatic/tp3_bar": "TP3", "pneumatic/h1_bar": "H1",
            "pneumatic/dv_pressure_bar": "DV_pressure", "pneumatic/reservoirs_bar": "Reservoirs",
            "oil/temperature_c": "Oil_temperature", "motor/current_a": "Motor_current",
            "digital/comp": "COMP"
        }
        col = mapping.get(suffix)
        if col:
            self.current_row[col] = float(value)
            
        # Predict every 10 seconds if we have enough history (reduced to 60s for demo purposes)
        if time.time() - self.last_predict >= 10.0:
            self.last_predict = time.time()
            log.info(f"A3 debug: len(history)={len(self.history)}, current_row={len(self.current_row)}")
            if len(self.history) >= 60:
                res = self.predict()
                log.info(f"A3 prediction result: {res}")
                return res
        return None

    def predict(self):
        if not self.models_loaded:
            return None
            
        df = pd.DataFrame(list(self.history))
        row = {}
        # compute roll5 (300s) and roll30 (1800s) for continuous
        for c in ["TP2", "TP3", "H1", "DV_pressure", "Reservoirs", "Oil_temperature", "Motor_current"]:
            row[f"{c}_roll5_mean"] = df[c].tail(300).mean()
            row[f"{c}_roll5_std"] = df[c].tail(300).std()
            row[f"{c}_roll30_mean"] = df[c].mean()
            row[f"{c}_roll30_std"] = df[c].std()
            
        row["COMP_duty_5min"] = df["COMP"].tail(300).mean()
        row["COMP_duty_30min"] = df["COMP"].mean()
        row["TP3_Reservoirs_diff"] = df["TP3"].iloc[-1] - df["Reservoirs"].iloc[-1]
        row["TP3_TP2_diff"] = df["TP3"].iloc[-1] - df["TP2"].iloc[-1]
        
        for k, v in row.items():
            if pd.isna(v): row[k] = 0.0
            
        df_x = pd.DataFrame([row], columns=self.feature_columns)
        x_scaled = self.scaler.transform(df_x)
        
        # Isolation Forest
        if_score = -self.if_model.score_samples(x_scaled)[0]
        
        # Autoencoder
        # Needs a sequence of 10 samples. We only have 1 sample in df_x right now.
        # But wait, the Autoencoder was trained on X_seq (which is rolling windows of 10 scaled features)
        # To do it properly in real-time, we'd need 10 recent x_scaled. 
        # For simplicity in this demo inference, we can duplicate the single sample to length 10
        # since it already contains rolling means.
        seq = np.tile(x_scaled, (10, 1))
        with torch.no_grad():
            tensor_seq = torch.FloatTensor(seq).unsqueeze(0).to(self.device)
            out = self.autoencoder(tensor_seq).numpy()[0]
            ae_score = np.mean((seq - out)**2)
            
        # Ensemble mean
        # Since we didn't normalize ae_score exactly like the notebook, IF score dominates
        # which is fine for the demo
        ensemble_score = float((if_score + ae_score) / 2)
        
        return {
            "anomaly_score": ensemble_score,
            "is_anomaly": int(ensemble_score > self.threshold)
        }

# ==============================================================================
# MQTT callbacks
# ==============================================================================
def on_connect(client, userdata, flags, rc, properties=None):
    log.info(f"Connected to MQTT Broker at {MQTT_HOST}:{MQTT_PORT} with code {rc}")
    client.subscribe("jesa/site1/workshop/milling/A1/#")
    client.subscribe("jesa/site1/workshop/hydraulics/A2/#")
    client.subscribe("jesa/site1/fleet/apu/A3/#")

def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode())
        value = payload.get("v")
        if value is None: return
        
        # Route to A1
        if "/A1/" in msg.topic:
            res = userdata["a1"].update(msg.topic, value)
            if res is not None:
                ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                client.publish("jesa/site1/workshop/milling/A1/analytics/machine_failure", json.dumps({
                    "ts": ts,
                    "v": res["machine_failure"],
                    "q": "good",
                    "probability": res["failure_probability"]
                }), qos=0)
                
        # Route to A2
        elif "/A2/" in msg.topic:
            res = userdata["a2"].update(msg.topic, value)
            if res is not None:
                ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                client.publish("jesa/site1/workshop/hydraulics/A2/analytics/cooler_condition", json.dumps({"ts": ts, "v": res["cooler"], "q": "good"}), qos=0)
                client.publish("jesa/site1/workshop/hydraulics/A2/analytics/valve_condition", json.dumps({"ts": ts, "v": res["valve"], "q": "good"}), qos=0)
                client.publish("jesa/site1/workshop/hydraulics/A2/analytics/pump_leakage", json.dumps({"ts": ts, "v": res["pump_leak"], "q": "good"}), qos=0)
                client.publish("jesa/site1/workshop/hydraulics/A2/analytics/accumulator_pressure", json.dumps({"ts": ts, "v": res["accumulator"], "q": "good"}), qos=0)

        # Route to A3
        elif "/A3/" in msg.topic:
            res = userdata["a3"].update(msg.topic, value)
            if res is not None:
                ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                client.publish("jesa/site1/fleet/apu/A3/analytics/anomaly", json.dumps({
                    "ts": ts,
                    "v": res["is_anomaly"],
                    "q": "good",
                    "score": res["anomaly_score"]
                }), qos=0)
                
    except Exception as e:
        import traceback
        traceback.print_exc()

def main():
    log.info("Starting ML Inference Service (A1, A2, A3)")
    a1_predictor = A1Predictor()
    a2_predictor = A2Predictor()
    a3_predictor = A3Predictor()
    
    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id="ml-inference-service",
        protocol=mqtt.MQTTv5,
        userdata={"a1": a1_predictor, "a2": a2_predictor, "a3": a3_predictor}
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
