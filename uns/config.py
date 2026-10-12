"""Centralised configuration for the UNS gateway.

Defines the OPC UA → MQTT topic mapping for every asset and the PLC,
derived from docs/asset-attribute-map.md §2 and docs/uns-spec.md §3.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# ─── MQTT broker ─────────────────────────────────────────────────────────

MQTT_HOST = "127.0.0.1"
MQTT_PORT = 1883
MQTT_CLIENT_ID = "jesa-uns-gateway"
MQTT_KEEPALIVE_S = 60

# ─── Topic prefix ────────────────────────────────────────────────────────

TOPIC_PREFIX = "jesa/site1"

# ─── OPC UA → MQTT mapping ──────────────────────────────────────────────


def _to_snake(name: str) -> str:
    """Convert CamelCase or PascalCase to snake_case, preserving unit suffixes.

    Examples:
        RotationalSpeed_rpm  → rotational_speed_rpm
        CoolingEfficiency_pct → cooling_efficiency_pct
        PS1_bar              → ps1_bar
        DVElectric           → dv_electric
        ToolWear_min         → tool_wear_min
        KPIs                 → kpis
    """
    # Known acronyms that should stay as one token
    ACRONYMS = {"KPIs": "kpis", "DVPressure": "dv_pressure", "CoolingPower_kW": "cooling_power_kw"}
    for acr, repl in ACRONYMS.items():
        name = name.replace(acr, repl)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name)
    s = re.sub(r"([a-z\d])([A-Z])", r"\1_\2", s)
    s = re.sub(r"__+", "_", s)  # collapse double underscores
    return s.lower()



@dataclass(frozen=True)
class AssetMapping:
    """Maps one OPC UA asset server to a set of MQTT topics."""

    asset_id: str               # "A1", "A2", "A3"
    object_name: str            # OPC UA object node name (same as asset_id)
    namespace: str              # e.g. "urn:jesa:sim:a1"
    url: str                    # e.g. "opc.tcp://127.0.0.1:4841/jesa/a1"
    area: str                   # ISA-95 area path, e.g. "workshop/milling"

    # Tags whose topic should use QoS 1 + retained=True.
    # FULLY RETAINED: every slowly-moving counter / flag / KPI so that any
    # MQTT subscriber (3D Twin, Grafana, alarms, ...) receives the latest
    # value immediately on subscribe, even if it joined after the publish.
    # Telemetry (Hydraulic, Motor, Thermal, Process, Drive, Part,
    # Identification, Digital, Oil, Pneumatic, Metrics, ...) is also retained
    # here to match the original UNS Gateway behaviour.
    retained_folders: tuple[str, ...] = (
        "Identification",
        "Simulation",
        "Tool",
        "Status",
        "Condition",
        "KPIs",
        "Process",
        "Part",
        "Hydraulic",
        "Motor",
        "Thermal",
        "Drive",
        "Digital",
        "Oil",
        "Pneumatic",
        "Derating",
        "Metrics",
        "Derived",
        "Analytics",
    )
    retained_tags: tuple[str, ...] = (
        "Simulation/SpeedFactor",
        "Simulation/PartIndex",
        "Simulation/CycleIndex",
        "Simulation/CycleSecond",
        "Simulation/RowIndex",
        "Simulation/SourceTimestamp",
        "Tool/ToolWear_min",
        "Condition/CoolerCondition_pct",
        "Condition/ValveCondition_pct",
        "Condition/PumpLeakage",
        "Condition/AccumulatorPressure_bar",
        "Condition/StableFlag",
        "KPIs/CoolingEfficiency_pct",
        "KPIs/CoolingPower_kW",
        "KPIs/EfficiencyFactor_pct",
    )

    def topic(self, folder: str, name: str) -> str:
        """Build the full MQTT topic for a given OPC UA browse path."""
        return (
            f"{TOPIC_PREFIX}/{self.area}/{self.asset_id}"
            f"/{_to_snake(folder)}/{_to_snake(name)}"
        )

    def is_retained(self, folder: str, name: str) -> bool:
        return (
            folder in self.retained_folders
            or f"{folder}/{name}" in self.retained_tags
        )

    def qos(self, folder: str, name: str) -> int:
        """QoS 1 for retained tags and alarm booleans, QoS 0 otherwise."""
        if self.is_retained(folder, name):
            return 1
        # PLC alarm booleans get QoS 1
        if folder in ("A1", "A2", "A3") and isinstance(name, str):
            return 1
        return 0


@dataclass(frozen=True)
class PlcMapping:
    """Maps the PLC consolidated server to MQTT topics."""

    object_name: str = "PLC"
    namespace: str = "urn:jesa:plc"
    url: str = "opc.tcp://127.0.0.1:4840/jesa/plc"
    area: str = "plc"

    retained_tags: tuple[str, ...] = ("System/Mode",)

    def topic(self, folder: str, name: str) -> str:
        return f"{TOPIC_PREFIX}/{self.area}/{_to_snake(folder)}/{_to_snake(name)}"

    def is_retained(self, folder: str, name: str) -> bool:
        return f"{folder}/{name}" in self.retained_tags

    def qos(self, folder: str, name: str) -> int:
        if self.is_retained(folder, name):
            return 1
        # All PLC alarm booleans get QoS 1
        return 1


# ─── Concrete instances ──────────────────────────────────────────────────

A1 = AssetMapping(
    asset_id="A1",
    object_name="A1",
    namespace="urn:jesa:sim:a1",
    url="opc.tcp://127.0.0.1:4841/jesa/a1",
    area="workshop/milling",
)

A2 = AssetMapping(
    asset_id="A2",
    object_name="A2",
    namespace="urn:jesa:sim:a2",
    url="opc.tcp://127.0.0.1:4842/jesa/a2",
    area="workshop/hydraulics",
)

A3 = AssetMapping(
    asset_id="A3",
    object_name="A3",
    namespace="urn:jesa:sim:a3",
    url="opc.tcp://127.0.0.1:4843/jesa/a3",
    area="fleet/apu",
)

PLC = PlcMapping()

ALL_SOURCES: list[AssetMapping | PlcMapping] = [A1, A2, A3, PLC]

# ─── Gateway settings ────────────────────────────────────────────────────

POLL_INTERVAL_S = 1.0          # OPC UA poll frequency
RECONNECT_BACKOFF_S = 3.0     # seconds between reconnection attempts
STALE_TIMEOUT_S = 5.0          # values older than this → quality = "stale"
