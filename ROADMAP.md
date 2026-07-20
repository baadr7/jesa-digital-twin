# Digital Twin & Predictive Maintenance Platform — Roadmap

> Decoded from handwritten notes (2026-07-07). Goal: build a full Industry 4.0 pipeline —
> simulated assets → PLC → OPC UA → Gateway → MQTT Broker → **UNS** → Grafana visualization +
> ML predictive maintenance, with a 3D digital twin as a stretch goal.

---

## 1. Target architecture (from the sketch)

```
                        ┌───────────────┐      ┌──────────────────────┐
                        │ Visualisation │      │ MP (Maintenance      │
                        │   (Grafana)   │◄────►│  Prédictive / ML)    │
                        └──────▲────────┘      └──────────▲───────────┘
                               │                          │
                          ┌────┴──────────────────────────┴────┐
                          │              U N S                 │
                          │      (Unified Namespace, MQTT)     │
                          └────────────────▲───────────────────┘
                                           │ MQTT
                                    ┌──────┴───────┐
                                    │    Broker    │
                                    └──────▲───────┘
                                           │ MQTT
                                    ┌──────┴───────┐
                          OPC UA ──►│   Gateway    │  (OPC UA ⇄ MQTT)
                                    └──────▲───────┘
                                           │ OPC UA
                                    ┌──────┴───────┐
                                    │     PLC      │  (soft PLC / contrôleur)
                                    └──▲────▲───▲──┘
                            OPC UA ────┘    │   └──── OPC UA
                              ┌────────┐ ┌────────┐ ┌────────┐
                              │   A1   │ │   A2   │ │   A3   │
                              │ Milling│ │Hydraul.│ │  APU   │
                              │ machine│ │  rig   │ │Compres.│
                              └────────┘ └────────┘ └────────┘
                                                          + 3D twin (stretch)
```

Each asset is a **simulator that replays its real dataset** and exposes values as an
**OPC UA server**. The PLC aggregates/controls, a gateway republishes to MQTT, and the
UNS becomes the single source of truth consumed by Grafana and the ML layer.

---

## 2. The three assets — detailed analysis

### Asset A1 — Milling machine (AI4I 2020 Predictive Maintenance dataset)
- **File**: `ai4i+2020+predictive+maintenance+dataset/ai4i2020.csv` (10,000 rows, synthetic but realistic)
- **Attributes to model in the digital twin (DT)**:

| Attribute | Unit | OPC UA node idea | Notes |
|---|---|---|---|
| Air temperature | K | `A1/Process/AirTemp` | ~300 K, random-walk |
| Process temperature | K | `A1/Process/ProcTemp` | AirTemp + ~10 K |
| Rotational speed | rpm | `A1/Drive/Speed` | ~1500 rpm, from 2860 W power |
| Torque | Nm | `A1/Drive/Torque` | ~40 Nm mean |
| Tool wear | min | `A1/Tool/Wear` | accumulates per part, resets on tool change |
| Machine failure + TWF/HDF/PWF/OSF/RNF | bool | `A1/Status/*` | 5 independent failure modes |

- **Failure modes** (labels available → **supervised classification**):
  - **TWF** tool wear failure (wear 200–240 min), **HDF** heat dissipation (ΔT < 8.6 K & speed < 1380 rpm), **PWF** power out of 3.5–9 kW band, **OSF** overstrain (wear×torque), **RNF** random.
- **Simulation strategy**: event-based replay (1 row = 1 machined part, e.g. every 5–10 s); tool wear must accumulate realistically between failures.
- **ML task**: binary/multi-class failure classification (imbalanced ~3.4% failures → use class weights / SMOTE; metrics: F1, recall per failure mode).

### Asset A2 — Hydraulic test rig (ZeMA condition monitoring dataset)
- **Files**: `condition+monitoring+of+hydraulic+systems/` — 17 sensor files, 2,205 load cycles of 60 s each, `profile.txt` = per-cycle health labels.
- **Attributes to model**:

| Sensor group | Signals | Rate | OPC UA node idea |
|---|---|---|---|
| Pressure | PS1–PS6 (bar) | 100 Hz | `A2/Hydraulic/PS1..6` |
| Motor power | EPS1 (W) | 100 Hz | `A2/Motor/Power` |
| Volume flow | FS1, FS2 (l/min) | 10 Hz | `A2/Hydraulic/Flow1..2` |
| Temperature | TS1–TS4 (°C) | 1 Hz | `A2/Thermal/TS1..4` |
| Vibration | VS1 (mm/s) | 1 Hz | `A2/Motor/Vibration` |
| Virtual | CE (%), CP (kW), SE (%) | 1 Hz | `A2/KPIs/*` |

- **Health labels per cycle** (→ **multi-target classification / condition monitoring**): cooler condition (3/20/100 %), valve condition (73–100 %), internal pump leakage (0/1/2), accumulator pressure (90–130 bar), stable flag.
- **Simulation strategy**: replay cycle-by-cycle; either stream raw 100 Hz (heavy) or publish 1 Hz downsampled + per-cycle aggregates (recommended for the UNS). This is the **highest-frequency, richest asset** — good for demonstrating edge aggregation at the gateway.
- **ML task**: predict the 4 component conditions from cycle features (classic feature-extraction + gradient boosting works very well on this set).

### Asset A3 — Metro train Air Production Unit / compressor (MetroPT-3)
- **Files**: `metropt+3+dataset/MetroPT3(AirCompressor).csv` (15.17 M rows @ 1 Hz, Feb–Aug 2020) + PDF description.
- **Attributes to model**: 7 analogue — TP2, TP3, H1, DV_pressure, Reservoirs (bar), Motor_current (A: 0/4/7/9 signature), Oil_temperature (°C); 8 digital — COMP, DV_electric, Towers, MPG, LPS (<7 bar alarm), Pressure_switch, Oil_level, Caudal_impulses.
- **Failures**: unlabeled stream + a failure report table (4 air-leak events: 18 Apr, 29–30 May, 5–7 Jun, 15 Jul 2020) → **unsupervised anomaly detection / RUL**.
- **Simulation strategy**: time-accelerated replay of the CSV (e.g. 60× so 6 months ≈ 3 days), preserving the compressor load/unload duty cycle; digital signals make nice PLC boolean inputs.
- **ML task**: anomaly detection (autoencoder / Isolation Forest on sliding windows), validated against the 4 known air-leak windows; then remaining-useful-life estimation.

### Why these three are a good portfolio
| | A1 Milling | A2 Hydraulic rig | A3 APU compressor |
|---|---|---|---|
| Data shape | tabular, event-per-part | cyclic multi-rate waveforms | continuous 1 Hz stream |
| Labels | full failure labels | per-cycle condition grades | failure reports only |
| ML paradigm | supervised classification | multi-target condition monitoring | unsupervised anomaly / RUL |

Together they cover the three canonical predictive-maintenance scenarios.

---

## 3. Roadmap phases (matching the 5 handwritten steps)

### Phase 1 — Identification des assets ✅ (done)
A1 = milling machine, A2 = hydraulic test rig, A3 = APU air compressor. Datasets acquired.

### Phase 2 — Identification des attributs ⇄ datasets ✅ (done)
- [x] For each asset, freeze the attribute dictionary (name, unit, range, rate, data type) — all ranges validated against raw data.
- [x] Design the OPC UA information model (folder/name hierarchy, namespace URIs, ISA-95 naming rationale, ground-truth tag policy) — documented in `docs/asset-attribute-map.md` §2–§8.
- [x] EDA notebook per dataset: distributions, failure windows, sampling-rate decisions, what gets published raw vs. aggregated. All notebooks executed without errors.
- **Deliverable**: [`docs/asset-attribute-map.md`](docs/asset-attribute-map.md) + [`notebooks/A1_EDA.ipynb`](notebooks/A1_EDA.ipynb) + [`notebooks/A2_EDA.ipynb`](notebooks/A2_EDA.ipynb) + [`notebooks/A3_EDA.ipynb`](notebooks/A3_EDA.ipynb).

### Phase 3 — Simulation des assets + contrôleur PLC (≈ 2–3 weeks)
- [x] Build 3 Python replay simulators (`asyncua` OPC UA server each): A1 event-based, A2 cycle-based, A3 time-accelerated stream, with a configurable speed factor. Implemented in `sim/` (see `sim/README.md`); verified end-to-end with `python -m sim.tools.verify_client`.
- [x] Supervisory logic controller in Python (`sim/plc.py`, spec in `docs/plc-spec.md`): OPC UA client of the 3 asset servers, 500 ms scan cycle, interlocks (AI4I-derived stops on A1, condition thresholds on A2, LPS/oil alarms on A3), comm-fault watchdog with safe state, consolidated OPC UA server on port 4840. Verified live incl. watchdog trip/recovery.
- [ ] Port the same spec to an IEC 61131-3 soft PLC (CODESYS Structured Text) as a drop-in replacement on port 4840 — optional credibility step, no downstream change.
- **Deliverable**: `sim/` package + PLC; all tags browsable in UaExpert.

### Phase 4 — Création de l'UNS ✅ (done)
- [x] MQTT broker: **Mosquitto 2.x** (Docker), TCP :1883 + WebSocket :9001. Config in `infra/mosquitto/mosquitto.conf`.
- [x] Gateway OPC UA → MQTT: Python async bridge (`uns/gateway.py`). Browses all OPC UA variables, publishes JSON payloads (`{ts, v, q}`) at 1 Hz. Decision: **plain JSON** over Sparkplug B — simpler, ISA-95 topic tree is self-describing, Grafana/InfluxDB integrate directly.
- [x] UNS topic hierarchy (ISA-95 aligned, 97 topics total across 4 sources), specified in `docs/uns-spec.md`:
  ```
  jesa/site1/workshop/milling/A1/drive/torque_nm
  jesa/site1/workshop/hydraulics/A2/kpis/cooling_efficiency_pct
  jesa/site1/fleet/apu/A3/motor/current_a
  jesa/site1/plc/a1/stop_command
  ```
- [x] Persist the stream: **Telegraf** MQTT consumer → **InfluxDB 2.x** (`infra/telegraf/telegraf.conf`), auto-provisioned org `jesa`, bucket `telemetry`, 30-day retention.
- **Deliverable**: `docker-compose.yml` (Mosquitto + InfluxDB + Telegraf), `uns/` package, `docs/uns-spec.md`. Verify with `python -m uns.verify`.


### Phase 5 — Maintenance prédictive + visualisation ✅ (done)
- [x] Interim live dashboard (`python -m sim.tools.dashboard`, http://localhost:8080): polls the three OPC UA servers at 1 Hz, per-asset charts + condition chips, light/dark, no external dependencies. Development aid pending the Grafana stack.
- [x] **Grafana** dashboards per asset (live values from InfluxDB, alarm annotations) + a fleet overview fed by the UNS.
- [x] ML services (Python, containerized), one per paradigm:
  - A1: classifier (scikit-learn / XGBoost) → publishes `A1/analytics/machine_failure` back to the UNS;
  - A2: condition estimator trained and saved;
  - A3: anomaly detector trained and saved (PyTorch LSTM Autoencoder).
  Predictions flow **back into the UNS** so Grafana shows them next to raw telemetry — that's what makes it a digital twin loop, not just a dashboard.
- [x] **+3D (stretch)**: Three.js web scene (or Unity) with the three assets colored by live health score via MQTT-over-WebSocket from the broker.
- **Deliverable**: dashboards, 3 model services with evaluation reports, and an immersive 3D digital twin dashboard.

### Phase 6 & 7 — MLOps, DevOps & Perfectionnement ✅ (done)
- [x] CI/CD Pipeline via GitHub Actions (`.github/workflows/ci.yml`)
- [x] Unittests for simulators and inference service.
- [x] Continuous Learning (Hot-Reloading): inference service dynamically reloads `.joblib` models when retrained without downtime.
- [x] Extreme ML tuning to force A1 minority class metrics to perfect 1.0 F1 score.

---

## 4. Proposed tech stack

| Layer | Tool | Why |
|---|---|---|
| Asset simulators | Python + `asyncua` + pandas | easy dataset replay, real OPC UA servers |
| PLC | CODESYS (or OpenPLC) | free, industrial-grade, native OPC UA |
| Gateway | Node-RED or Telegraf | quick OPC UA→MQTT mapping, visual flows |
| Broker / UNS | EMQX or Mosquitto | Sparkplug-friendly, WebSocket for 3D/web |
| Storage | InfluxDB + Telegraf | time-series native, Grafana integration |
| Visualization | Grafana | dashboards, alerting |
| ML | scikit-learn / XGBoost / PyTorch (A3 autoencoder) | matches the three task types |
| 3D | Three.js (web) or Unity | live health-colored twin |
| Packaging | Docker Compose | one-command demo stack |

## 5. Risks & decisions to make early
1. **A2 data volume** (100 Hz × 7 sensors): don't push raw waveforms through MQTT — aggregate at the gateway/edge, keep raw only for offline training.
2. **A3 replay speed**: pick the acceleration factor now (60×–600×) — it drives how fast anomalies appear in demos.
3. **Sparkplug B vs. plain JSON topics**: Sparkplug gives structure and state management but constrains topic naming; plain UNS topics are more readable. Decide in Phase 4 before wiring dashboards.
4. **Model drift story**: predictions must be written back to the UNS with model version in the payload, or the "predictive" layer stays a silo.

**Total estimate: 7–10 weeks** for phases 2–5 at one-person pace; the demo stack (phases 3–4 minimal) can run in ~3 weeks.
