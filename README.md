# JESA Digital Twin

## 📄 Internship Project Report
For a full evaluation of this project as an internship deliverable at JESA, including proposed enhancements, see [INTERNSHIP_PROJECT_REPORT.md](file:///c:\Users\MSI\Documents\jesa\INTERNSHIP_PROJECT_REPORT.md).

## Overview
JESA Digital Twin is an Industry 4.0 predictive maintenance platform that simulates industrial assets, collects telemetry via OPC UA, runs ML models for anomaly/failure prediction, and provides a 3D interactive visualization of the factory floor!

## Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                       ┌───────────────────┐                  │
│                       │   3D Digital Twin │ (http://8000)    │
│                       │   (Web UI / MQTT) │                  │
│                       └───────────────────┘                  │
│                                                              │
│  ┌──────────┐  ┌───────┐  ┌──────────────────────────────┐  │
│  │  A1/A2/  │  │       │  │ ┌─────────────────────────┐  │  │
│  │   A3     │  │  PLC  │  │ │  ML Inference (A1/A2/A3) │  │  │
│  │Simulators│──│       │──┼─┘                         │  │  │
│  │          │  │       │  └───────────────────────────┘  │  │
│  └──────────┘  └───────┘                                  │  │
│                     │                                     │  │
│              ┌──────▼───────┐                             │  │
│              │ UNS Gateway  │                             │  │
│              │ (OPC UA→MQTT)│                             │  │
│              └──────┬───────┘                             │  │
│                     │                                     │  │
│  ┌──────────────────┼─────────────────────────────────┐   │
│  │                  │      Docker Stack               │   │
│  │  ┌──────────────────┐ ┌──────────┐ ┌────────────┐ │   │
│  │  │   Mosquitto      │ │ InfluxDB │ │  Grafana   │ │   │
│  │  │   (MQTT Broker)  │ │(TSDB)    │ │(Dashboard) │ │   │
│  │  └──────────────────┘ └──────────┘ └────────────┘ │   │
│  │                  └──────┬───────────────────────────────┘
│  │                         │   Telegraf (MQTT→Influx)
│  └─────────────────────────┘
```

## Quickstart
### Step 0: Download Datasets (First Time Only)
Run the dataset setup script to automatically download and organize all required datasets:
```bash
python setup_datasets.py
```
*(Note: The MetroPT-3 dataset requires a Kaggle account; see script output for manual download instructions if needed.)*

### Step 1: Start Docker Services
```bash
cd jesa
docker compose up -d
```
Wait until all containers are healthy, especially InfluxDB and Grafana!

### Step 2: Run Simulators & PLC
- Simulators (A1, A2, A3):
  ```bash
  python -m sim all
  ```
- PLC:
  ```bash
  python -m sim.plc
  ```

### Step 3: Run UNS Gateway
```bash
python -m uns
```

### Step 4: Run ML Inference Service
```bash
python uns/ml_inference_service.py
```

### Step 5: Start 3D Digital Twin UI
```bash
cd web-3d
python -m http.server 8000
```

### Step 6: Open Dashboards
- **3D Digital Twin UI**: http://localhost:8000
- **Grafana**: http://localhost:3000 (credentials: admin / jesa-admin)

## Credentials
| Service      | Username  | Password          |
|--------------|-----------|-------------------|
| Grafana      | admin     | jesa-admin        |
| InfluxDB     | jesa      | jesa-dev-2026     |
| InfluxDB Token | —      | jesa-dev-token    |

## Project Structure
```
jesa/
├── sim/               # Simulators (A1/A2/A3) + PLC
│   ├── assets/        # Per-asset simulators
│   └── __main__.py    # Entrypoint for simulators
├── uns/               # UNS (Unified Namespace) components
│   ├── gateway.py     # OPC UA → MQTT bridge
│   └── ml_inference_service.py  # ML Inference Service (A1/A2/A3)
├── web-3d/            # 3D Digital Twin UI (Three.js + MQTT)
│   ├── index.html     # Main HTML page
│   └── app.js         # Web app logic
├── notebooks/         # Notebooks for model training
│   └── models/        # Trained models
├── infra/             # Docker Compose + configs
│   ├── grafana/       # Grafana dashboards/provisioning
│   ├── mosquitto/     # Mosquitto config
│   └── telegraf/      # Telegraf config
├── tests/             # Unit tests
├── docker-compose.yml # Docker Compose stack
└── README.md          # This file
```

## Screenshots
- **3D Digital Twin UI**: `c:\Users\MSI\AppData\Local\Temp\trae\screenshots\jesa-3d-digital-twin-final.png`
- **Grafana Dashboards**: `c:\Users\MSI\AppData\Local\Temp\trae\screenshots\jesa-grafana-dashboards-final.png`

## Asset Info
- **A1**: CNC Milling Machine – supervised failure classification (XGBoost)
- **A2**: Hydraulic System – multi-target condition monitoring (XGBoost)
- **A3**: APU Compressor – unsupervised anomaly detection (Isolation Forest + LSTM Autoencoder)

## Tests
Run unit tests:
```bash
pytest -v tests/
```
All tests should pass!

