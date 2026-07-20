"""Supervisory logic controller (soft PLC) for assets A1, A2, A3.

Reference implementation of docs/plc-spec.md: one asynchronous input poller
per asset feeds an input image; a fixed 500 ms scan cycle executes the
interlock logic and writes the consolidated output image to this
controller's own OPC UA server:

    opc.tcp://<host>:4840/jesa/plc     namespace urn:jesa:plc

The dataset ground-truth tags (A1 Status/*, A2 Condition/*) are deliberately
not read: every alarm is computed from process measurements, so predictions
and interlocks can later be validated against the labels.

Usage (with 'python -m sim all' running):
    python -m sim.plc [--port 4840] [--scan 0.5]
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import math
import time
from typing import Any

from asyncua import Client, Server

from sim import config
from sim.common import Tag

log = logging.getLogger("plc")

SCAN_PERIOD_S = 0.5
STALE_TIMEOUT_S = 5.0
RECONNECT_BACKOFF_S = 3.0
PLC_PORT = 4840

INPUTS = {
    "A1": ["Drive/Torque_Nm", "Drive/RotationalSpeed_rpm",
           "Process/AirTemperature_K", "Process/ProcessTemperature_K",
           "Tool/ToolWear_min", "Part/ProductType"],
    "A2": ["Hydraulic/PS1_bar", "Motor/Power_W", "Motor/Vibration_mms",
           "KPIs/CoolingEfficiency_pct"],
    "A3": ["Pneumatic/TP3_bar", "Pneumatic/Reservoirs_bar", "Motor/Current_A",
           "Oil/Temperature_C", "Digital/LPS", "Digital/OilLevel"],
}

OUTPUTS = [
    Tag("System", "Mode", "RUN"),
    Tag("System", "ScanCount", 0),
    Tag("System", "ScanTimeMs", 0.0),
    Tag("System", "ActiveAlarms", 0),
    # A1
    Tag("A1", "CommFault", False),
    Tag("A1", "Torque_Nm", 0.0),
    Tag("A1", "Speed_rpm", 0.0),
    Tag("A1", "ToolWear_min", 0),
    Tag("A1", "Power_kW", 0.0),
    Tag("A1", "ToolWearHigh", False),
    Tag("A1", "Overstrain", False),
    Tag("A1", "PowerOutOfRange", False),
    Tag("A1", "HeatDissipationRisk", False),
    Tag("A1", "StopCommand", False),
    # A2
    Tag("A2", "CommFault", False),
    Tag("A2", "SystemPressure_bar", 0.0),
    Tag("A2", "MotorPower_W", 0.0),
    Tag("A2", "Vibration_mms", 0.0),
    Tag("A2", "CoolingEfficiency_pct", 0.0),
    Tag("A2", "CoolingDegraded", False),
    Tag("A2", "MotorOverload", False),
    Tag("A2", "VibrationHigh", False),
    Tag("A2", "MaintenanceRequired", False),
    # A3
    Tag("A3", "CommFault", False),
    Tag("A3", "PanelPressure_bar", 0.0),
    Tag("A3", "ReservoirPressure_bar", 0.0),
    Tag("A3", "MotorCurrent_A", 0.0),
    Tag("A3", "OilTemperature_C", 0.0),
    Tag("A3", "CompressorRunning", False),
    Tag("A3", "LowPressure", False),
    Tag("A3", "OilTempHigh", False),
    Tag("A3", "OilLevelLow", False),
    Tag("A3", "AirSupplyOk", False),
]

ALARM_KEYS = {
    "A1/CommFault", "A1/ToolWearHigh", "A1/Overstrain", "A1/PowerOutOfRange",
    "A1/HeatDissipationRisk",
    "A2/CommFault", "A2/CoolingDegraded", "A2/MotorOverload", "A2/VibrationHigh",
    "A3/CommFault", "A3/LowPressure", "A3/OilTempHigh", "A3/OilLevelLow",
}

# Commissioning parameters - see docs/plc-spec.md section 4.
A1_POWER_MIN_W, A1_POWER_MAX_W = 3500.0, 9000.0
A1_HDF_DELTA_K, A1_HDF_SPEED_RPM = 8.6, 1380.0
A1_OSF_LIMIT_MINNM = {"L": 11000.0, "M": 12000.0, "H": 13000.0}
A1_TOOL_WEAR_LIMIT_MIN = 200
A2_COOLING_MIN_PCT = 30.0
A2_POWER_MAX_W = 2900.0
A2_VIBRATION_MAX_MMS = 0.8
A3_RUNNING_CURRENT_A = 5.5
A3_PRESSURE_MIN_BAR = 7.0
A3_OIL_TEMP_MAX_C = 65.0


class AssetInput:
    """Polls one asset server into the PLC input image, reconnecting forever."""

    def __init__(self, cfg: config.AssetConfig, keys: list[str]):
        self.cfg = cfg
        self.keys = keys
        self.url = f"opc.tcp://127.0.0.1:{cfg.port}/jesa/{cfg.asset_id.lower()}"
        self.values: dict[str, Any] = {}
        self._last_ok = 0.0

    @property
    def fresh(self) -> bool:
        return (time.monotonic() - self._last_ok) < STALE_TIMEOUT_S

    async def run(self) -> None:
        while True:
            try:
                async with Client(self.url) as client:
                    nsidx = await client.get_namespace_index(
                        f"urn:jesa:sim:{self.cfg.asset_id.lower()}")
                    asset = await client.nodes.objects.get_child(
                        f"{nsidx}:{self.cfg.asset_id}")
                    nodes = [
                        await asset.get_child([f"{nsidx}:{p}" for p in key.split("/")])
                        for key in self.keys
                    ]
                    log.info("%s: input connected (%s)", self.cfg.asset_id, self.url)
                    while True:
                        values = await asyncio.gather(*(n.read_value() for n in nodes))
                        self.values = dict(zip(self.keys, values))
                        self._last_ok = time.monotonic()
                        await asyncio.sleep(SCAN_PERIOD_S)
            except (OSError, asyncio.TimeoutError, ConnectionError) as exc:
                if self.fresh:
                    log.warning("%s: input lost (%s)", self.cfg.asset_id, exc)
                await asyncio.sleep(RECONNECT_BACKOFF_S)


class PlcRuntime:
    def __init__(self, port: int = PLC_PORT, scan_period: float = SCAN_PERIOD_S):
        self.port = port
        self.scan_period = scan_period
        self.inputs = {
            asset_id: AssetInput(cfg, INPUTS[asset_id])
            for asset_id, cfg in {"A1": config.A1, "A2": config.A2, "A3": config.A3}.items()
        }
        self._nodes: dict[str, Any] = {}
        self._casts = {tag.key: tag.cast for tag in OUTPUTS}
        self._prev_alarms: dict[str, bool] = {}
        self._scan_count = 0

    # ---------------------------------------------------------------- server

    async def _build_server(self) -> Server:
        server = Server()
        await server.init()
        server.set_endpoint(f"opc.tcp://0.0.0.0:{self.port}/jesa/plc")
        server.set_server_name("JESA PLC")
        idx = await server.register_namespace("urn:jesa:plc")
        plc_obj = await server.nodes.objects.add_object(idx, "PLC")
        folders: dict[str, Any] = {}
        for tag in OUTPUTS:
            if tag.folder not in folders:
                folders[tag.folder] = await plc_obj.add_folder(idx, tag.folder)
            self._nodes[tag.key] = await folders[tag.folder].add_variable(
                idx, tag.name, tag.initial)
        return server

    # ----------------------------------------------------------------- logic

    def _logic(self) -> dict[str, Any]:
        out: dict[str, Any] = {}

        # A1 - milling machine
        a1, a1_ok = self.inputs["A1"].values, self.inputs["A1"].fresh
        torque = float(a1.get("Drive/Torque_Nm", 0.0))
        speed = float(a1.get("Drive/RotationalSpeed_rpm", 0.0))
        wear = int(a1.get("Tool/ToolWear_min", 0))
        delta_t = (float(a1.get("Process/ProcessTemperature_K", 0.0))
                   - float(a1.get("Process/AirTemperature_K", 0.0)))
        power_w = torque * speed * 2.0 * math.pi / 60.0
        osf_limit = A1_OSF_LIMIT_MINNM.get(str(a1.get("Part/ProductType", "L")), 11000.0)
        overstrain = a1_ok and wear * torque > osf_limit
        power_oor = a1_ok and not (A1_POWER_MIN_W <= power_w <= A1_POWER_MAX_W)
        hdf_risk = a1_ok and delta_t < A1_HDF_DELTA_K and speed < A1_HDF_SPEED_RPM
        out.update({
            "A1/CommFault": not a1_ok,
            "A1/Torque_Nm": torque, "A1/Speed_rpm": speed, "A1/ToolWear_min": wear,
            "A1/Power_kW": power_w / 1000.0,
            "A1/ToolWearHigh": a1_ok and wear >= A1_TOOL_WEAR_LIMIT_MIN,
            "A1/Overstrain": overstrain,
            "A1/PowerOutOfRange": power_oor,
            "A1/HeatDissipationRisk": hdf_risk,
            "A1/StopCommand": overstrain or power_oor or hdf_risk or not a1_ok,
        })

        # A2 - hydraulic test rig
        a2, a2_ok = self.inputs["A2"].values, self.inputs["A2"].fresh
        ce = float(a2.get("KPIs/CoolingEfficiency_pct", 0.0))
        power = float(a2.get("Motor/Power_W", 0.0))
        vib = float(a2.get("Motor/Vibration_mms", 0.0))
        cooling_degraded = a2_ok and ce < A2_COOLING_MIN_PCT
        overload = a2_ok and power > A2_POWER_MAX_W
        vib_high = a2_ok and vib > A2_VIBRATION_MAX_MMS
        out.update({
            "A2/CommFault": not a2_ok,
            "A2/SystemPressure_bar": float(a2.get("Hydraulic/PS1_bar", 0.0)),
            "A2/MotorPower_W": power, "A2/Vibration_mms": vib,
            "A2/CoolingEfficiency_pct": ce,
            "A2/CoolingDegraded": cooling_degraded,
            "A2/MotorOverload": overload,
            "A2/VibrationHigh": vib_high,
            "A2/MaintenanceRequired": cooling_degraded or overload or vib_high,
        })

        # A3 - APU air compressor
        a3, a3_ok = self.inputs["A3"].values, self.inputs["A3"].fresh
        tp3 = float(a3.get("Pneumatic/TP3_bar", 0.0))
        low_pressure = a3_ok and (bool(a3.get("Digital/LPS", False))
                                  or tp3 < A3_PRESSURE_MIN_BAR)
        out.update({
            "A3/CommFault": not a3_ok,
            "A3/PanelPressure_bar": tp3,
            "A3/ReservoirPressure_bar": float(a3.get("Pneumatic/Reservoirs_bar", 0.0)),
            "A3/MotorCurrent_A": float(a3.get("Motor/Current_A", 0.0)),
            "A3/OilTemperature_C": float(a3.get("Oil/Temperature_C", 0.0)),
            "A3/CompressorRunning": a3_ok and float(a3.get("Motor/Current_A", 0.0)) > A3_RUNNING_CURRENT_A,
            "A3/LowPressure": low_pressure,
            "A3/OilTempHigh": a3_ok and float(a3.get("Oil/Temperature_C", 0.0)) > A3_OIL_TEMP_MAX_C,
            "A3/OilLevelLow": a3_ok and bool(a3.get("Digital/OilLevel", False)),
            "A3/AirSupplyOk": a3_ok and not low_pressure,
        })

        out["System/ActiveAlarms"] = sum(1 for key in ALARM_KEYS if out[key])
        return out

    def _log_alarm_edges(self, out: dict[str, Any]) -> None:
        for key in sorted(ALARM_KEYS):
            now, before = bool(out[key]), self._prev_alarms.get(key, False)
            if now != before:
                log.warning("alarm %s: %s", key, "RAISED" if now else "cleared")
            self._prev_alarms[key] = now

    # ------------------------------------------------------------------ run

    async def run(self) -> None:
        server = await self._build_server()
        pollers = [asyncio.create_task(inp.run()) for inp in self.inputs.values()]
        log.info("PLC serving opc.tcp://0.0.0.0:%d/jesa/plc (scan %.0f ms)",
                 self.port, self.scan_period * 1000)
        try:
            async with server:
                loop = asyncio.get_running_loop()
                deadline = loop.time()
                while True:
                    t0 = time.perf_counter()
                    out = self._logic()
                    self._scan_count += 1
                    out["System/ScanCount"] = self._scan_count
                    out["System/ScanTimeMs"] = (time.perf_counter() - t0) * 1000.0
                    self._log_alarm_edges(out)
                    await asyncio.gather(*(
                        self._nodes[key].write_value(self._casts[key](value))
                        for key, value in out.items()
                    ))
                    deadline += self.scan_period
                    delay = deadline - loop.time()
                    if delay > 0:
                        await asyncio.sleep(delay)
                    else:
                        deadline = loop.time()
                        await asyncio.sleep(0)
        finally:
            for task in pollers:
                task.cancel()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("asyncua").setLevel(logging.ERROR)
    parser = argparse.ArgumentParser(description="JESA supervisory logic controller")
    parser.add_argument("--port", type=int, default=PLC_PORT)
    parser.add_argument("--scan", type=float, default=SCAN_PERIOD_S,
                        help="scan period in seconds (default 0.5)")
    args = parser.parse_args()
    try:
        asyncio.run(PlcRuntime(port=args.port, scan_period=args.scan).run())
    except KeyboardInterrupt:
        log.info("stopped by user")


if __name__ == "__main__":
    main()
