# Asset Attribute Map — Digital Twin & Predictive Maintenance Platform

**Document reference**: JESA-DT-ATTR-001  
**Revision**: 1.0  
**Date**: 2026-07-13  
**Phase**: 2 — Identification des attributs  
**Status**: Approved for implementation (simulator code is the reference implementation)

---

## 1. Purpose and scope

This document is the authoritative attribute dictionary for the three simulated
assets of the JESA Digital Twin platform. It defines, for every published signal:

- the canonical tag path used in the OPC UA address space;
- the physical quantity, engineering unit, and value range (validated against raw datasets);
- the source sampling rate and the rate published to the UNS;
- the OPC UA variant type and the reason for any type coercion;
- notes on simulation decisions, interlock use, and ML treatment.

This document governs:

1. **OPC UA simulators** (`sim/assets/a1_milling.py`, `a2_hydraulic.py`, `a3_apu.py`).
2. **Supervisory PLC** (`sim/plc.py`, detailed in `docs/plc-spec.md`).
3. **UNS topic naming** (Phase 4 gateway — topics derived by concatenating this
   path with the ISA-95 site prefix `jesa/site1/{area}/{asset_id}/`).
4. **ML feature engineering** (Phase 5 — ground-truth tags are explicitly excluded
   from model input features; see §6).

---

## 2. Naming conventions and ISA-95 alignment

### 2.1 OPC UA namespace

| Asset | Namespace URI | Default port | Endpoint |
|---|---|---|---|
| A1 Milling machine | `urn:jesa:sim:a1` | 4841 | `opc.tcp://<host>:4841/jesa/a1` |
| A2 Hydraulic rig | `urn:jesa:sim:a2` | 4842 | `opc.tcp://<host>:4842/jesa/a2` |
| A3 APU compressor | `urn:jesa:sim:a3` | 4843 | `opc.tcp://<host>:4843/jesa/a3` |
| Supervisory PLC | `urn:jesa:plc` | 4840 | `opc.tcp://<host>:4840/jesa/plc` |

### 2.2 Address-space structure

Each asset server exposes one OPC UA **Object** node named after the asset ID
(e.g. `A1`) under the standard `Objects/` folder. Below that object, variables
are grouped into **Folder** nodes. The folder hierarchy follows ISA-95
Level 2 / IEC 62264 functional decomposition:

```
<AssetId>/
  Identification/    — static nameplate data
  <Subsystem>/       — one folder per physical subsystem (see per-asset sections)
  Status|Condition/  — dataset ground-truth labels (read-only reference)
  Simulation/        — replay metadata (not physical signals)
```

> **Why not an OPC UA `AssetType` ObjectType?**  
> The current implementation uses plain `Object` nodes for pragmatic reasons:
> `asyncua` supports `ObjectType` definitions but adds boilerplate that slows
> early iteration. A typed `AssetType` extending `BaseObjectType` (with
> mandatory `Identification` and `Simulation` components) is the planned
> upgrade for Phase 4, when the gateway needs to introspect the type system.
> The flat folder structure is semantically equivalent and migration is
> non-breaking for downstream consumers.

### 2.3 Tag-path convention

Tag paths within this document use the notation `<Folder>/<Name>` as it
appears in the `Tag(folder, name, initial)` dataclass in the code. The full
OPC UA browse path is `Objects/<AssetId>/<Folder>/<Name>`.

### 2.4 Unit encoding in tag names

Units are embedded in the tag name suffix to make the address space
self-describing without requiring engineering unit extension nodes:

| Suffix | Unit |
|---|---|
| `_K` | Kelvin |
| `_rpm` | Revolutions per minute |
| `_Nm` | Newton·metre |
| `_min` | Minutes |
| `_bar` | Bar (1 bar ≈ 100 kPa) |
| `_lpm` | Litres per minute |
| `_W` | Watts |
| `_kW` | Kilowatts |
| `_mms` | Millimetres per second |
| `_C` | Degrees Celsius |
| `_A` | Amperes |
| `_pct` | Percent (0–100 scale) |

Boolean tags carry no unit suffix. String tags carry no unit suffix.

---

## 3. Common tags (all assets)

The following tags are present on every asset server, injected by the
`AssetSimulator` base class.

| Tag path | Physical quantity | Unit | Type | Value / range | Notes |
|---|---|---|---|---|---|
| `Identification/AssetId` | — | — | String | `"A1"` / `"A2"` / `"A3"` | Static nameplate |
| `Identification/Description` | — | — | String | Dataset description | Static nameplate |
| `Simulation/SpeedFactor` | Replay acceleration | — | Double | A1: 1.0 · A2: 1.0 · A3: 60.0 | Dataset-s per real-s |

---

## 4. Asset A1 — Milling machine (AI4I 2020 Predictive Maintenance)

**Source dataset**: `ai4i+2020+predictive+maintenance+dataset/ai4i2020.csv`  
**Rows**: 10,000 (synthetic; one row = one machined part)  
**Replay model**: event-based — one row published every `A1_PART_INTERVAL_S = 10 s` (real time)  
**Replay speed**: × 1.0 (default)  
**Dataset reference**: Matzka, S. (2020). AI4I 2020 Predictive Maintenance Dataset. UCI ML Repository.

### 4.1 Process signals

| Tag path | Physical quantity | Unit | Source rate | Published rate | OPC UA type | Min | Max | Mean | Std | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `Part/ProductId` | Product identifier | — | per-part | per-part | String | — | — | — | — | Format `L/M/H + 5 digits`; qualitative only |
| `Part/ProductType` | Product quality class | — | per-part | per-part | String | `"L"` | `"H"` | — | — | L = 60 %, M = 30 %, H = 10 % of dataset |
| `Process/AirTemperature_K` | Ambient air temperature | K | per-part | per-part | Double | 295.3 | 304.5 | 300.0 | 2.0 | Random-walk process; ~300 K nominal |
| `Process/ProcessTemperature_K` | Spindle / workpiece temperature | K | per-part | per-part | Double | 305.7 | 313.8 | 310.0 | 1.5 | ΔT = T_proc − T_air ∈ [7.6, 12.1] K; narrowing ΔT triggers HDF |
| `Drive/RotationalSpeed_rpm` | Spindle rotational speed | rpm | per-part | per-part | Int64 | 1168 | 2886 | 1539 | 179 | Derived from a power of 2860 W; low speed + low ΔT → HDF |
| `Drive/Torque_Nm` | Spindle torque | N·m | per-part | per-part | Double | 3.8 | 76.6 | 40.0 | 10.0 | Normally distributed; product power = torque × speed × 2π/60 |
| `Tool/ToolWear_min` | Cumulative tool wear | min | per-part | per-part | Int64 | 0 | 253 | 108 | 64 | Accumulates per part, wraps at dataset boundary; 200–240 min → TWF zone |

### 4.2 Status / ground-truth tags

> **Policy**: these tags carry dataset labels, not sensor readings. They are
> published so dashboards and ML evaluation can compare predictions against
> ground truth. **PLC interlocks and ML input features must not use them.**

| Tag path | Failure mode | Type | Occurrence | Definition (AI4I paper) |
|---|---|---|---|---|
| `Status/MachineFailure` | Any failure | Boolean | 339 / 10,000 (3.39 %) | OR of the five modes below |
| `Status/TWF` | Tool Wear Failure | Boolean | 46 / 10,000 (0.46 %) | Tool wear ∈ [200, 240] min (stochastic replacement) |
| `Status/HDF` | Heat Dissipation Failure | Boolean | 115 / 10,000 (1.15 %) | ΔT < 8.6 K **AND** speed < 1,380 rpm |
| `Status/PWF` | Power Failure | Boolean | 95 / 10,000 (0.95 %) | Power < 3,500 W **OR** power > 9,000 W |
| `Status/OSF` | Overstrain Failure | Boolean | 98 / 10,000 (0.98 %) | Wear × torque > 11,000 (L) / 12,000 (M) / 13,000 (H) min·N·m |
| `Status/RNF` | Random Failure | Boolean | 19 / 10,000 (0.19 %) | Random, 0.1 % probability, independent of process |

**Co-occurrence note**: multiple failure modes can be simultaneously TRUE for
the same part; total individual-mode count (373) exceeds MachineFailure count
(339) because RNF can coincide with another mode.

### 4.3 Simulation tags

| Tag path | Type | Description |
|---|---|---|
| `Simulation/PartIndex` | Int64 | UDI from the CSV (1–10,000, wraps) |
| `Simulation/SpeedFactor` | Double | 1.0 (inherited) |

### 4.4 Replay and sampling decisions

| Decision | Value | Rationale |
|---|---|---|
| Part interval | 10 s | Mimics a machining cycle; gives 1,000 parts/real-hour for demo visibility |
| Speed factor | 1.0 | Dataset is already part-indexed; no time axis to accelerate |
| Wrap behaviour | cyclic | 10,000 parts → loop forever; tool wear wraps naturally at dataset boundary |
| UNS publish rate | 1 tag-set per part | All A1 tags published atomically on each part completion |

### 4.5 ML task summary

| Aspect | Detail |
|---|---|
| Paradigm | Supervised binary classification (machine failure) + optional multi-label (per-mode) |
| Class imbalance | 3.39 % positive → use `class_weight='balanced'` or SMOTE |
| Primary metrics | F1-score (macro), per-mode recall (especially HDF at 1.15 %) |
| Features | All 5 process signals + derived power; exclude all `Status/*` tags |
| Training split | Time-ordered 80/20; no random shuffle (avoid data leakage at wrap) |

---

## 5. Asset A2 — Hydraulic test rig (ZeMA condition monitoring)

**Source dataset**: `condition+monitoring+of+hydraulic+systems/` — 17 `.txt` files + `profile.txt`  
**Cycles**: 2,205 load cycles, 60 s each (constant load profile)  
**Replay model**: cycle-based — one cycle at 1 Hz (60 samples), then advance  
**Replay speed**: × 1.0 (default)  
**Dataset reference**: Helwig, N. et al. (2015). ZeMA hydraulic condition monitoring. UCI ML Repository.

### 5.1 Sensor signals

#### Pressure sensors (source: 100 Hz → published: 1 Hz mean per second)

| Tag path | Physical quantity | Unit | Min | Max | Mean | Std | Notes |
|---|---|---|---|---|---|---|---|
| `Hydraulic/PS1_bar` | System supply pressure | bar | 133.1 | 191.9 | 160.5 | 16.1 | Main working circuit |
| `Hydraulic/PS2_bar` | Downstream pressure | bar | 0.0 | 167.8 | 109.4 | 48.1 | Varies with valve state |
| `Hydraulic/PS3_bar` | Return pressure | bar | 0.0 | 18.8 | 1.8 | 0.9 | Near zero when valve closed |
| `Hydraulic/PS4_bar` | Accumulator side pressure | bar | 0.0 | 10.3 | 2.6 | 4.3 | Bimodal with accumulator state |
| `Hydraulic/PS5_bar` | Cooling circuit pressure | bar | 8.3 | 10.0 | 9.2 | 0.6 | Narrow range |
| `Hydraulic/PS6_bar` | Cooling circuit pressure 2 | bar | 8.3 | 9.9 | 9.1 | 0.6 | Narrow range |

#### Flow sensors (source: 10 Hz → published: 1 Hz mean per second)

| Tag path | Physical quantity | Unit | Min | Max | Mean | Std | Notes |
|---|---|---|---|---|---|---|---|
| `Hydraulic/Flow1_lpm` | Volume flow (primary) | l/min | 0.0 | 20.5 | 6.2 | 3.2 | Intermittent; zero when pump idle |
| `Hydraulic/Flow2_lpm` | Volume flow (cooling) | l/min | 8.8 | 10.5 | 9.7 | 0.5 | Continuous cooling loop |

#### Power and vibration sensors (source: 100 Hz / 1 Hz → published: 1 Hz)

| Tag path | Physical quantity | Unit | Source rate | Min | Max | Mean | Std | Notes |
|---|---|---|---|---|---|---|---|---|
| `Motor/Power_W` | Motor power | W | 100 Hz | 2097.8 | 2995.2 | 2495.5 | 218.2 | PLC overload alarm at > 2,900 W |
| `Motor/Vibration_mms` | Motor vibration (RMS) | mm/s | 1 Hz | 0.5 | 2.6 | 0.6 | 0.1 | PLC alarm at > 0.8 mm/s |

#### Temperature sensors (source: 1 Hz → published: 1 Hz)

| Tag path | Physical quantity | Unit | Min | Max | Mean | Std | Notes |
|---|---|---|---|---|---|---|---|
| `Thermal/TS1_C` | Tank temperature | °C | 35.0 | 58.2 | 45.4 | 8.0 | Rises with poor cooler efficiency |
| `Thermal/TS2_C` | Return line temperature | °C | 40.7 | 62.2 | 50.4 | 7.4 | — |
| `Thermal/TS3_C` | Pump outlet temperature | °C | 38.2 | 59.5 | 47.7 | 7.5 | — |
| `Thermal/TS4_C` | Cooler outlet temperature | °C | 30.4 | 53.2 | 40.7 | 8.1 | Differential TS1−TS4 sensitive to cooler state |

#### KPI signals — virtual (derived, 1 Hz)

| Tag path | Physical quantity | Unit | Min | Max | Mean | Std | Notes |
|---|---|---|---|---|---|---|---|
| `KPIs/CoolingEfficiency_pct` | Cooling efficiency | % | 17.0 | 48.8 | 31.3 | 11.6 | PLC alarm at < 30 %; degrades with cooler condition |
| `KPIs/CoolingPower_kW` | Cooling power | kW | 1.0 | 2.9 | 1.8 | 0.3 | — |
| `KPIs/EfficiencyFactor_pct` | Hydraulic efficiency | % | 0.0 | 100.6 | 55.3 | 25.6 | Wide range; valve condition dependent |

### 5.2 Condition / ground-truth tags

> Same policy as A1 `Status/*` — dataset labels, not sensor readings.

| Tag path | Component | OPC UA type | Levels (dataset values) | Interpretation |
|---|---|---|---|---|
| `Condition/CoolerCondition_pct` | Heat exchanger | Int64 | 3 · 20 · 100 | 100 = full efficiency; 3 = near failure |
| `Condition/ValveCondition_pct` | Proportional valve | Int64 | 73 · 80 · 90 · 100 | 100 = optimal; 73 = near failure |
| `Condition/PumpLeakage` | Hydraulic pump | Int64 | 0 · 1 · 2 | 0 = no leakage; 2 = severe leakage |
| `Condition/AccumulatorPressure_bar` | Hydraulic accumulator | Int64 | 90 · 100 · 115 · 130 | 130 = optimal; 90 = near failure |
| `Condition/StableFlag` | Cycle stability | Boolean | 0 · 1 | 1 = conditions possibly not yet reached |

### 5.3 Simulation tags

| Tag path | Type | Description |
|---|---|---|
| `Simulation/CycleIndex` | Int64 | Cycle number 0–2204, wraps |
| `Simulation/CycleSecond` | Int64 | Second within cycle, 0–59 |
| `Simulation/SpeedFactor` | Double | 1.0 (inherited) |

### 5.4 Replay and sampling decisions

| Decision | Value | Rationale |
|---|---|---|
| Source rate (pressure/power) | 100 Hz | Raw dataset; 6,000 samples / cycle |
| Source rate (flow) | 10 Hz | Raw dataset; 600 samples / cycle |
| Source rate (temperature, KPIs) | 1 Hz | Raw dataset; 60 samples / cycle |
| Published rate | 1 Hz (mean per second) | MQTT/UNS bandwidth; 100 Hz × 17 sensors = 1.7 M values/cycle is impractical |
| Offline storage | 100 Hz raw files untouched | Available for feature extraction during ML training (Phase 5) |
| Preprocessing artifact | `sim/data/a2_1hz.npz` | Created by `python -m sim.tools.prepare_a2` |
| Condition label publish | Start of each cycle | Labels change per cycle, not per second |

### 5.5 ML task summary

| Aspect | Detail |
|---|---|
| Paradigm | Multi-target condition monitoring (4 independent classifiers) |
| Strategy | Cycle-level feature extraction (mean, std, max per sensor) → gradient boosting |
| Primary metrics | Per-target accuracy, macro-F1 |
| Features | All 17 sensor signals (1 Hz); exclude all `Condition/*` tags |
| Training split | Cycle-ordered 80/20 split |

---

## 6. Asset A3 — Metro APU air compressor (MetroPT-3)

**Source dataset**: `metropt+3+dataset/MetroPT3(AirCompressor).csv`  
**Rows**: 1,516,948 (~1 Hz, with gaps)  
**Date range**: 2020-02-01 to 2020-09-01 (7 months)  
**Replay model**: timestamp-paced stream (inter-row Δt from timestamps, gaps clamped)  
**Replay speed**: × 60 (default) — 7 months replays in ~84 hours  
**Dataset reference**: Veloso, B. et al. (2022). MetroPT-3 dataset. Porto Metro fleet.

### 6.1 Analogue signals

| Tag path | Physical quantity | Unit | Min | Max | Mean | Notes |
|---|---|---|---|---|---|---|
| `Pneumatic/TP2_bar` | Compressor inlet pressure (after unloader valve) | bar | −0.03 | 10.5 | 0.53 | Near 0 when compressor idle; rises to ~10 bar under load |
| `Pneumatic/TP3_bar` | Compressor delivery pressure | bar | 7.3 | 10.2 | 8.96 | Sustained by reservoir; LPS alarm when < 7 bar |
| `Pneumatic/H1_bar` | Pressure upstream of drying towers | bar | −0.03 | 10.2 | 8.40 | Similar range to TP3 |
| `Pneumatic/DVPressure_bar` | Differential pressure across DV valve | bar | −0.03 | 6.53 | −0.02 | Near zero at rest; pulses during valve switching |
| `Pneumatic/Reservoirs_bar` | Main reservoir pressure | bar | 7.3 | 10.2 | 8.96 | Primary air supply; monitored for air-leak anomaly |
| `Motor/Current_A` | Compressor motor current | A | 0.02 | 8.29 | 1.23 | 4-level signature: ≈0 A idle · ≈4 A offload · ≈7 A load · ≈9 A peak |
| `Oil/Temperature_C` | Compressor oil temperature | °C | 32.0 | 69.2 | 56.4 | Rises progressively; PLC alarm at > 65 °C |

> **Note on `DV_eletric` column**: the source CSV contains a misspelling
> (`DV_eletric` instead of `DV_electric`). The simulator reads the column
> under its original misspelled name and maps it to the corrected tag
> `Digital/DVElectric`. This discrepancy is documented here to prevent
> confusion when cross-referencing raw data.

### 6.2 Digital signals

All digital signals are Boolean (0.0 / 1.0 in the CSV, cast to `bool` in OPC UA).

| Tag path | Physical quantity | Active (1) means | Notes |
|---|---|---|---|
| `Digital/COMP` | Compressor run status | Compressor is running | Main load/unload cycle indicator |
| `Digital/DVElectric` | DV solenoid valve electrical state | Valve energised | Correlated with COMP |
| `Digital/Towers` | Drying tower switching | Tower B active (regeneration cycle) | Alternates ~every 30 s |
| `Digital/MPG` | Motor protection relay | Protection relay tripped | Alarm condition |
| `Digital/LPS` | Low-pressure switch | System pressure < 7 bar | PLC `LowPressure` alarm input |
| `Digital/PressureSwitch` | Pressure switch (high-side) | Pressure within normal band | Deasserted on high pressure |
| `Digital/OilLevel` | Oil level switch | Oil level sufficient | 1 = OK in healthy operation |
| `Digital/CaudalImpulses` | Flow meter pulse | Pulse from flow meter | 1 = nominal flow detected |

> **Observation**: in the first 200,000-row sample, `Oil_level` and
> `Caudal_impulses` hold constant value 1 (normal state). They may transition
> during the failure windows and must be included in anomaly detection features.

### 6.3 Failure windows (ground truth — unlabelled stream)

The CSV contains no label column. Failures are documented externally in the
MetroPT-3 paper. They are encoded in the simulator via `Simulation/SourceTimestamp`
so downstream anomaly detectors can evaluate their predictions against these windows.

| # | Start | End | Type | Duration | Key observable |
|---|---|---|---|---|---|
| 1 | 2020-04-18 | 2020-04-18 | Air leak | ~1 day | Reservoir pressure drop, increased compressor duty cycle |
| 2 | 2020-05-29 | 2020-05-30 | Air leak | ~1 day | As above |
| 3 | 2020-06-05 | 2020-06-07 | Air leak | ~2 days | As above, longer duration |
| 4 | 2020-07-15 | 2020-07-15 | Air leak | ~1 day | As above |

### 6.4 Simulation tags

| Tag path | Type | Description |
|---|---|---|
| `Simulation/RowIndex` | Int64 | Original CSV row index (0-based step of 10) |
| `Simulation/SourceTimestamp` | String | ISO-8601 timestamp from the CSV; key for failure window alignment |
| `Simulation/SpeedFactor` | Double | 60.0 (default; configurable via `--speed`) |

### 6.5 Replay and sampling decisions

| Decision | Value | Rationale |
|---|---|---|
| Native rate | ~1 Hz (irregular) | Timestamps show ~10-index steps ≈ 1 Hz; some gaps from parking/downtime |
| Gap clamp | 60 s | `A3_MAX_GAP_S = 60` — prevents stall during long parking periods (some gaps > 1 h) |
| Replay speed | 60× (default) | 7 months / 60 ≈ 84 hours; failure windows appear ~17 min apart in real time |
| Replay speed (fast demo) | 600× | 7 months in ~8.4 hours; anomalies visible in ~100 s |
| Memory strategy | 20,000-row chunks | 1.5 M rows × 17 columns flat would require ~200 MB; chunked keeps it < 10 MB |

### 6.6 ML task summary

| Aspect | Detail |
|---|---|
| Paradigm | Unsupervised anomaly detection + RUL estimation |
| Strategy | Sliding-window (e.g. 60 s / 5 min) → autoencoder reconstruction error or Isolation Forest |
| Validation | Anomaly scores compared against 4 known air-leak windows (precision/recall on temporal segments) |
| RUL | Time-to-next-failure regression from window features; limited by 4 labelled events |
| Features | All 7 analogue signals + COMP duty cycle; digital signals as auxiliary features |

---

## 7. PLC-derived tags (supervisory layer)

The supervisory PLC (`sim/plc.py`, `docs/plc-spec.md`) computes these tags from
process measurements only. They are served on `opc.tcp://<host>:4840/jesa/plc`
under namespace `urn:jesa:plc`. Full definition in `docs/plc-spec.md`; summary here.

| Tag path (PLC) | Derived from | Type | Threshold |
|---|---|---|---|
| `A1/Power_kW` | Torque × speed × 2π/60 ÷ 1000 | Double | — |
| `A1/PowerOutOfRange` | Power | Boolean | < 3,500 W OR > 9,000 W |
| `A1/HeatDissipationRisk` | ΔT, speed | Boolean | ΔT < 8.6 K AND speed < 1,380 rpm |
| `A1/Overstrain` | Wear × torque | Boolean | > 11,000 (L) / 12,000 (M) / 13,000 (H) min·N·m |
| `A1/ToolWearHigh` | Tool wear | Boolean | ≥ 200 min |
| `A1/StopCommand` | Logic OR | Boolean | Safe state output |
| `A2/CoolingDegraded` | Cooling efficiency | Boolean | < 30 % |
| `A2/MotorOverload` | Motor power | Boolean | > 2,900 W |
| `A2/VibrationHigh` | Vibration | Boolean | > 0.8 mm/s |
| `A2/MaintenanceRequired` | Logic OR | Boolean | Maintenance gate |
| `A3/CompressorRunning` | Motor current | Boolean | > 5.5 A |
| `A3/LowPressure` | LPS digital + TP3 | Boolean | LPS active OR TP3 < 7.0 bar |
| `A3/OilTempHigh` | Oil temperature | Boolean | > 65 °C |
| `A3/OilLevelLow` | Oil level switch | Boolean | Switch deasserted |
| `A3/AirSupplyOk` | Logic AND-NOT | Boolean | NOT LowPressure AND NOT CommFault |
| `<asset>/CommFault` | Staleness watchdog | Boolean | Input image > 5 s stale |

---

## 8. Ground-truth tag policy

A clear boundary between **sensor signals** and **dataset labels** is critical
for a valid ML evaluation. This platform enforces the following rule:

> **Ground-truth tags** (`A1/Status/*`, `A2/Condition/*`, and the A3 failure
> window timestamps) are published on the OPC UA servers for visualization and
> model evaluation only. They represent dataset annotations, not physical sensor
> readings. They must never be used as input features in any ML model, and the
> PLC must never read them for interlock decisions.

The PLC interlock logic independently recreates equivalent alarm conditions from
process measurements (see §7). This allows:

1. Validation: compare PLC-derived alarms against dataset ground truth.
2. Fair ML evaluation: predictions are compared against labels that the model
   has never seen during training.

---

## 9. UNS topic hierarchy preview (Phase 4)

The Phase 4 gateway will derive MQTT topics from the OPC UA tag paths using the
ISA-95 enterprise hierarchy as prefix. The mapping convention is:

```
jesa/                       ← Enterprise
  site1/                    ← Site
    {area}/                 ← Area (workshop / fleet)
      {asset_id}/           ← Work unit
        {Folder}/           ← Physical subsystem
          {Name}            ← Signal
```

Example mappings:

| OPC UA path | MQTT topic |
|---|---|
| `A1/Drive/Torque_Nm` | `jesa/site1/workshop/milling/A1/drive/torque_nm` |
| `A2/Hydraulic/PS1_bar` | `jesa/site1/workshop/hydraulics/A2/hydraulic/ps1_bar` |
| `A3/Pneumatic/Reservoirs_bar` | `jesa/site1/fleet/apu/A3/pneumatic/reservoirs_bar` |
| `A3/Digital/LPS` | `jesa/site1/fleet/apu/A3/digital/lps` |
| `PLC/A1/StopCommand` | `jesa/site1/workshop/milling/A1/plc/stop_command` |

Topic naming convention: all lowercase, underscores preserved from tag names.
The Sparkplug B vs. plain JSON payload decision remains open (see ROADMAP.md §5 risk 3).

---

## 10. Revision history

| Rev | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-07-13 | Phase 2 | Initial release; all values validated against raw datasets |
