# PLC logic specification

Supervisory logic controller for assets A1, A2, A3 (ROADMAP.md Phase 3b).
This specification is implementation-independent: the reference
implementation is `sim/plc.py` (Python), and the same document ports the
logic to an IEC 61131-3 environment (CODESYS Structured Text) without any
change visible to downstream consumers (gateway, UNS).

## 1. Role and boundaries

The controller consumes the three asset OPC UA servers as a client, executes
interlock and supervision logic on a fixed scan cycle, and re-exposes a
consolidated tag image on its own OPC UA server. It does not command
actuators (the assets are dataset replays); its outputs are alarm bits,
stop/maintenance commands and mirrored process values.

Ground-truth rule: the dataset label tags (`A1 Status/*`, `A2 Condition/*`)
are **never read by the controller**. All alarms below are computed from
process measurements only, so they can later be compared against the ground
truth for validation.

## 2. Runtime parameters

| Parameter | Value | Note |
|---|---|---|
| Scan period | 500 ms | fixed cycle: read input image, execute, write outputs |
| Input poll period | 500 ms | one asynchronous poller per asset |
| Staleness watchdog | 5 s | input image older than this -> CommFault |
| Reconnect backoff | 3 s | per asset, indefinitely |
| OPC UA endpoint | `opc.tcp://<host>:4840/jesa/plc` | namespace `urn:jesa:plc` |

On CommFault of an asset, all computed alarms of that asset are forced to
FALSE (unknown, not asserted), CommFault is raised, and dependent safe-state
commands (A1 StopCommand) are asserted.

## 3. Input image

| Signal | Source (asset server node) | Type | Unit |
|---|---|---|---|
| A1 torque | `A1 Drive/Torque_Nm` | f64 | Nm |
| A1 speed | `A1 Drive/RotationalSpeed_rpm` | f64 | rpm |
| A1 air temperature | `A1 Process/AirTemperature_K` | f64 | K |
| A1 process temperature | `A1 Process/ProcessTemperature_K` | f64 | K |
| A1 tool wear | `A1 Tool/ToolWear_min` | i64 | min |
| A1 product type | `A1 Part/ProductType` | str | L/M/H |
| A2 system pressure | `A2 Hydraulic/PS1_bar` | f64 | bar |
| A2 motor power | `A2 Motor/Power_W` | f64 | W |
| A2 vibration | `A2 Motor/Vibration_mms` | f64 | mm/s |
| A2 cooling efficiency | `A2 KPIs/CoolingEfficiency_pct` | f64 | % |
| A3 panel pressure | `A3 Pneumatic/TP3_bar` | f64 | bar |
| A3 reservoir pressure | `A3 Pneumatic/Reservoirs_bar` | f64 | bar |
| A3 motor current | `A3 Motor/Current_A` | f64 | A |
| A3 oil temperature | `A3 Oil/Temperature_C` | f64 | degC |
| A3 LPS | `A3 Digital/LPS` | bool | - |
| A3 oil level switch | `A3 Digital/OilLevel` | bool | - |

## 4. Logic

### A1 - Milling machine

Derived quantity: mechanical power `P [W] = torque x speed x 2*pi / 60`.

| Output | Equation | Threshold provenance |
|---|---|---|
| `A1/Power_kW` | P / 1000 | - |
| `A1/PowerOutOfRange` | P < 3500 W OR P > 9000 W | AI4I PWF definition |
| `A1/HeatDissipationRisk` | (Tproc - Tair) < 8.6 K AND speed < 1380 rpm | AI4I HDF definition |
| `A1/Overstrain` | wear x torque > limit(type); L=11000, M=12000, H=13000 minNm | AI4I OSF definition |
| `A1/ToolWearHigh` | wear >= 200 min (tool change request) | AI4I TWF window 200-240 min |
| `A1/StopCommand` | Overstrain OR PowerOutOfRange OR HeatDissipationRisk OR CommFault | safe state |

### A2 - Hydraulic test rig

Thresholds marked (C) are commissioning parameters, set from the healthy
baseline of the ZeMA dataset; they are constants in the implementation and
must be revisited against plant data.

| Output | Equation |
|---|---|
| `A2/CoolingDegraded` | cooling efficiency < 30 % (C) |
| `A2/MotorOverload` | motor power > 2900 W (C) |
| `A2/VibrationHigh` | vibration > 0.8 mm/s (C) |
| `A2/MaintenanceRequired` | CoolingDegraded OR MotorOverload OR VibrationHigh |

### A3 - APU air compressor

| Output | Equation | Threshold provenance |
|---|---|---|
| `A3/CompressorRunning` | motor current > 5.5 A | MetroPT-3: 7 A under load, 4 A offloaded |
| `A3/LowPressure` | LPS active OR panel pressure < 7.0 bar | LPS setpoint (dataset doc) |
| `A3/OilTempHigh` | oil temperature > 65 degC (C) | |
| `A3/OilLevelLow` | oil level switch active | switch semantics (dataset doc) |
| `A3/AirSupplyOk` | NOT LowPressure AND NOT CommFault | |

### System

| Output | Equation |
|---|---|
| `System/Mode` | constant "RUN" |
| `System/ScanCount` | increments each scan |
| `System/ScanTimeMs` | execution time of the last scan |
| `System/ActiveAlarms` | count of TRUE alarm bits (all `*Fault`, `*High`, `*Degraded`, `*Overload`, `Overstrain`, `PowerOutOfRange`, `HeatDissipationRisk`, `LowPressure`, `OilLevelLow`) |
| `<asset>/CommFault` | input image stale (> 5 s) or disconnected |

Alarm transitions (rising and falling edges) are logged with timestamps.

Known limitation: analog alarm thresholds currently have no hysteresis or
on-delay, so values sitting near a threshold (observed with A2 motor power
around 2900 W) can chatter. Planned improvement: 2 % hysteresis band or a
2-scan on-delay per analog alarm.

## 5. Output image (OPC UA server, namespace `urn:jesa:plc`)

```
PLC
├─ System   Mode (str) · ScanCount (i64) · ScanTimeMs (f64) · ActiveAlarms (i64)
├─ A1       CommFault · Torque_Nm · Speed_rpm · ToolWear_min · Power_kW
│           ToolWearHigh · Overstrain · PowerOutOfRange · HeatDissipationRisk · StopCommand
├─ A2       CommFault · SystemPressure_bar · MotorPower_W · Vibration_mms · CoolingEfficiency_pct
│           CoolingDegraded · MotorOverload · VibrationHigh · MaintenanceRequired
└─ A3       CommFault · PanelPressure_bar · ReservoirPressure_bar · MotorCurrent_A · OilTemperature_C
            CompressorRunning · LowPressure · OilTempHigh · OilLevelLow · AirSupplyOk
```

Mirrored process values are republished so the Phase 4 gateway can build the
UNS from the single PLC endpoint instead of subscribing to three field
servers.
