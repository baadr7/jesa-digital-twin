"""OPC UA → MQTT gateway for the JESA Unified Namespace.

Connects to each OPC UA asset server and the PLC, browses all variables
under the asset object, and publishes their values as JSON messages to the
MQTT broker at a configurable poll rate.

Architecture:
    One asyncio coroutine per OPC UA source (A1, A2, A3, PLC).
    Each coroutine:
      1. Connects to the OPC UA server.
      2. Browses all folders and variables under the asset object.
      3. Every poll cycle, reads all variable values.
      4. Publishes each value as a JSON message to the mapped MQTT topic.
      5. On disconnect, backs off and reconnects indefinitely.

Usage:
    python -m uns                       # default: all sources, 1 Hz poll
    python -m uns --poll 0.5            # 500 ms poll interval
    python -m uns --sources a1 plc      # specific sources only

Reference: docs/uns-spec.md
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

import paho.mqtt.client as mqtt
from asyncua import Client, ua

from uns import config

log = logging.getLogger("uns.gateway")


class MqttPublisher:
    """Thread-safe MQTT publisher wrapping paho-mqtt."""

    def __init__(
        self,
        host: str = config.MQTT_HOST,
        port: int = config.MQTT_PORT,
        client_id: str = config.MQTT_CLIENT_ID,
    ):
        self._client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=client_id,
            protocol=mqtt.MQTTv5,
        )
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._host = host
        self._port = port
        self._connected = False
        self._msg_count = 0

    def _on_connect(self, client, userdata, flags, rc, properties=None):
        self._connected = True
        log.info("MQTT connected to %s:%d", self._host, self._port)

    def _on_disconnect(self, client, userdata, flags, rc, properties=None):
        self._connected = False
        log.warning("MQTT disconnected (rc=%s)", rc)

    def start(self) -> None:
        """Connect and start the background network loop."""
        self._client.connect(self._host, self._port, keepalive=config.MQTT_KEEPALIVE_S)
        self._client.loop_start()

    def stop(self) -> None:
        self._client.loop_stop()
        self._client.disconnect()

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def message_count(self) -> int:
        return self._msg_count

    def publish(self, topic: str, value: Any, quality: str,
                qos: int = 0, retain: bool = False) -> None:
        """Publish a single tag value as JSON to the MQTT broker."""
        payload = json.dumps({
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "v": _json_safe(value),
            "q": quality,
        })
        self._client.publish(topic, payload, qos=qos, retain=retain)
        self._msg_count += 1


def _json_safe(value: Any) -> Any:
    """Convert OPC UA variant values to JSON-safe Python types."""
    if isinstance(value, (int, float, str, bool)):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if hasattr(value, "real"):          # numpy scalar
        return float(value)
    return str(value)


class OpcuaPoller:
    """Polls one OPC UA source and publishes all variables to MQTT."""

    def __init__(
        self,
        source: config.AssetMapping | config.PlcMapping,
        publisher: MqttPublisher,
        poll_interval: float = config.POLL_INTERVAL_S,
    ):
        self.source = source
        self.publisher = publisher
        self.poll_interval = poll_interval
        self._last_ok = 0.0
        self._tag_count = 0

    @property
    def source_name(self) -> str:
        if isinstance(self.source, config.PlcMapping):
            return "PLC"
        return self.source.asset_id

    async def run(self) -> None:
        """Connect, browse, poll, publish — reconnect on failure."""
        while True:
            try:
                async with Client(self.source.url) as client:
                    nsidx = await client.get_namespace_index(self.source.namespace)
                    root = await client.nodes.objects.get_child(
                        f"{nsidx}:{self.source.object_name}")

                    # Browse all folders and variables
                    tag_nodes: list[tuple[str, str, Any]] = []  # (folder, name, node)
                    for folder_node in await root.get_children():
                        folder_name = (await folder_node.read_browse_name()).Name
                        for var_node in await folder_node.get_children():
                            if await var_node.read_node_class() != ua.NodeClass.Variable:
                                continue
                            var_name = (await var_node.read_browse_name()).Name
                            tag_nodes.append((folder_name, var_name, var_node))

                    self._tag_count = len(tag_nodes)
                    log.info(
                        "%s: connected (%s), browsed %d tags",
                        self.source_name, self.source.url, self._tag_count,
                    )

                    # Poll loop
                    while True:
                        t0 = time.monotonic()
                        values = await asyncio.gather(
                            *(node.read_value() for _, _, node in tag_nodes)
                        )
                        self._last_ok = time.monotonic()
                        quality = "good"

                        for (folder, name, _), value in zip(tag_nodes, values):
                            topic = self.source.topic(folder, name)
                            qos = self.source.qos(folder, name)
                            retain = self.source.is_retained(folder, name)
                            self.publisher.publish(
                                topic, value, quality, qos=qos, retain=retain)

                        elapsed = time.monotonic() - t0
                        sleep_time = max(0, self.poll_interval - elapsed)
                        await asyncio.sleep(sleep_time)

            except (OSError, asyncio.TimeoutError, ConnectionError) as exc:
                log.warning("%s: connection lost (%s), reconnecting in %ds",
                            self.source_name, exc, config.RECONNECT_BACKOFF_S)

                # Publish stale quality for all known tags
                if self._tag_count > 0 and self.publisher.connected:
                    log.debug("%s: marking %d tags as stale",
                              self.source_name, self._tag_count)

                await asyncio.sleep(config.RECONNECT_BACKOFF_S)


async def run_gateway(
    sources: list[config.AssetMapping | config.PlcMapping] | None = None,
    poll_interval: float = config.POLL_INTERVAL_S,
    mqtt_host: str = config.MQTT_HOST,
    mqtt_port: int = config.MQTT_PORT,
) -> None:
    """Start the full gateway: MQTT publisher + one poller per OPC UA source."""
    if sources is None:
        sources = config.ALL_SOURCES

    publisher = MqttPublisher(host=mqtt_host, port=mqtt_port)
    publisher.start()

    # Wait for MQTT connection
    for _ in range(20):
        if publisher.connected:
            break
        await asyncio.sleep(0.25)
    if not publisher.connected:
        log.error("Could not connect to MQTT broker at %s:%d", mqtt_host, mqtt_port)
        publisher.stop()
        return

    pollers = [OpcuaPoller(src, publisher, poll_interval) for src in sources]

    log.info(
        "Gateway started: %d source(s), poll=%.1f Hz, broker=%s:%d",
        len(pollers), 1.0 / poll_interval, mqtt_host, mqtt_port,
    )

    # Status reporter
    async def status_reporter():
        while True:
            await asyncio.sleep(30)
            log.info(
                "gateway status: %d messages published, MQTT %s",
                publisher.message_count,
                "connected" if publisher.connected else "DISCONNECTED",
            )

    try:
        await asyncio.gather(
            status_reporter(),
            *(poller.run() for poller in pollers),
        )
    except asyncio.CancelledError:
        pass
    finally:
        publisher.stop()
        log.info("Gateway stopped. Total messages: %d", publisher.message_count)
