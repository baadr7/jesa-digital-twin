# Node-RED UNS Migration — Architecture & Operating Guide

**Replaces:** `uns/gateway.py` (OPC UA → MQTT bridge)  
**Adds:** Derived Data computation · ISA-18.2 Alarm Engine (HH/H/L/LL)  
**Does NOT replace:** `uns/ml_inference_service.py` (ML stays Python)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  HOST MACHINE                                                           │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ sim A1 :4841 │  │ sim A2 :4842 │  │ sim A3 :4843 │  │ PLC :4840 │  │
│  │ OPC UA server│  │ OPC UA server│  │ OPC UA server│  │ OPC UA    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘  │
│         │                 │                 │                 │        │
│         └─────────────────┴─────────────────┴────────────────┘        │
│                                     │ OPC UA TCP (host.docker.internal) │
└─────────────────────────────────────┼───────────────────────────────────┘
                                      │
┌─────────────────────────────────────┼───────────────────────────────────┐
│  DOCKER NETWORK (jesa_default)      │                                   │
│                                     ▼                                   │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  NODE-RED  :1880                                                 │   │
│  │                                                                  │   │
│  │  Tab 01 · OPC UA Gateway                                        │   │
│  │    1 Hz inject → tag definitions → OpcUa-Client read             │   │
│  │    → normalise → _toSnake() / topic builder → mqtt-out          │   │
│  │    → stale watchdog on disconnect                               │   │
│  │                                                                  │   │
│  │  Tab 02 · Derived Data  (subscribe MQTT → compute → publish)   │   │
│  │    A1: power_kw · delta_t_k · wear_torque · overstrain_flag     │   │
│  │    A2: cooler_delta_t_c · hydraulic_work_w · efficiency_ratio   │   │
│  │    A3: comp_duty_pct_5min · pressure_differential · load_state  │   │
│  │                                                                  │   │
│  │  Tab 03 · Alarm Engine  (ISA-18.2 HH/H/L/LL)                   │   │
│  │    Deadband hysteresis · on-delay confirmation · state machine  │   │
│  │    Publishes .../alarms/{tag} + system/alarms/active bus        │   │
│  │                                                                  │   │
│  │  Tab 04 · System Monitor  (Node-RED dashboard :1880/ui)         │   │
│  │    OPC UA health · active alarm table · msg/s gauge             │   │
│  └──────────────────────────────┬───────────────────────────────────┘   │
│                                 │ MQTT :1883                            │
│                     ┌───────────▼──────────────────────┐               │
│                     │  Mosquitto  :1883 / :9001 (WS)   │               │
│                     └───┬────────────┬────────────┬────┘               │
│                         │            │            │                    │
│             ┌───────────▼──┐  ┌──────▼───┐  ┌────▼──────────────────┐ │
│             │  Telegraf    │  │ Grafana  │  │  ML Inference (host)  │ │
│             │  → InfluxDB  │  │ :3000    │  │  → .../analytics/*    │ │
│             └──────────────┘  └──────────┘  └───────────────────────┘ │
│                                                                         │
│             ┌──────────────────────────────────────────────────────┐   │
│             │  web-3d :8000  (Paho WebSocket → Mosquitto :9001)   │   │
│             └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
infra/nodered/
├── flows.json      ← Full flow definition (4 tabs). Seeded into container
│                     on first start; edited via Node-RED UI thereafter.
├── settings.js     ← Node-RED runtime config (bind-mounted read-only).
│                     Contains ALARM_LIMITS, TOPIC_PREFIX, asset URLs.
└── package.json    ← npm packages installed on container start.
                      Add new packages here; restart container to install.
```

**To modify alarm limits:** edit `ALARM_LIMITS` in `infra/nodered/settings.js`
and restart the container:
```bash
docker compose restart nodered
```

**To modify flows:** use the Node-RED editor at `http://localhost:1880`,
deploy changes, then export and overwrite `infra/nodered/flows.json` to
keep the file in sync with the container:
```bash
# Export current flows from running container
docker exec jesa-nodered cat /data/flows.json > infra/nodered/flows.json
```

---

## 3. MQTT Topic Schema

### 3.1 Raw telemetry (replaces uns/gateway.py output — identical schema)

```
jesa/site1/{area}/{AssetId}/{folder}/{tag}
```

| Asset | Area                    | Example topic                                          |
|-------|-------------------------|--------------------------------------------------------|
| A1    | workshop/milling        | `jesa/site1/workshop/milling/A1/drive/torque_nm`       |
| A2    | workshop/hydraulics     | `jesa/site1/workshop/hydraulics/A2/thermal/ts1_c`      |
| A3    | fleet/apu               | `jesa/site1/fleet/apu/A3/pneumatic/tp3_bar`            |
| PLC   | plc                     | `jesa/site1/plc/system/mode`                           |

Payload format (unchanged from Python gateway):
```json
{ "ts": "2026-08-04T12:00:00Z", "v": 42.7, "q": "good" }
```

Quality values: `good` · `uncertain` · `stale`

### 3.2 Derived data (NEW — not in Python gateway)

```
jesa/site1/{area}/{AssetId}/derived/{derived_tag}
```

| Topic suffix                               | Formula                                    | Unit    |
|--------------------------------------------|--------------------------------------------|---------|
| `A1/derived/power_kw`                      | Torque × Speed × 2π/60 ÷ 1000             | kW      |
| `A1/derived/delta_t_k`                     | ProcessTemp − AirTemp                      | K       |
| `A1/derived/wear_torque`                   | ToolWear_min × Torque_Nm                   | min·Nm  |
| `A1/derived/overstrain`                    | wear_torque > limit(ProductType)           | bool    |
| `A1/derived/power_out_of_range`            | power_w < 3500 OR > 9000                   | bool    |
| `A1/derived/heat_dissipation_risk`         | ΔT < 8.6 K AND Speed < 1380 rpm            | bool    |
| `A2/derived/cooler_delta_t_c`              | TS1 − TS4                                  | °C      |
| `A2/derived/hydraulic_work_w`              | PS1(Pa) × Flow1(m³/s)                      | W       |
| `A2/derived/thermal_efficiency_ratio`      | CoolingPower_W / MotorPower_W              | —       |
| `A3/derived/comp_duty_pct_5min`            | COMP on-time % over 300 s window           | %       |
| `A3/derived/pressure_differential_bar`     | TP3 − TP2                                  | bar     |
| `A3/derived/tp3_reservoir_diff_bar`        | TP3 − Reservoirs                           | bar     |
| `A3/derived/load_state`                    | idle / offload / load / peak (from Current)| string  |

### 3.3 Alarms (NEW — replaces sim/plc.py alarm logic)

```
jesa/site1/{area}/{AssetId}/alarms/{tag}
jesa/site1/system/alarms/active          ← aggregated alarm bus
jesa/site1/system/alarm_config           ← retained, full limits table
```

Alarm payload:
```json
{
  "ts":       "2026-08-04T12:00:05Z",
  "level":    "HH",
  "severity": "critical",
  "value":    71.2,
  "limit":    70,
  "unit":     "Nm",
  "tag":      "workshop/milling/A1/drive/torque_nm",
  "msg":      "torque_nm HH alarm: 71.200 Nm (limit 70 Nm)",
  "q":        "good"
}
```

---

## 4. Alarm Limits Reference

All limits live in `infra/nodered/settings.js` under `ALARM_LIMITS`.
They are also published retained to `jesa/site1/system/alarm_config` on
every Node-RED start so Grafana / web-3d can read them dynamically.

| Tag path (strip `jesa/site1/`)                        | LL      | L       | H       | HH      | Unit  |
|-------------------------------------------------------|---------|---------|---------|---------|-------|
| `workshop/milling/A1/drive/torque_nm`                 | 3       | 10      | 60      | 70      | Nm    |
| `workshop/milling/A1/drive/rotational_speed_rpm`      | 800     | 1 200   | 2 500   | 2 900   | rpm   |
| `workshop/milling/A1/tool/tool_wear_min`              | —       | —       | 200     | 240     | min   |
| `workshop/milling/A1/derived/power_kw`                | 3.5     | —       | —       | 9.0     | kW    |
| `workshop/hydraulics/A2/motor/power_w`                | —       | —       | 2 900   | 3 200   | W     |
| `workshop/hydraulics/A2/motor/vibration_mms`          | —       | —       | 0.8     | 1.2     | mm/s  |
| `workshop/hydraulics/A2/kpis/cooling_efficiency_pct`  | 15      | 30      | —       | —       | %     |
| `fleet/apu/A3/pneumatic/tp3_bar`                      | 6.5     | 7.0     | 10.5    | 11.0    | bar   |
| `fleet/apu/A3/pneumatic/reservoirs_bar`               | 6.5     | 7.0     | 10.5    | 11.0    | bar   |
| `fleet/apu/A3/motor/current_a`                        | —       | —       | 8.0     | 8.5     | A     |
| `fleet/apu/A3/oil/temperature_c`                      | —       | —       | 65      | 70      | °C    |

**Alarm engine parameters** (also in `settings.js`):

| Parameter           | Value | Meaning                                            |
|---------------------|-------|----------------------------------------------------|
| `ALARM_ON_DELAY`    | 2     | Consecutive scans above limit before alarm raised  |
| `ALARM_DEADBAND_PCT`| 2 %   | Value must retreat this far inside limit to clear  |

---

## 5. Operations

### Start the full stack
```powershell
.\launch_all.ps1          # Windows PowerShell
# or
.\launch_all.bat          # Windows CMD
# or
docker compose up -d      # Docker services only
```

### First-boot package install
On the first `docker compose up`, the `nodered` container runs:
```
npm install node-red-contrib-opcua@0.2.338 node-red-dashboard@3.6.5 ...
```
This takes **~45–60 seconds**. Watch progress:
```bash
docker compose logs -f nodered
```
The container is healthy once you see `Node-RED server listening`.

### Stop
```powershell
docker compose down           # stop containers (keep volumes)
docker compose down -v        # stop + delete all data volumes
Stop-Process -Name python -Force   # kill host Python processes
```

### Rebuild after settings change
```bash
# Alarm limit change → restart is enough (settings.js is bind-mounted)
docker compose restart nodered

# Package list change (package.json) → recreate container
docker compose up -d --force-recreate nodered

# flows.json reset to repo version (clears live edits)
docker compose stop nodered
docker volume rm jesa_nodered-data
docker compose up -d nodered
```

### Upgrade Node-RED
```yaml
# docker-compose.yml — change image tag
image: nodered/node-red:3.1.9-18   →   nodered/node-red:4.0.x-18
```
Then `docker compose up -d nodered` — flows and packages are preserved in
the `nodered-data` volume.

---

## 6. Coexistence Mode (parallel run for validation)

During cutover you can run **both** the Python gateway and Node-RED
simultaneously. They will publish identical topics; Mosquitto deduplicates
by last-writer-wins (no retained conflict for QoS 0 topics).

To run Python gateway alongside Node-RED:
```powershell
.venv\Scripts\python.exe -m uns   # in a separate terminal
```

Verify they produce the same topic values:
```bash
docker exec jesa-mosquitto mosquitto_sub -t "jesa/site1/#" -v | head -40
```

Once validated, stop the Python gateway. Node-RED is the sole publisher.

---

## 7. Rollback

To revert entirely to the Python gateway:
1. `docker compose stop nodered`
2. In `launch_all.ps1`, uncomment the `python -m uns` step (or run manually)
3. No other changes needed — topic schema is identical

---

## 8. What Is NOT Migrated

| Component                   | Stays Python | Reason                                            |
|-----------------------------|--------------|---------------------------------------------------|
| `uns/ml_inference_service.py` | ✅          | PyTorch LSTM + sklearn — no ML runtime in Node-RED|
| `sim/` OPC UA simulators    | ✅           | asyncua servers; not part of gateway              |
| Python `uns/config.py`      | kept as ref  | Node-RED settings.js is the new source of truth   |
| Python `uns/gateway.py`     | ❌ retired   | Replaced by Node-RED Tab 01                       |
| Python `sim/plc.py` alarms  | ❌ optional  | Node-RED Tab 03 covers all PLC alarm logic        |
