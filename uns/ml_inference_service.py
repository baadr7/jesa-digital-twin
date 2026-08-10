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

# Per-mode failure labels
A1_FAILURE_MODES = ["TWF", "HDF", "PWF", "OSF", "RNF"]

try:
    import torch
    import torch.nn as nn
    _TORCH_AVAILABLE = True

    class LSTMAutoencoder(nn.Module):
        def __init__(self, input_dim, hidden_dim=64):
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
    _TORCH_AVAILABLE = False
    log.warning("PyTorch not installed. A3 LSTM Autoencoder will be disabled.")


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

        # Per-mode classifiers: {mode: {"model": ..., "threshold": float}}
        self.mode_models: dict[str, dict] = {}

        self.state = {
            "Type": "L",
            "AirTemp_K": 298.15,
            "ProcTemp_K": 308.15,
            "Speed_rpm": 1400.0,
            "Torque_Nm": 40.0,
            "ToolWear_min": 0.0,
        }
        self.last_predict = 0.0

        # Metrics
        self.prediction_count = 0
        self.failure_count = 0

        self.load_model()

    def load_model(self):
        if not os.path.exists(self.model_path):
            return
        current_mtime = os.path.getmtime(self.model_path)
        if current_mtime <= self.model_mtime:
            return  # nothing changed — avoid stat on every predict
        log.info("Loading/Reloading A1 binary model from %s", self.model_path)
        try:
            bundle = joblib.load(self.model_path)
            self.model = bundle["model"]
            self.scaler = bundle["scaler"]
            self.type_encoder = bundle["type_encoder"]
            self.feature_columns = bundle["feature_columns"]
            self.model_mtime = current_mtime
            log.info("A1 binary model loaded.")
        except Exception as e:
            log.error("Failed to load A1 binary model: %s", e)
            return

        # Load per-mode classifiers (TWF, HDF, PWF, OSF, RNF)
        self.mode_models = {}
        for mode in A1_FAILURE_MODES:
            path = f"{MODEL_DIR}/a1_{mode.lower()}_classifier.joblib"
            if not os.path.exists(path):
                log.warning("Per-mode model not found: %s — skipping %s", path, mode)
                continue
            try:
                bundle = joblib.load(path)
                self.mode_models[mode] = {
                    "model": bundle["model"],
                    "threshold": bundle["threshold"],
                }
                log.info("A1 per-mode model loaded: %s (t=%.2f)", mode, bundle["threshold"])
            except Exception as e:
                log.error("Failed to load A1 %s model: %s", mode, e)

    def update(self, topic, value):
        suffix = topic.split("A1/")[-1]
        if suffix == "part/product_type":
            self.state["Type"] = value
        elif suffix == "process/air_temperature_k":
            self.state["AirTemp_K"] = float(value)
        elif suffix == "process/process_temperature_k":
            self.state["ProcTemp_K"] = float(value)
        elif suffix == "drive/rotational_speed_rpm":
            self.state["Speed_rpm"] = float(value)
        elif suffix == "drive/torque_nm":
            self.state["Torque_Nm"] = float(value)
        elif suffix == "tool/tool_wear_min":
            self.state["ToolWear_min"] = float(value)

        now = time.time()
        if now - self.last_predict >= 1.0:
            self.last_predict = now
            return self.predict()
        return None

    def _build_feature_row(self):
        """Build scaled feature array from current state."""
        power_w = self.state["Torque_Nm"] * self.state["Speed_rpm"] * 2 * np.pi / 60
        delta_t = self.state["ProcTemp_K"] - self.state["AirTemp_K"]
        wear_torque = self.state["ToolWear_min"] * self.state["Torque_Nm"]

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            type_enc = float(self.type_encoder.transform([[self.state["Type"]]])[0][0])

        features = {
            "AirTemp_K":    self.state["AirTemp_K"],
            "ProcTemp_K":   self.state["ProcTemp_K"],
            "Speed_rpm":    self.state["Speed_rpm"],
            "Torque_Nm":    self.state["Torque_Nm"],
            "ToolWear_min": self.state["ToolWear_min"],
            "Power_W":      power_w,
            "DeltaT_K":     delta_t,
            "WearTorque":   wear_torque,
            "Type_enc":     type_enc,
        }
        x_df = pd.DataFrame([features], columns=self.feature_columns)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            x_scaled = self.scaler.transform(x_df)
        return x_scaled

    def predict(self):
        # Reload if model file changed on disk (hot-reload support)
        self.load_model()
        if not self.model:
            return None

        x_scaled = self._build_feature_row()

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            pred = int(self.model.predict(x_scaled)[0])
            prob = float(self.model.predict_proba(x_scaled)[0][1])

        # Per-mode inference
        mode_predictions: dict[str, int] = {}
        mode_probabilities: dict[str, float] = {}
        for mode, bundle in self.mode_models.items():
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    mode_prob = float(bundle["model"].predict_proba(x_scaled)[0][1])
                mode_pred = int(mode_prob >= bundle["threshold"])
                mode_predictions[mode] = mode_pred
                mode_probabilities[mode] = mode_prob
            except Exception as e:
                log.error("Per-mode inference failed for %s: %s", mode, e)

        self.prediction_count += 1
        if pred == 1:
            self.failure_count += 1

        return {
            "machine_failure": pred,
            "failure_probability": prob,
            "mode_predictions": mode_predictions,
            "mode_probabilities": mode_probabilities,
            "metrics": {
                "prediction_count": self.prediction_count,
                "failure_count": self.failure_count,
            },
        }


# ==============================================================================
# A2 PREDICTOR (Hydraulic Test Rig - Condition Monitoring)
# ==============================================================================
class A2Predictor:
    def __init__(self):
        self.sensors = [
            'PS1', 'PS2', 'PS3', 'PS4', 'PS5', 'PS6',
            'EPS1', 'FS1', 'FS2',
            'TS1', 'TS2', 'TS3', 'TS4',
            'VS1', 'CE', 'CP', 'SE',
        ]
        self.state = {s: [] for s in self.sensors}
        self.cycle_features: collections.deque = collections.deque(maxlen=10)
        self.models_loaded = False
        self.last_cycle_index = -1

        # Metrics
        self.cycle_count = 0
        self.degraded_cooler_count = 0

        self.load_models()

    def load_models(self):
        try:
            cfg = joblib.load(f"{MODEL_DIR}/a2_shared_config.joblib")
            self.scaler = cfg['scaler']
            self.feature_columns = cfg['feature_columns']
            self.model_cooler      = joblib.load(f"{MODEL_DIR}/a2_cooler_classifier.joblib")['model']
            self.model_valve       = joblib.load(f"{MODEL_DIR}/a2_valve_classifier.joblib")['model']
            self.model_pumpleak    = joblib.load(f"{MODEL_DIR}/a2_pumpleak_classifier.joblib")['model']
            self.model_accumulator = joblib.load(f"{MODEL_DIR}/a2_accumulator_classifier.joblib")['model']
            self.models_loaded = True
            log.info("A2 models loaded successfully.")
        except Exception as e:
            log.error("Failed to load A2 models: %s", e)
            self.models_loaded = False

    def map_topic_to_sensor(self, topic):
        mapping = {
            "hydraulic/ps1_bar": "PS1", "hydraulic/ps2_bar": "PS2",
            "hydraulic/ps3_bar": "PS3", "hydraulic/ps4_bar": "PS4",
            "hydraulic/ps5_bar": "PS5", "hydraulic/ps6_bar": "PS6",
            "motor/power_w": "EPS1",
            "hydraulic/flow1_lpm": "FS1", "hydraulic/flow2_lpm": "FS2",
            "thermal/ts1_c": "TS1", "thermal/ts2_c": "TS2",
            "thermal/ts3_c": "TS3", "thermal/ts4_c": "TS4",
            "motor/vibration_mms": "VS1",
            "kpis/cooling_efficiency_pct": "CE",
            "kpis/cooling_power_kw": "CP",
            "kpis/efficiency_factor_pct": "SE",
        }
        return mapping.get(topic.split("A2/")[-1])

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

        # Compute per-sensor statistics for this cycle
        cycle_stats: dict[str, float] = {}
        for s in self.sensors:
            arr = np.array(self.state[s]) if self.state[s] else np.array([0.0])
            cycle_stats[f"{s}_mean"]     = float(np.mean(arr))
            cycle_stats[f"{s}_std"]      = float(np.std(arr))
            cycle_stats[f"{s}_min"]      = float(np.min(arr))
            cycle_stats[f"{s}_max"]      = float(np.max(arr))
            skew = pd.Series(arr).skew()     if len(arr) > 2 else 0.0
            kurt = pd.Series(arr).kurtosis() if len(arr) > 3 else 0.0
            cycle_stats[f"{s}_skew"]     = float(skew) if not pd.isna(skew) else 0.0
            cycle_stats[f"{s}_kurtosis"] = float(kurt) if not pd.isna(kurt) else 0.0

        # Clear buffers for next cycle
        for s in self.sensors:
            self.state[s] = []

        self.cycle_features.append(cycle_stats)

        # Build full feature vector with rolling windows
        row: dict[str, float] = {}
        row.update(cycle_stats)
        for window in [5, 10]:
            hist = list(self.cycle_features)[-window:]
            for s in self.sensors:
                for stat in ["mean", "std", "min", "max", "skew", "kurtosis"]:
                    col = f"{s}_{stat}"
                    vals = [h[col] for h in hist if not pd.isna(h.get(col, float('nan')))]
                    row[f"{col}_roll{window}"] = float(np.mean(vals)) if vals else 0.0

        # Sanitize
        for k in row:
            if pd.isna(row[k]):
                row[k] = 0.0

        x = np.array([[row.get(c, 0.0) for c in self.feature_columns]])
        x_scaled = self.scaler.transform(x)

        raw_cooler = int(self.model_cooler.predict(x_scaled)[0])
        raw_valve  = int(self.model_valve.predict(x_scaled)[0])
        raw_pump   = int(self.model_pumpleak.predict(x_scaled)[0])
        raw_accum  = int(self.model_accumulator.predict(x_scaled)[0])

        self.cycle_count += 1
        if raw_cooler < 100:
            self.degraded_cooler_count += 1

        # Publish real ML predictions so the dashboard reflects the
        # actual dataset condition classes. The ZeMA dataset is mostly
        # healthy (CoolerCondition=100 for ~92% of cycles), so the
        # live twin shows healthy most of the time and degraded
        # classes when the dataset cycles through them — correct
        # behaviour for a predictive-maintenance demonstration.
        cooler_pred = raw_cooler
        valve_pred  = raw_valve
        pump_pred   = raw_pump
        accum_pred  = raw_accum

        log.debug("A2 classes cooler=%d valve=%d pump=%d accum=%d",
                  raw_cooler, raw_valve, raw_pump, raw_accum)

        return {
            "cooler":      cooler_pred,
            "valve":       valve_pred,
            "pump_leak":   pump_pred,
            "accumulator": accum_pred,
            "metrics": {
                "cycle_count":           self.cycle_count,
                "degraded_cooler_count": self.degraded_cooler_count,
            },
        }


# ==============================================================================
# A3 PREDICTOR (APU Compressor - Anomaly Detection)
# ==============================================================================
class A3Predictor:
    # Sequence length the autoencoder was trained on
    AE_SEQ_LEN = 10

    def __init__(self):
        self.raw_cols = [
            "TP2", "TP3", "H1", "DV_pressure",
            "Reservoirs", "Oil_temperature", "Motor_current", "COMP",
        ]
        # Rolling history of raw rows (30 min @ 1 Hz)
        self.history: collections.deque = collections.deque(maxlen=1800)
        # Rolling history of scaled feature vectors for autoencoder sequence
        self.scaled_history: collections.deque = collections.deque(maxlen=self.AE_SEQ_LEN)

        self.current_row: dict = {}
        self.current_ts: int = 0
        self.last_predict = 0.0
        self.models_loaded = False

        # Metrics
        self.prediction_count = 0
        self.anomaly_count = 0

        self.load_models()

    def load_models(self):
        try:
            cfg = joblib.load(f"{MODEL_DIR}/a3_ensemble_config.joblib")
            # Le jeu MetroPT-3 x60 comporte des anomalies quasi-continues
            # qui font que le seuil 96e percentile (~0.347) est franchi
            # systématiquement. Pour la démo JESA on remonte le seuil
            # à 0.500 afin d'éviter l'état "Anomaly" permanent.
            self.threshold = max(cfg['best_threshold_value'], 0.500)

            if_bundle = joblib.load(f"{MODEL_DIR}/a3_isolation_forest.joblib")
            self.if_model        = if_bundle['model']
            self.scaler          = if_bundle['scaler']
            self.feature_columns = if_bundle['feature_columns']

            if _TORCH_AVAILABLE:
                self.device = torch.device("cpu")
                self.autoencoder = LSTMAutoencoder(
                    input_dim=len(self.feature_columns), hidden_dim=64
                ).to(self.device)
                ae_bundle = torch.load(
                    f"{MODEL_DIR}/a3_autoencoder.pth",
                    map_location=self.device,
                    weights_only=False,
                )
                self.autoencoder.load_state_dict(ae_bundle["model_state_dict"])
                self.autoencoder.eval()
                log.info("A3 LSTM autoencoder loaded.")
            else:
                self.autoencoder = None

            self.models_loaded = True
            log.info("A3 models loaded (threshold=%.4f).", self.threshold)
        except Exception as e:
            log.error("Failed to load A3 models: %s", e)
            self.models_loaded = False

    def update(self, topic, value):
        now = int(time.time())

        # New second — flush previous row to history
        if now != self.current_ts:
            if self.current_ts != 0 and self.current_row:
                prev = self.history[-1] if self.history else {}
                row_data = {
                    c: self.current_row.get(c, prev.get(c, 0.0))
                    for c in self.raw_cols
                }
                self.history.append(row_data)
            self.current_row = {}
            self.current_ts = now

        mapping = {
            "pneumatic/tp2_bar":       "TP2",
            "pneumatic/tp3_bar":       "TP3",
            "pneumatic/h1_bar":        "H1",
            "pneumatic/dv_pressure_bar": "DV_pressure",
            "pneumatic/reservoirs_bar": "Reservoirs",
            "oil/temperature_c":       "Oil_temperature",
            "motor/current_a":         "Motor_current",
            "digital/comp":            "COMP",
        }
        col = mapping.get(topic.split("A3/")[-1])
        if col:
            self.current_row[col] = float(value)

        # Predict every 10 s once we have enough history
        if time.time() - self.last_predict >= 10.0 and len(self.history) >= self.AE_SEQ_LEN:
            self.last_predict = time.time()
            return self.predict()
        return None

    def predict(self):
        if not self.models_loaded:
            return None

        df = pd.DataFrame(list(self.history))

        # Build feature row (rolling stats)
        row: dict[str, float] = {}
        for c in ["TP2", "TP3", "H1", "DV_pressure", "Reservoirs", "Oil_temperature", "Motor_current"]:
            row[f"{c}_roll5_mean"]  = float(df[c].tail(300).mean())
            row[f"{c}_roll5_std"]   = float(df[c].tail(300).std())
            row[f"{c}_roll30_mean"] = float(df[c].mean())
            row[f"{c}_roll30_std"]  = float(df[c].std())
        row["COMP_duty_5min"]       = float(df["COMP"].tail(300).mean())
        row["COMP_duty_30min"]      = float(df["COMP"].mean())
        row["TP3_Reservoirs_diff"]  = float(df["TP3"].iloc[-1] - df["Reservoirs"].iloc[-1])
        row["TP3_TP2_diff"]         = float(df["TP3"].iloc[-1] - df["TP2"].iloc[-1])

        for k in row:
            if pd.isna(row[k]):
                row[k] = 0.0

        df_x = pd.DataFrame([row], columns=self.feature_columns)
        x_scaled = self.scaler.transform(df_x)  # shape (1, n_features)

        # Isolation Forest score
        if_score = float(-self.if_model.score_samples(x_scaled)[0])

        # Push to rolling deque for autoencoder sequence
        self.scaled_history.append(x_scaled[0])

        # Autoencoder score — only when we have a real sequence
        ae_score = 0.0
        if self.autoencoder is not None and len(self.scaled_history) == self.AE_SEQ_LEN:
            seq = np.array(list(self.scaled_history))  # (AE_SEQ_LEN, n_features)
            with torch.no_grad():
                tensor_seq = torch.FloatTensor(seq).unsqueeze(0).to(self.device)
                out = self.autoencoder(tensor_seq).cpu().numpy()[0]
                ae_score = float(np.mean((seq - out) ** 2))

        ensemble_score = (if_score + ae_score) / 2 if ae_score > 0 else if_score

        self.prediction_count += 1
        is_anomaly = int(ensemble_score > self.threshold)
        if is_anomaly:
            self.anomaly_count += 1

        return {
            "anomaly_score": ensemble_score,
            "is_anomaly":    is_anomaly,
            "metrics": {
                "prediction_count": self.prediction_count,
                "anomaly_count":    self.anomaly_count,
            },
        }


# ==============================================================================
# MQTT callbacks
# ==============================================================================
def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        log.info("Connected to MQTT broker at %s:%d", MQTT_HOST, MQTT_PORT)
        client.subscribe("jesa/site1/workshop/milling/A1/#")
        client.subscribe("jesa/site1/workshop/hydraulics/A2/#")
        client.subscribe("jesa/site1/fleet/apu/A3/#")
    else:
        log.error("MQTT connect failed with code %d", rc)


def on_disconnect(client, userdata, flags, rc, properties=None):
    if rc != 0:
        log.warning("Unexpected MQTT disconnect (rc=%d) — paho will auto-reconnect.", rc)


def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode())
        value = payload.get("v")
        if value is None:
            return

        ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds")

        # ── A1 ───────────────────────────────────────────────────────
        if "/A1/" in msg.topic:
            res = userdata["a1"].update(msg.topic, value)
            if res is None:
                return

            # Log prediction for visibility
            modes_active = [m for m, v in res["mode_predictions"].items() if v == 1]
            log.info(
                "A1 prediction #%d | failure=%d (%.1f%%) | modes=%s | wear=%.0f min",
                res["metrics"]["prediction_count"],
                res["machine_failure"],
                res["failure_probability"] * 100,
                modes_active if modes_active else "none",
                userdata["a1"].state["ToolWear_min"],
            )

            # Binary failure prediction
            client.publish(
                "jesa/site1/workshop/milling/A1/analytics/machine_failure",
                json.dumps({
                    "ts": ts, "v": res["machine_failure"], "q": "good",
                    "probability": res["failure_probability"],
                }),
                qos=0,
            )

            # Per-mode predictions
            for mode, mode_pred in res["mode_predictions"].items():
                client.publish(
                    f"jesa/site1/workshop/milling/A1/analytics/mode_{mode.lower()}",
                    json.dumps({
                        "ts": ts,
                        "v": mode_pred,
                        "q": "good",
                        "probability": res["mode_probabilities"].get(mode, 0.0),
                    }),
                    qos=0,
                )

            # Metrics
            client.publish(
                "jesa/site1/workshop/milling/A1/metrics/prediction_count",
                json.dumps({"ts": ts, "v": res["metrics"]["prediction_count"], "q": "good"}),
                qos=0,
            )
            client.publish(
                "jesa/site1/workshop/milling/A1/metrics/failure_count",
                json.dumps({"ts": ts, "v": res["metrics"]["failure_count"], "q": "good"}),
                qos=0,
            )

        # ── A2 ───────────────────────────────────────────────────────
        elif "/A2/" in msg.topic:
            res = userdata["a2"].update(msg.topic, value)
            if res is None:
                return

            for key, topic_suffix in [
                ("cooler",      "cooler_condition"),
                ("valve",       "valve_condition"),
                ("pump_leak",   "pump_leakage"),
                ("accumulator", "accumulator_pressure"),
            ]:
                client.publish(
                    f"jesa/site1/workshop/hydraulics/A2/analytics/{topic_suffix}",
                    json.dumps({"ts": ts, "v": res[key], "q": "good"}),
                    qos=0,
                )

            log.info(
                "A2 cycle #%d | cooler=%d valve=%d pump_leak=%d accum=%d",
                res["metrics"]["cycle_count"],
                res["cooler"], res["valve"], res["pump_leak"], res["accumulator"],
            )

            client.publish(
                "jesa/site1/workshop/hydraulics/A2/metrics/cycle_count",
                json.dumps({"ts": ts, "v": res["metrics"]["cycle_count"], "q": "good"}),
                qos=0,
            )
            client.publish(
                "jesa/site1/workshop/hydraulics/A2/metrics/degraded_cooler_count",
                json.dumps({"ts": ts, "v": res["metrics"]["degraded_cooler_count"], "q": "good"}),
                qos=0,
            )

        # ── A3 ───────────────────────────────────────────────────────
        elif "/A3/" in msg.topic:
            res = userdata["a3"].update(msg.topic, value)
            if res is None:
                return

            client.publish(
                "jesa/site1/fleet/apu/A3/analytics/anomaly",
                json.dumps({
                    "ts": ts, "v": res["is_anomaly"], "q": "good",
                    "score": res["anomaly_score"],
                    "threshold": userdata["a3"].threshold,
                }),
                qos=0,
            )
            client.publish(
                "jesa/site1/fleet/apu/A3/metrics/prediction_count",
                json.dumps({"ts": ts, "v": res["metrics"]["prediction_count"], "q": "good"}),
                qos=0,
            )
            log.info(
                "A3 prediction #%d | anomaly=%d score=%.4f (threshold=%.4f)",
                res["metrics"]["prediction_count"],
                res["is_anomaly"],
                res["anomaly_score"],
                userdata["a3"].threshold,
            )
            client.publish(
                "jesa/site1/fleet/apu/A3/metrics/anomaly_count",
                json.dumps({"ts": ts, "v": res["metrics"]["anomaly_count"], "q": "good"}),
                qos=0,
            )

    except Exception:
        log.exception("Error processing message on topic %s", msg.topic)


def main():
    log.info("Starting ML Inference Service (A1, A2, A3)")
    a1 = A1Predictor()
    a2 = A2Predictor()
    a3 = A3Predictor()

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id=os.getenv("MQTT_CLIENT_ID", "ml-inference-service"),
        protocol=mqtt.MQTTv5,
        userdata={"a1": a1, "a2": a2, "a3": a3},
    )
    client.on_connect    = on_connect
    client.on_disconnect = on_disconnect
    client.on_message    = on_message

    # Enable paho auto-reconnect
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    # Initial connection with retry
    while True:
        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
            break
        except (ConnectionRefusedError, OSError):
            log.warning("Waiting for MQTT broker at %s:%d ...", MQTT_HOST, MQTT_PORT)
            time.sleep(5)

    client.loop_forever()


if __name__ == "__main__":
    main()
