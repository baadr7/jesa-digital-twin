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

### Quick Launch (One-click)
The fastest way to start everything:
- **Windows (CMD):** double-click `launch_all.bat`
- **Windows (PowerShell):** right-click `launch_all.ps1` -> *Run with PowerShell*

Both scripts start Docker, all simulators, PLC, UNS Gateway, ML Inference, and the web server in the correct order with health-check delays.

### Manual Launch

#### Step 0: Download Datasets (First Time Only)
```bash
python setup_datasets.py
```
*(Note: The MetroPT-3 dataset requires a Kaggle account; see script output for manual download instructions if needed.)*

#### Step 1: Start Docker Services
```bash
docker compose up -d
```
Wait until all containers are healthy (Mosquitto, InfluxDB, Grafana).

#### Step 2: Run Simulators & PLC
```bash
python -m sim all
python -m sim.plc
```

#### Step 3: Run UNS Gateway
```bash
python -m uns
```

#### Step 4: Run ML Inference Service
```bash
python uns/ml_inference_service.py
```

#### Step 5: Start 3D Digital Twin UI
```bash
cd web-3d
python -m http.server 8000
```

#### Step 6: Open Dashboards
- **3D Digital Twin UI**: http://localhost:8000
- **Grafana**: http://localhost:3000  (admin / jesa-admin)
- **InfluxDB**: http://localhost:8086  (jesa / jesa-dev-2026)
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

## 3D Digital Twin — UI Features
- **Interactive asset panels** — click any machine (3D object or asset card) to open a centered detail panel with live telemetry, asset info, and performance data
- **Scene lift** — the ground and machines rise when a detail panel opens, giving a clear top-down view of the selected asset
- **Reset View** — restores the scene and camera to the initial position
- **Auto-rotate** — scene rotates automatically, pauses on interaction, resumes after 8 s
- **Sidebar navigation** — Overview, Analytics, Visualisation, and Documentation pages accessible via hamburger menu
- **Visualisation page** — real-time Chart.js plots for A1 failure probability, A2 cooler/valve condition, A3 anomaly score, and MQTT message rate; fed live by the MQTT pipeline

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

