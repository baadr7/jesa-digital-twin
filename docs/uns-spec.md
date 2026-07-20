# UNS Specification — Unified Namespace for the JESA Digital Twin Platform

**Document reference**: JESA-DT-UNS-001  
**Revision**: 1.0  
**Date**: 2026-07-13  
**Phase**: 4 — Création de l'UNS  
**Status**: Active — governs gateway implementation and downstream consumers

---

## 1. Purpose

The Unified Namespace (UNS) is the central data backbone of the JESA Digital
Twin platform. It replaces point-to-point OPC UA polling with a
publish-subscribe message bus where every data consumer — dashboards, ML
services, historians, 3D viewers — reads from a single, canonical topic tree.

This document specifies:

1. the MQTT topic hierarchy (ISA-95 aligned);
2. the JSON payload schema for every message;
3. quality-of-service (QoS) and retention policies;
4. the mapping from OPC UA browse paths to MQTT topics.

It governs:

- the Python gateway (`uns/gateway.py`);
- the Telegraf MQTT consumer configuration;
- all Phase 5 consumers (Grafana, ML services, Three.js viewer).

---

## 2. Transport layer

| Parameter | Value | Rationale |
|---|---|---|
| Broker | Eclipse Mosquitto 2.x | Lightweight, production-proven, WebSocket support |
| MQTT version | v5.0 (fallback v3.1.1) | Session expiry, shared subscriptions for Phase 5 |
| TCP listener | `0.0.0.0:1883` | Standard MQTT port |
| WebSocket listener | `0.0.0.0:9001` | For browser-based consumers (Three.js, Grafana live) |
| Authentication | Anonymous (development) | Production: username/password or TLS client certificates |
| Max message size | 1 MB | Default; sufficient for JSON telemetry |

---

## 3. Topic hierarchy

### 3.1 Structure

The topic tree follows the ISA-95 / IEC 62264 hierarchical model:

```
{enterprise}/{site}/{area}/{asset_type}/{asset_id}/{folder}/{tag_name}
```

Concrete prefix for this platform:

```
jesa/site1/{area}/{asset_id}/{folder}/{tag_name}
```

### 3.2 Area assignment

| Asset | Area | Rationale |
|---|---|---|
| A1 Milling machine | `workshop/milling` | Manufacturing workshop, machining cell |
| A2 Hydraulic rig | `workshop/hydraulics` | Manufacturing workshop, hydraulic test cell |
| A3 APU compressor | `fleet/apu` | Rolling stock fleet, auxiliary power unit |
| PLC | `plc` | Supervisory layer, spans all areas |

### 3.3 Complete topic tree

#### A1 — Milling Machine

| MQTT Topic | OPC UA Source | Type | Unit | Retained |
|---|---|---|---|---|
| `jesa/site1/workshop/milling/A1/identification/asset_id` | `A1 Identification/AssetId` | String | — | Yes |
| `jesa/site1/workshop/milling/A1/identification/description` | `A1 Identification/Description` | String | — | Yes |
| `jesa/site1/workshop/milling/A1/drive/torque_nm` | `A1 Drive/Torque_Nm` | Double | Nm | No |
| `jesa/site1/workshop/milling/A1/drive/rotational_speed_rpm` | `A1 Drive/RotationalSpeed_rpm` | Double | rpm | No |
| `jesa/site1/workshop/milling/A1/process/air_temperature_k` | `A1 Process/AirTemperature_K` | Double | K | No |
| `jesa/site1/workshop/milling/A1/process/process_temperature_k` | `A1 Process/ProcessTemperature_K` | Double | K | No |
| `jesa/site1/workshop/milling/A1/tool/tool_wear_min` | `A1 Tool/ToolWear_min` | Int64 | min | No |
| `jesa/site1/workshop/milling/A1/part/product_id` | `A1 Part/ProductId` | String | — | No |
| `jesa/site1/workshop/milling/A1/part/product_type` | `A1 Part/ProductType` | String | — | No |
| `jesa/site1/workshop/milling/A1/status/machine_failure` | `A1 Status/MachineFailure` | Boolean | — | No |
| `jesa/site1/workshop/milling/A1/status/twf` | `A1 Status/TWF` | Boolean | — | No |
| `jesa/site1/workshop/milling/A1/status/hdf` | `A1 Status/HDF` | Boolean | — | No |
| `jesa/site1/workshop/milling/A1/status/pwf` | `A1 Status/PWF` | Boolean | — | No |
| `jesa/site1/workshop/milling/A1/status/osf` | `A1 Status/OSF` | Boolean | — | No |
| `jesa/site1/workshop/milling/A1/status/rnf` | `A1 Status/RNF` | Boolean | — | No |
| `jesa/site1/workshop/milling/A1/simulation/part_index` | `A1 Simulation/PartIndex` | Int64 | — | No |
| `jesa/site1/workshop/milling/A1/simulation/speed_factor` | `A1 Simulation/SpeedFactor` | Double | — | Yes |

#### A2 — Hydraulic Test Rig

| MQTT Topic | OPC UA Source | Type | Unit | Retained |
|---|---|---|---|---|
| `jesa/site1/workshop/hydraulics/A2/identification/asset_id` | `A2 Identification/AssetId` | String | — | Yes |
| `jesa/site1/workshop/hydraulics/A2/identification/description` | `A2 Identification/Description` | String | — | Yes |
| `jesa/site1/workshop/hydraulics/A2/hydraulic/ps1_bar` | `A2 Hydraulic/PS1_bar` | Double | bar | No |
| `jesa/site1/workshop/hydraulics/A2/hydraulic/ps2_bar` | `A2 Hydraulic/PS2_bar` | Double | bar | No |
| `jesa/site1/workshop/hydraulics/A2/hydraulic/ps3_bar` | `A2 Hydraulic/PS3_bar` | Double | bar | No |
| `jesa/site1/workshop/hydraulics/A2/hydraulic/ps4_bar` | `A2 Hydraulic/PS4_bar` | Double | bar | No |
| `jesa/site1/workshop/hydraulics/A2/hydraulic/ps5_bar` | `A2 Hydraulic/PS5_bar` | Double | bar | No |
| `jesa/site1/workshop/hydraulics/A2/hydraulic/ps6_bar` | `A2 Hydraulic/PS6_bar` | Double | bar | No |
| `jesa/site1/workshop/hydraulics/A2/hydraulic/flow1_lpm` | `A2 Hydraulic/Flow1_lpm` | Double | l/min | No |
| `jesa/site1/workshop/hydraulics/A2/hydraulic/flow2_lpm` | `A2 Hydraulic/Flow2_lpm` | Double | l/min | No |
| `jesa/site1/workshop/hydraulics/A2/motor/power_w` | `A2 Motor/Power_W` | Double | W | No |
| `jesa/site1/workshop/hydraulics/A2/motor/vibration_mms` | `A2 Motor/Vibration_mms` | Double | mm/s | No |
| `jesa/site1/workshop/hydraulics/A2/kpis/cooling_efficiency_pct` | `A2 KPIs/CoolingEfficiency_pct` | Double | % | No |
| `jesa/site1/workshop/hydraulics/A2/kpis/cooling_power_kw` | `A2 KPIs/CoolingPower_kW` | Double | kW | No |
| `jesa/site1/workshop/hydraulics/A2/kpis/efficiency_factor_pct` | `A2 KPIs/EfficiencyFactor_pct` | Double | % | No |
| `jesa/site1/workshop/hydraulics/A2/thermal/ts1_c` | `A2 Thermal/TS1_C` | Double | °C | No |
| `jesa/site1/workshop/hydraulics/A2/thermal/ts2_c` | `A2 Thermal/TS2_C` | Double | °C | No |
| `jesa/site1/workshop/hydraulics/A2/thermal/ts3_c` | `A2 Thermal/TS3_C` | Double | °C | No |
| `jesa/site1/workshop/hydraulics/A2/thermal/ts4_c` | `A2 Thermal/TS4_C` | Double | °C | No |
| `jesa/site1/workshop/hydraulics/A2/condition/cooler_condition_pct` | `A2 Condition/CoolerCondition_pct` | Int64 | % | No |
| `jesa/site1/workshop/hydraulics/A2/condition/valve_condition_pct` | `A2 Condition/ValveCondition_pct` | Int64 | % | No |
| `jesa/site1/workshop/hydraulics/A2/condition/pump_leakage` | `A2 Condition/PumpLeakage` | Int64 | — | No |
| `jesa/site1/workshop/hydraulics/A2/condition/accumulator_pressure_bar` | `A2 Condition/AccumulatorPressure_bar` | Int64 | bar | No |
| `jesa/site1/workshop/hydraulics/A2/condition/stable_flag` | `A2 Condition/StableFlag` | Boolean | — | No |
| `jesa/site1/workshop/hydraulics/A2/simulation/cycle_index` | `A2 Simulation/CycleIndex` | Int64 | — | No |
| `jesa/site1/workshop/hydraulics/A2/simulation/cycle_second` | `A2 Simulation/CycleSecond` | Int64 | — | No |
| `jesa/site1/workshop/hydraulics/A2/simulation/speed_factor` | `A2 Simulation/SpeedFactor` | Double | — | Yes |

#### A3 — APU Air Compressor

| MQTT Topic | OPC UA Source | Type | Unit | Retained |
|---|---|---|---|---|
| `jesa/site1/fleet/apu/A3/identification/asset_id` | `A3 Identification/AssetId` | String | — | Yes |
| `jesa/site1/fleet/apu/A3/identification/description` | `A3 Identification/Description` | String | — | Yes |
| `jesa/site1/fleet/apu/A3/pneumatic/tp2_bar` | `A3 Pneumatic/TP2_bar` | Double | bar | No |
| `jesa/site1/fleet/apu/A3/pneumatic/tp3_bar` | `A3 Pneumatic/TP3_bar` | Double | bar | No |
| `jesa/site1/fleet/apu/A3/pneumatic/h1_bar` | `A3 Pneumatic/H1_bar` | Double | bar | No |
| `jesa/site1/fleet/apu/A3/pneumatic/dv_pressure_bar` | `A3 Pneumatic/DVPressure_bar` | Double | bar | No |
| `jesa/site1/fleet/apu/A3/pneumatic/reservoirs_bar` | `A3 Pneumatic/Reservoirs_bar` | Double | bar | No |
| `jesa/site1/fleet/apu/A3/motor/current_a` | `A3 Motor/Current_A` | Double | A | No |
| `jesa/site1/fleet/apu/A3/oil/temperature_c` | `A3 Oil/Temperature_C` | Double | °C | No |
| `jesa/site1/fleet/apu/A3/digital/comp` | `A3 Digital/COMP` | Boolean | — | No |
| `jesa/site1/fleet/apu/A3/digital/dv_electric` | `A3 Digital/DVElectric` | Boolean | — | No |
| `jesa/site1/fleet/apu/A3/digital/towers` | `A3 Digital/Towers` | Boolean | — | No |
| `jesa/site1/fleet/apu/A3/digital/mpg` | `A3 Digital/MPG` | Boolean | — | No |
| `jesa/site1/fleet/apu/A3/digital/lps` | `A3 Digital/LPS` | Boolean | — | No |
| `jesa/site1/fleet/apu/A3/digital/pressure_switch` | `A3 Digital/PressureSwitch` | Boolean | — | No |
| `jesa/site1/fleet/apu/A3/digital/oil_level` | `A3 Digital/OilLevel` | Boolean | — | No |
| `jesa/site1/fleet/apu/A3/digital/caudal_impulses` | `A3 Digital/CaudalImpulses` | Boolean | — | No |
| `jesa/site1/fleet/apu/A3/simulation/row_index` | `A3 Simulation/RowIndex` | Int64 | — | No |
| `jesa/site1/fleet/apu/A3/simulation/source_timestamp` | `A3 Simulation/SourceTimestamp` | String | — | No |
| `jesa/site1/fleet/apu/A3/simulation/speed_factor` | `A3 Simulation/SpeedFactor` | Double | — | Yes |

#### PLC — Supervisory Controller

| MQTT Topic | OPC UA Source | Type | Retained |
|---|---|---|---|
| `jesa/site1/plc/system/mode` | `PLC System/Mode` | String | Yes |
| `jesa/site1/plc/system/scan_count` | `PLC System/ScanCount` | Int64 | No |
| `jesa/site1/plc/system/scan_time_ms` | `PLC System/ScanTimeMs` | Double | No |
| `jesa/site1/plc/system/active_alarms` | `PLC System/ActiveAlarms` | Int64 | No |
| `jesa/site1/plc/a1/comm_fault` | `PLC A1/CommFault` | Boolean | No |
| `jesa/site1/plc/a1/torque_nm` | `PLC A1/Torque_Nm` | Double | No |
| `jesa/site1/plc/a1/speed_rpm` | `PLC A1/Speed_rpm` | Double | No |
| `jesa/site1/plc/a1/tool_wear_min` | `PLC A1/ToolWear_min` | Int64 | No |
| `jesa/site1/plc/a1/power_kw` | `PLC A1/Power_kW` | Double | No |
| `jesa/site1/plc/a1/tool_wear_high` | `PLC A1/ToolWearHigh` | Boolean | No |
| `jesa/site1/plc/a1/overstrain` | `PLC A1/Overstrain` | Boolean | No |
| `jesa/site1/plc/a1/power_out_of_range` | `PLC A1/PowerOutOfRange` | Boolean | No |
| `jesa/site1/plc/a1/heat_dissipation_risk` | `PLC A1/HeatDissipationRisk` | Boolean | No |
| `jesa/site1/plc/a1/stop_command` | `PLC A1/StopCommand` | Boolean | No |
| `jesa/site1/plc/a2/comm_fault` | `PLC A2/CommFault` | Boolean | No |
| `jesa/site1/plc/a2/system_pressure_bar` | `PLC A2/SystemPressure_bar` | Double | No |
| `jesa/site1/plc/a2/motor_power_w` | `PLC A2/MotorPower_W` | Double | No |
| `jesa/site1/plc/a2/vibration_mms` | `PLC A2/Vibration_mms` | Double | No |
| `jesa/site1/plc/a2/cooling_efficiency_pct` | `PLC A2/CoolingEfficiency_pct` | Double | No |
| `jesa/site1/plc/a2/cooling_degraded` | `PLC A2/CoolingDegraded` | Boolean | No |
| `jesa/site1/plc/a2/motor_overload` | `PLC A2/MotorOverload` | Boolean | No |
| `jesa/site1/plc/a2/vibration_high` | `PLC A2/VibrationHigh` | Boolean | No |
| `jesa/site1/plc/a2/maintenance_required` | `PLC A2/MaintenanceRequired` | Boolean | No |
| `jesa/site1/plc/a3/comm_fault` | `PLC A3/CommFault` | Boolean | No |
| `jesa/site1/plc/a3/panel_pressure_bar` | `PLC A3/PanelPressure_bar` | Double | No |
| `jesa/site1/plc/a3/reservoir_pressure_bar` | `PLC A3/ReservoirPressure_bar` | Double | No |
| `jesa/site1/plc/a3/motor_current_a` | `PLC A3/MotorCurrent_A` | Double | No |
| `jesa/site1/plc/a3/oil_temperature_c` | `PLC A3/OilTemperature_C` | Double | No |
| `jesa/site1/plc/a3/compressor_running` | `PLC A3/CompressorRunning` | Boolean | No |
| `jesa/site1/plc/a3/low_pressure` | `PLC A3/LowPressure` | Boolean | No |
| `jesa/site1/plc/a3/oil_temp_high` | `PLC A3/OilTempHigh` | Boolean | No |
| `jesa/site1/plc/a3/oil_level_low` | `PLC A3/OilLevelLow` | Boolean | No |
| `jesa/site1/plc/a3/air_supply_ok` | `PLC A3/AirSupplyOk` | Boolean | No |

---

## 4. Payload schema

Every MQTT message carries a self-describing JSON payload:

```json
{
  "ts": "2026-07-13T14:30:00.123Z",
  "v": 156.29,
  "q": "good"
}
```

| Field | Type | Description |
|---|---|---|
| `ts` | String (ISO-8601) | UTC timestamp of the OPC UA read |
| `v` | Number / String / Boolean | The tag value, native JSON type |
| `q` | String | Quality flag: `"good"` or `"stale"` |

### 4.1 Design rationale

- **Compact keys** (`ts`, `v`, `q`) reduce per-message overhead on a
  high-frequency bus (17 + 27 + 20 + 33 = **97 tags** at 1 Hz = 97 msg/s).
- **One message per tag** (not batched) allows per-tag subscriptions and
  independent Telegraf field extraction.
- **Quality flag** propagates the gateway's connection state: if the OPC UA
  poller has not refreshed a value within the staleness window, messages are
  published with `"q": "stale"` so consumers can ignore or annotate them.

---

## 5. QoS and retention policies

| Category | QoS | Retained | Rationale |
|---|---|---|---|
| Identification tags | 1 | **Yes** | New subscribers get nameplate data immediately |
| Speed factor / mode | 1 | **Yes** | Simulation config always available |
| Telemetry (analogue) | 0 | No | High frequency, loss of one sample acceptable |
| Alarms (boolean) | 1 | No | Alarm edges must not be lost |
| Simulation metadata | 0 | No | Informational, not safety-critical |

---

## 6. Topic naming rules

1. **All lowercase**, words separated by underscores within a level.
2. **No spaces**, no special characters except `/` as level separator.
3. **Unit suffix preserved** from the OPC UA tag name (e.g. `torque_nm`).
4. **CamelCase → snake_case** conversion: `ToolWear_min` → `tool_wear_min`,
   `CoolingEfficiency_pct` → `cooling_efficiency_pct`.
5. **Boolean tags** drop the `is_` prefix if present in OPC UA.

Conversion algorithm (implemented in `uns/config.py`):

```python
import re

def opcua_to_mqtt_topic(asset_id: str, area: str, folder: str, name: str) -> str:
    """Convert OPC UA browse path to MQTT topic."""
    def to_snake(s: str) -> str:
        s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1_\2', s)
        s = re.sub(r'([a-z\d])([A-Z])', r'\1_\2', s)
        return s.lower()
    return f"jesa/site1/{area}/{asset_id}/{to_snake(folder)}/{to_snake(name)}"
```

---

## 7. Gateway → Telegraf → InfluxDB mapping

Telegraf subscribes to `jesa/site1/#` and parses each message:

| InfluxDB concept | Derived from |
|---|---|
| **Measurement** | `asset_id` (e.g. `A1`, `A2`, `A3`, `PLC`) |
| **Tag: area** | topic level 2 (e.g. `workshop/milling`) |
| **Tag: folder** | topic level 5 (e.g. `drive`, `hydraulic`) |
| **Field name** | topic level 6 (e.g. `torque_nm`) |
| **Field value** | JSON `.v` |
| **Timestamp** | JSON `.ts` |

This allows Flux queries like:

```flux
from(bucket: "telemetry")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "A1" and r._field == "torque_nm")
```
