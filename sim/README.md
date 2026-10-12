# Asset simulators (Phase 3 of ROADMAP.md)

Three dataset-replay simulators, each exposing a live OPC UA server. They are
the field layer of the platform: the PLC (Phase 3b) consumes these endpoints,
and the OPC UA/MQTT gateway (Phase 4) publishes them into the UNS.

| Asset | Source dataset | Endpoint | Replay model | Default speed |
|---|---|---|---|---|
| A1 Milling machine | AI4I 2020 (`ai4i2020.csv`) | `opc.tcp://<host>:4841/jesa/a1` | 1 row = 1 machined part every 10 s | x1 |
| A2 Hydraulic test rig | ZeMA condition monitoring | `opc.tcp://<host>:4842/jesa/a2` | 2205 cycles x 60 s, 1 Hz downsampled | x1 |
| A3 APU air compressor | MetroPT-3 | `opc.tcp://<host>:4843/jesa/a3` | timestamp-paced stream, gaps clamped to 60 s | x60 |

## Installation

```
pip install -r requirements.txt
```

## Usage

```
# One-time preprocessing for A2 (downsamples ~450 MB of 100 Hz waveforms
# to sim/data/a2_1hz.npz, ~5 MB):
python -m sim.tools.prepare_a2

# Run simulators:
python -m sim a1                 # single asset, real time
python -m sim a3 --speed 600     # accelerated replay
python -m sim all                # all three in one process

# Verify (requires running servers; reads every variable twice and
# checks that values change):
python -m sim.tools.verify_client --delay 12

# Live dashboard (requires running servers):
python -m sim.tools.dashboard          # then open http://localhost:8080

# Supervisory PLC (requires running servers; spec in docs/plc-spec.md):
python -m sim.plc                      # OPC UA server on port 4840
python -m sim.tools.verify_client plc  # verify it
```

`--speed N` means N dataset seconds elapse per real second. All datasets
wrap around at the end, so the servers run indefinitely.

## OPC UA address space

Each server registers the namespace `urn:jesa:sim:<asset>` and exposes one
object under `Objects/` with folder-per-subsystem structure. Common to all
assets: `Identification/AssetId`, `Identification/Description`,
`Simulation/SpeedFactor`.

```
A1                                  A2                                  A3
├─ Part                             ├─ Hydraulic                        ├─ Pneumatic
│  ├─ ProductId          (str)      │  ├─ PS1..PS6_bar       (f64)      │  ├─ TP2_bar             (f64)
│  └─ ProductType        (str)      │  └─ Flow1..2_lpm       (f64)      │  ├─ TP3_bar             (f64)
├─ Process                          ├─ Motor                            │  ├─ H1_bar              (f64)
│  ├─ AirTemperature_K   (f64)      │  ├─ Power_W            (f64)      │  ├─ DVPressure_bar      (f64)
│  └─ ProcessTemperature_K          │  └─ Vibration_mms      (f64)      │  └─ Reservoirs_bar      (f64)
├─ Drive                            ├─ Thermal                          ├─ Motor
│  ├─ RotationalSpeed_rpm           │  └─ TS1..TS4_C         (f64)      │  └─ Current_A           (f64)
│  └─ Torque_Nm          (f64)      ├─ KPIs                             ├─ Oil
├─ Tool                             │  ├─ CoolingEfficiency_pct         │  └─ Temperature_C       (f64)
│  └─ ToolWear_min       (i64)      │  ├─ CoolingPower_kW               ├─ Digital
├─ Status                           │  └─ EfficiencyFactor_pct          │  ├─ COMP, DVElectric    (bool)
│  ├─ MachineFailure     (bool)     ├─ Condition                        │  ├─ Towers, MPG, LPS    (bool)
│  └─ TWF/HDF/PWF/OSF/RNF (bool)    │  ├─ CoolerCondition_pct (i64)     │  ├─ PressureSwitch      (bool)
└─ Simulation                       │  ├─ ValveCondition_pct  (i64)     │  ├─ OilLevel            (bool)
   └─ PartIndex          (i64)      │  ├─ PumpLeakage         (i64)     │  └─ CaudalImpulses      (bool)
                                    │  ├─ AccumulatorPressure_bar       └─ Simulation
                                    │  └─ StableFlag         (bool)        ├─ RowIndex            (i64)
                                    └─ Simulation                          └─ SourceTimestamp     (str)
                                       ├─ CycleIndex         (i64)
                                       └─ CycleSecond        (i64)
```

The `Condition/*` (A2) and `Status/*` (A1) folders carry the dataset ground
truth. They exist so dashboards and model evaluation can compare predictions
against reality; a production PLC/gateway must treat them as read-only
reference signals, and the ML services of Phase 5 must not use them as
input features.

## Supervisory PLC

`sim/plc.py` implements `docs/plc-spec.md`: one input poller per asset, a
fixed 500 ms scan cycle, interlock logic computed from process measurements
only (never from the ground-truth label tags), a 5 s staleness watchdog that
raises `<asset>/CommFault` and asserts the A1 safe state on communication
loss, and a consolidated OPC UA output image on
`opc.tcp://<host>:4840/jesa/plc` (namespace `urn:jesa:plc`). Alarm edges are
logged. The Phase 4 gateway should consume this single endpoint.

## Live dashboard

`sim/tools/dashboard.py` is a local visualization layer: an aiohttp server
that polls all three OPC UA servers at 1 Hz into 10-minute ring buffers and
serves a self-contained page (`dashboard.html`, no external dependencies)
with per-asset live charts, condition/status chips derived from the dataset
ground truth, hover tooltips and a table view per chart. Light and dark mode
follow the OS theme. Pollers reconnect automatically, so simulators and
dashboard can be started in any order.

This is a development aid; the production visualization path remains
UNS -> InfluxDB -> Grafana (ROADMAP.md Phase 5).

## Design notes

- Pacing is drift-corrected: sleep deadlines are computed from a monotonic
  clock, so replay does not drift even at high speed factors. If a speed is
  too high for the writer, the loop resynchronizes instead of accumulating
  debt.
- A2 raw waveforms (100 Hz) are averaged per second offline; the raw files
  stay untouched for later offline model training (Phase 5).
- A3 is read in 20,000-row chunks; memory stays flat over the 15.17 M rows.
- A3 timestamps are republished (`Simulation/SourceTimestamp`) so anomaly
  detections can be aligned with the four documented air-leak failures
  (2020-04-18, 2020-05-29/30, 2020-06-05/07, 2020-07-15).
- Servers currently run without security policies (plaintext), acceptable on
  a local demo network only. Certificates should be added before any
  multi-host deployment.

## Next steps (see ROADMAP.md)

1. Soft PLC (CODESYS or OpenPLC) consuming the three endpoints as OPC UA
   client, adding interlock logic, re-exposing consolidated tags.
2. OPC UA -> MQTT gateway (Python `uns/gateway.py`) publishing into the UNS
   topic hierarchy.
