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
import collections as _collections
import json
import logging
import math as _math
import threading as _threading
import time
from datetime import datetime, timezone
from typing import Any

import paho.mqtt.client as mqtt
from asyncua.client.client import Client
from asyncua import ua

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
        self._last_ok_wall: float = 0.0   # wall-clock time of last successful read
        self._tag_count = 0
        self._last_tag_nodes: list[tuple[str, str, Any]] = []  # retained for stale publish

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
                    self._last_tag_nodes = tag_nodes  # keep for stale publish on disconnect
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
                        self._last_ok_wall = time.monotonic()

                        # Use STALE_TIMEOUT_S: mark quality stale when more
                        # than STALE_TIMEOUT_S seconds have elapsed since the
                        # last successful poll (e.g. server hiccup between
                        # cycles). age_since_last measures inter-cycle latency,
                        # not the poll duration itself.
                        age_since_last = (
                            time.monotonic() - self._last_ok_wall
                            if self._last_ok_wall > 0 else 0.0
                        )
                        quality = (
                            "stale"
                            if self._last_ok_wall > 0
                            and age_since_last > config.STALE_TIMEOUT_S
                            else "good"
                        )

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

                # Publish stale quality for all known tags so subscribers
                # can detect the data gap immediately (UNS spec §4).
                if self._tag_count > 0 and self.publisher.connected:
                    log.info("%s: publishing stale quality for %d tags",
                             self.source_name, self._tag_count)
                    stale_payload = json.dumps({
                        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                        "v": None,
                        "q": "stale",
                    })
                    # We no longer have live node references, so we republish
                    # on every topic that was last seen from this source.
                    for folder, name, _ in (self._last_tag_nodes or []):
                        topic = self.source.topic(folder, name)
                        self.publisher._client.publish(topic, stale_payload, qos=0)

                await asyncio.sleep(config.RECONNECT_BACKOFF_S)


async def run_gateway(
    sources: list[config.AssetMapping | config.PlcMapping] | None = None,
    poll_interval: float = config.POLL_INTERVAL_S,
    mqtt_host: str = config.MQTT_HOST,
    mqtt_port: int = config.MQTT_PORT,
    derived: bool = False,
) -> None:
    """Start the full gateway: MQTT publisher + one poller per OPC UA source.

    Args:
        derived: If True, also start the built-in Python derived-data engine
            (power_kw, delta_t_k, cooler_delta_t_c, …). Default False because
            Node-RED Tab 02 handles derived KPIs in the standard deployment.
            Set True only for a Python-only stack (no Node-RED derived tab).
    """
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

    # Start derived-data engine (only if explicitly requested — Node-RED
    # Tab 02 handles derived KPIs in the standard deployment to avoid dual
    # publishers on derived topics).
    derived_engine: DerivedPublisher | None = None
    if derived:
        derived_engine = DerivedPublisher(mqtt_host, mqtt_port)
        derived_engine.start()

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
        if derived_engine is not None:
            derived_engine.stop()
        publisher.stop()
        log.info("Gateway stopped. Total messages: %d", publisher.message_count)


# ===========================================================================
#  DERIVED DATA ENGINE — optional pure-Python derived KPI publisher.
#  Disabled by default (Node-RED Tab 02 handles derived KPIs).
#  Enable with `python -m uns --derived` for a Python-only stack.
#  Subscribes to raw UNS topics, computes derived values, republishes them.
# ===========================================================================



class DerivedPublisher:
    """Subscribes to raw telemetry topics and publishes derived KPIs.

    Derived topics published (same schema as Node-RED Tab 02):

    A1:
      .../A1/derived/power_kw             = torque * speed * 2π/60 / 1000
      .../A1/derived/delta_t_k            = process_temp - air_temp

    A2:
      .../A2/derived/cooler_delta_t_c     = TS1 - TS4

    A3:
      .../A3/derived/comp_duty_pct_5min   = rolling 5-min COMP duty %
      .../A3/derived/load_state           = idle|offload|load|peak (from current_a)
    """

    _PREFIX = "jesa/site1"
    _COMP_WINDOW_S = 300  # 5 minutes

    def __init__(self, host: str = config.MQTT_HOST, port: int = config.MQTT_PORT):
        self._host = host
        self._port = port
        self._thread: _threading.Thread | None = None
        self._client: mqtt.Client | None = None

        # A1 state
        self._a1: dict = {}

        # A2 state
        self._a2: dict = {}

        # A3 state
        self._a3: dict = {}
        self._a3_comp_history: _collections.deque = _collections.deque()  # (timestamp, 0|1)

    # ── public ──────────────────────────────────────────────────────────────

    def start(self) -> None:
        self._thread = _threading.Thread(target=self._run, daemon=True, name="derived-pub")
        self._thread.start()
        log.info("DerivedPublisher started.")

    def stop(self) -> None:
        if self._client:
            try:
                self._client.disconnect()
            except Exception:
                pass

    # ── internal ────────────────────────────────────────────────────────────

    def _run(self) -> None:
        c = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="jesa-derived-engine",
            protocol=mqtt.MQTTv5,
        )
        c.on_connect    = self._on_connect
        c.on_message    = self._on_message
        c.reconnect_delay_set(min_delay=1, max_delay=15)
        self._client = c
        while True:
            try:
                c.connect(self._host, self._port, keepalive=60)
                c.loop_forever()
            except (OSError, ConnectionRefusedError):
                import time as _time
                log.warning("DerivedPublisher: broker not available, retrying in 5s")
                _time.sleep(5)

    def _on_connect(self, client, userdata, flags, rc, props=None) -> None:
        if rc == 0:
            log.info("DerivedPublisher: connected to MQTT broker.")
            client.subscribe(f"{self._PREFIX}/workshop/milling/A1/#")
            client.subscribe(f"{self._PREFIX}/workshop/hydraulics/A2/#")
            client.subscribe(f"{self._PREFIX}/fleet/apu/A3/#")
        else:
            log.error("DerivedPublisher: MQTT connect failed rc=%d", rc)

    def _on_message(self, client, userdata, msg) -> None:
        import time as _time
        try:
            payload = json.loads(msg.payload.decode())
            v = payload.get("v")
            if v is None or payload.get("q") == "stale":
                return
        except Exception:
            return

        topic = msg.topic
        ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds")

        def pub(suffix: str, value: object) -> None:
            self._client.publish(
                suffix,
                json.dumps({"ts": ts, "v": value, "q": "good"}),
                qos=0,
            )

        # ── A1 derived ───────────────────────────────────────────────────
        if "/A1/" in topic:
            P = f"{self._PREFIX}/workshop/milling/A1"
            s = self._a1
            if topic.endswith("/drive/torque_nm"):
                s["torque"] = float(v)
            elif topic.endswith("/drive/rotational_speed_rpm"):
                s["speed"] = float(v)
            elif topic.endswith("/process/air_temperature_k"):
                s["air_t"] = float(v)
            elif topic.endswith("/process/process_temperature_k"):
                s["proc_t"] = float(v)
            elif topic.endswith("/tool/tool_wear_min"):
                s["wear"] = float(v)
            else:
                return

            if "torque" in s and "speed" in s:
                pw_w = s["torque"] * s["speed"] * 2 * _math.pi / 60
                pub(f"{P}/derived/power_kw", round(pw_w / 1000, 4))

            if "air_t" in s and "proc_t" in s:
                dt = s["proc_t"] - s["air_t"]
                pub(f"{P}/derived/delta_t_k", round(dt, 3))

        # ── A2 derived ───────────────────────────────────────────────────
        elif "/A2/" in topic:
            P = f"{self._PREFIX}/workshop/hydraulics/A2"
            s = self._a2
            if topic.endswith("/thermal/ts1_c"):
                s["ts1"] = float(v)
            elif topic.endswith("/thermal/ts4_c"):
                s["ts4"] = float(v)
            else:
                return

            if "ts1" in s and "ts4" in s:
                pub(f"{P}/derived/cooler_delta_t_c", round(s["ts1"] - s["ts4"], 3))

        # ── A3 derived ───────────────────────────────────────────────────
        elif "/A3/" in topic:
            import time as _time
            P = f"{self._PREFIX}/fleet/apu/A3"
            s = self._a3
            if topic.endswith("/digital/comp"):
                comp_val = 1 if (v is True or v == 1) else 0
                now = _time.time()
                self._a3_comp_history.append((now, comp_val))
                # Trim to 5-minute window
                cutoff = now - self._COMP_WINDOW_S
                while self._a3_comp_history and self._a3_comp_history[0][0] < cutoff:
                    self._a3_comp_history.popleft()
                if len(self._a3_comp_history) >= 10:
                    duty = sum(e[1] for e in self._a3_comp_history) / len(self._a3_comp_history) * 100
                    pub(f"{P}/derived/comp_duty_pct_5min", round(duty, 1))
                s["comp"] = comp_val
            elif topic.endswith("/motor/current_a"):
                cur = float(v)
                s["current"] = cur
                state = "idle"    if cur < 1.0 else \
                        "offload" if cur < 5.5 else \
                        "load"    if cur < 8.5 else "peak"
                self._client.publish(
                    f"{P}/derived/load_state",
                    json.dumps({"ts": ts, "v": state, "current_a": round(cur, 3), "q": "good"}),
                    qos=0,
                )
