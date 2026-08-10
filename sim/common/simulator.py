"""Common infrastructure for dataset-replay OPC UA asset simulators.

Every asset is one OPC UA server whose address space is declared as a flat
list of :class:`Tag` entries (folder + name + type). Concrete simulators only
implement :meth:`AssetSimulator.samples`, an async generator yielding
``(values, dataset_dt)`` pairs; the base class owns the server lifecycle and
a drift-corrected pacing loop that maps dataset time onto wall-clock time
through the replay speed factor.
"""

from __future__ import annotations

import abc
import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

from asyncua.server.server import Server

from sim.config import AssetConfig

log = logging.getLogger("sim")


@dataclass(frozen=True)
class Tag:
    """One OPC UA variable of the asset address space.

    ``initial`` fixes the variant type of the node (float -> Double,
    bool -> Boolean, int -> Int64, str -> String); ``cast`` is applied to
    every written value so numpy scalars from pandas never leak into the
    OPC UA layer with a mismatched variant type.
    """

    folder: str
    name: str
    initial: Any

    @property
    def key(self) -> str:
        return f"{self.folder}/{self.name}"

    @property
    def cast(self) -> Callable[[Any], Any]:
        return type(self.initial)


class AssetSimulator(abc.ABC):
    """Base class: OPC UA server + paced dataset replay loop."""

    #: Address space declaration, set by subclasses.
    tags: list[Tag] = []

    def __init__(self, cfg: AssetConfig, speed: float | None = None, port: int | None = None):
        self.cfg = cfg
        self.speed = float(speed if speed is not None else cfg.default_speed)
        if self.speed <= 0:
            raise ValueError("speed must be > 0")
        self.port = int(port if port is not None else cfg.port)
        self.endpoint = f"opc.tcp://0.0.0.0:{self.port}/jesa/{cfg.asset_id.lower()}"
        self.namespace_uri = f"urn:jesa:sim:{cfg.asset_id.lower()}"
        self._server: Server | None = None
        self._nodes: dict[str, Any] = {}

    # ------------------------------------------------------------------ setup

    async def _build_address_space(self) -> None:
        server = Server()
        await server.init()
        server.set_endpoint(self.endpoint)
        server.set_server_name(f"JESA Sim {self.cfg.asset_id}")
        self._patch_endpoint_discovery(server)
        idx = await server.register_namespace(self.namespace_uri)

        asset_obj = await server.nodes.objects.add_object(idx, self.cfg.asset_id)

        folders: dict[str, Any] = {}
        static = [
            Tag("Identification", "AssetId", self.cfg.asset_id),
            Tag("Identification", "Description", self.cfg.description),
            Tag("Simulation", "SpeedFactor", self.speed),
        ]
        for tag in static + self.tags:
            if tag.folder not in folders:
                folders[tag.folder] = await asset_obj.add_folder(idx, tag.folder)
            node = await folders[tag.folder].add_variable(idx, tag.name, tag.initial)
            self._nodes[tag.key] = node

        self._server = server

    @staticmethod
    def _patch_endpoint_discovery(server: Server) -> None:
        advertise = os.environ.get("JESA_OPCUA_ADVERTISE_HOST", "host.docker.internal")
        if "0.0.0.0" not in (server.endpoint.netloc if hasattr(server.endpoint, "netloc") else ""):
            return
        _orig = server.get_endpoints

        async def _patched(*args, **kwargs):
            eps = await _orig(*args, **kwargs)
            for ep in eps:
                url = getattr(ep, "EndpointUrl", None)
                if url and "0.0.0.0" in url:
                    ep.EndpointUrl = url.replace("0.0.0.0", advertise)
            return eps

        server.get_endpoints = _patched

    async def _write(self, values: dict[str, Any]) -> None:
        casts = self._casts
        await asyncio.gather(
            *(self._nodes[key].write_value(casts[key](value)) for key, value in values.items())
        )

    @property
    def _casts(self) -> dict[str, Callable[[Any], Any]]:
        return {tag.key: tag.cast for tag in self.tags}

    # ------------------------------------------------------------------- data

    @abc.abstractmethod
    def samples(self) -> AsyncIterator[tuple[dict[str, Any], float]]:
        """Yield ``(values, dataset_dt)``.

        ``values`` maps tag keys (``"Folder/Name"``) to raw values;
        ``dataset_dt`` is the dataset-time in seconds until the *next*
        sample. The generator is expected to loop forever (wrap around at
        the end of the dataset).
        """

    # -------------------------------------------------------------------- run

    async def _endpoint_advertise_task(self) -> None:
        advertise = os.environ.get("JESA_OPCUA_ADVERTISE_HOST", "host.docker.internal")
        server = self._server
        assert server is not None
        try:
            if hasattr(server, "set_match_discovery_endpoint_url"):
                server.set_match_discovery_endpoint_url(False)
        except Exception:
            pass
        while True:
            try:
                eps = await server.get_endpoints()
                for e in eps:
                    url = getattr(e, "EndpointUrl", None)
                    if url and "0.0.0.0" in url:
                        e.EndpointUrl = url.replace("0.0.0.0", advertise)
            except Exception:
                pass
            await asyncio.sleep(1.0)

    async def run(self) -> None:
        await self._build_address_space()
        assert self._server is not None
        log.info(
            "%s: serving %s at %s (speed x%g)",
            self.cfg.asset_id, self.cfg.description, self.endpoint, self.speed,
        )
        loop = asyncio.get_running_loop()
        async with self._server:
            adv_task = asyncio.create_task(self._endpoint_advertise_task())
            try:
                deadline = loop.time()
                async for values, dataset_dt in self.samples():
                    await self._write(values)
                    deadline += dataset_dt / self.speed
                    delay = deadline - loop.time()
                    if delay > 0:
                        await asyncio.sleep(delay)
                    else:
                        deadline = loop.time()
                        await asyncio.sleep(0)
            finally:
                adv_task.cancel()
