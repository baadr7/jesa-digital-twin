"""Live visualization dashboard for the asset simulators.

A small aiohttp web server that connects to the three asset OPC UA servers
as a client, polls their variables once per second into in-memory ring
buffers, and serves a self-contained HTML dashboard (sim/tools/dashboard.html)
plus a JSON API:

    GET /            the dashboard page
    GET /api/data    ring buffers + latest values for all assets

This is a Phase 5 preview for local use; the production path in ROADMAP.md
remains UNS -> InfluxDB -> Grafana. Pollers reconnect automatically, so
simulators can be started and stopped independently of the dashboard.

Usage (with 'python -m sim all' running):
    python -m sim.tools.dashboard [--port 8080]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
from collections import deque
from pathlib import Path
from typing import Any

from aiohttp import web
from asyncua import Client

from sim import config

log = logging.getLogger("sim.dashboard")

POLL_INTERVAL_S = 1.0
BUFFER_POINTS = 600  # 10 minutes at 1 Hz
PAGE = Path(__file__).with_name("dashboard.html")

#: numeric tags kept in ring buffers (charted); all other tags are
#: exposed as "latest value" only.
SERIES = {
    "A1": [
        "Drive/Torque_Nm", "Drive/RotationalSpeed_rpm",
        "Process/AirTemperature_K", "Process/ProcessTemperature_K",
        "Tool/ToolWear_min",
    ],
    "A2": [
        "Hydraulic/PS1_bar", "Hydraulic/PS2_bar", "Hydraulic/PS3_bar",
        "Hydraulic/PS4_bar", "Hydraulic/PS5_bar", "Hydraulic/PS6_bar",
        "Thermal/TS1_C", "Thermal/TS2_C", "Thermal/TS3_C", "Thermal/TS4_C",
        "Motor/Power_W",
    ],
    "A3": [
        "Pneumatic/TP2_bar", "Pneumatic/TP3_bar", "Pneumatic/H1_bar",
        "Pneumatic/DVPressure_bar", "Pneumatic/Reservoirs_bar",
        "Motor/Current_A", "Oil/Temperature_C",
    ],
}

LATEST_ONLY = {
    "A1": [
        "Part/ProductId", "Part/ProductType", "Simulation/PartIndex",
        "Status/MachineFailure", "Status/TWF", "Status/HDF", "Status/PWF",
        "Status/OSF", "Status/RNF",
    ],
    "A2": [
        "Condition/CoolerCondition_pct", "Condition/ValveCondition_pct",
        "Condition/PumpLeakage", "Condition/AccumulatorPressure_bar",
        "Condition/StableFlag", "Simulation/CycleIndex", "Simulation/CycleSecond",
    ],
    "A3": [
        "Digital/COMP", "Digital/DVElectric", "Digital/Towers", "Digital/MPG",
        "Digital/LPS", "Digital/PressureSwitch", "Digital/OilLevel",
        "Digital/CaudalImpulses", "Simulation/RowIndex",
        "Simulation/SourceTimestamp",
    ],
}

ASSETS = {"A1": config.A1, "A2": config.A2, "A3": config.A3}


class AssetPoller:
    """Polls one asset's OPC UA server into ring buffers, reconnecting forever."""

    def __init__(self, cfg: config.AssetConfig):
        self.cfg = cfg
        self.keys = SERIES[cfg.asset_id] + LATEST_ONLY[cfg.asset_id]
        self.url = f"opc.tcp://127.0.0.1:{cfg.port}/jesa/{cfg.asset_id.lower()}"
        self.connected = False
        self.latest: dict[str, Any] = {}
        self.buffers: dict[str, deque[tuple[int, float]]] = {
            key: deque(maxlen=BUFFER_POINTS) for key in SERIES[cfg.asset_id]
        }

    async def _resolve_nodes(self, client: Client) -> list[Any]:
        nsidx = await client.get_namespace_index(f"urn:jesa:sim:{self.cfg.asset_id.lower()}")
        asset = await client.nodes.objects.get_child(f"{nsidx}:{self.cfg.asset_id}")
        return [
            await asset.get_child([f"{nsidx}:{part}" for part in key.split("/")])
            for key in self.keys
        ]

    async def run(self) -> None:
        while True:
            try:
                async with Client(self.url) as client:
                    nodes = await self._resolve_nodes(client)
                    log.info("%s: connected to %s", self.cfg.asset_id, self.url)
                    self.connected = True
                    while True:
                        t0 = time.monotonic()
                        values = await asyncio.gather(*(n.read_value() for n in nodes))
                        now_ms = int(time.time() * 1000)
                        for key, value in zip(self.keys, values):
                            self.latest[key] = value
                            if key in self.buffers:
                                self.buffers[key].append((now_ms, float(value)))
                        elapsed = time.monotonic() - t0
                        await asyncio.sleep(max(POLL_INTERVAL_S - elapsed, 0.05))
            except (OSError, asyncio.TimeoutError, ConnectionError) as exc:
                if self.connected:
                    log.warning("%s: connection lost (%s)", self.cfg.asset_id, exc)
                self.connected = False
                await asyncio.sleep(3.0)

    def snapshot(self) -> dict[str, Any]:
        return {
            "connected": self.connected,
            "latest": self.latest,
            "series": {
                key: {"t": [p[0] for p in buf], "v": [p[1] for p in buf]}
                for key, buf in self.buffers.items()
            },
        }


def build_app(pollers: dict[str, AssetPoller]) -> web.Application:
    async def index(_request: web.Request) -> web.Response:
        return web.Response(text=PAGE.read_text(encoding="utf-8"),
                            content_type="text/html")

    async def api_data(_request: web.Request) -> web.Response:
        payload = {asset_id: poller.snapshot() for asset_id, poller in pollers.items()}
        return web.Response(text=json.dumps(payload), content_type="application/json")

    async def start_pollers(app: web.Application) -> None:
        app["tasks"] = [asyncio.create_task(p.run()) for p in pollers.values()]

    async def stop_pollers(app: web.Application) -> None:
        for task in app["tasks"]:
            task.cancel()

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/api/data", api_data)
    app.on_startup.append(start_pollers)
    app.on_cleanup.append(stop_pollers)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("asyncua").setLevel(logging.ERROR)
    parser = argparse.ArgumentParser(description="Asset simulator live dashboard")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    pollers = {asset_id: AssetPoller(cfg) for asset_id, cfg in ASSETS.items()}
    log.info("dashboard at http://localhost:%d", args.port)
    web.run_app(build_app(pollers), port=args.port, print=None)


if __name__ == "__main__":
    main()
