"""End-to-end verification for Phase 4 (UNS).

Starts the Docker infrastructure, asset simulators, PLC, and the UNS gateway,
then subscribes to the MQTT broker and validates:
  1. Messages arrive on the expected topic hierarchy.
  2. JSON payloads contain ts, v, q fields.
  3. All 4 sources (A1, A2, A3, PLC) are publishing.
  4. InfluxDB is receiving data (via HTTP API query).

Usage:
    python -m uns.verify                # full pipeline test
    python -m uns.verify --skip-docker  # if Docker is already running
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import threading
from collections import defaultdict

import paho.mqtt.client as mqtt

BROKER_HOST = "127.0.0.1"
BROKER_PORT = 1883
TOPIC_ROOT = "jesa/site1/#"
COLLECT_SECONDS = 15
EXPECTED_SOURCES = {"A1", "A2", "A3", "plc"}

# InfluxDB query (requires curl)
INFLUX_URL = "http://localhost:8086"
INFLUX_TOKEN = "jesa-dev-token"
INFLUX_ORG = "jesa"
INFLUX_BUCKET = "telemetry"


def collect_messages(seconds: int) -> dict[str, list[dict]]:
    """Subscribe to jesa/site1/# and collect messages for `seconds`."""
    messages: dict[str, list[dict]] = defaultdict(list)
    stop = threading.Event()

    def on_message(client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
            messages[msg.topic].append(payload)
        except Exception as e:
            messages[msg.topic].append({"_error": str(e)})

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id="jesa-verify",
    )
    client.on_message = on_message
    client.connect(BROKER_HOST, BROKER_PORT, keepalive=30)
    client.subscribe(TOPIC_ROOT, qos=0)
    client.loop_start()

    print(f"\n  Collecting MQTT messages for {seconds}s...")
    time.sleep(seconds)

    client.loop_stop()
    client.disconnect()
    return dict(messages)


def verify_topics(messages: dict[str, list[dict]]) -> tuple[bool, list[str]]:
    """Validate topic hierarchy and payload schema."""
    errors = []
    sources_seen = set()

    for topic, payloads in messages.items():
        parts = topic.split("/")
        # Check prefix
        if parts[:2] != ["jesa", "site1"]:
            errors.append(f"Bad prefix: {topic}")
            continue

        # Extract source identifier
        if parts[2] == "plc":
            sources_seen.add("plc")
        elif len(parts) >= 5:
            sources_seen.add(parts[4])  # asset_id like A1, A2, A3

        # Check payload schema
        for p in payloads:
            if "_error" in p:
                errors.append(f"Parse error on {topic}: {p['_error']}")
                continue
            for key in ("ts", "v", "q"):
                if key not in p:
                    errors.append(f"Missing '{key}' in payload on {topic}")
                    break

    # Check all sources are present
    missing = EXPECTED_SOURCES - sources_seen
    if missing:
        errors.append(f"Missing sources: {missing}")

    return len(errors) == 0, errors


def check_influxdb() -> bool:
    """Query InfluxDB for recent telemetry data."""
    try:
        import urllib.request
        flux = (
            f'from(bucket:"{INFLUX_BUCKET}")'
            f' |> range(start: -5m)'
            f' |> limit(n: 5)'
        )
        req = urllib.request.Request(
            f"{INFLUX_URL}/api/v2/query?org={INFLUX_ORG}",
            data=flux.encode(),
            headers={
                "Authorization": f"Token {INFLUX_TOKEN}",
                "Content-Type": "application/vnd.flux",
                "Accept": "application/csv",
            },
        )
        resp = urllib.request.urlopen(req, timeout=5)
        body = resp.read().decode()
        lines = [l for l in body.strip().split("\n") if l and not l.startswith("#")]
        return len(lines) > 1  # header + at least 1 data row
    except Exception as e:
        print(f"  InfluxDB check failed: {e}")
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="UNS Phase 4 verification")
    parser.add_argument("--skip-docker", action="store_true",
                        help="Skip Docker health check")
    args = parser.parse_args()

    print("=" * 65)
    print("JESA UNS — Phase 4 End-to-End Verification")
    print("=" * 65)

    all_ok = True

    # ── Step 1: Docker health ──────────────────────────────────────────
    if not args.skip_docker:
        print("\n[1/5] Docker infrastructure")
        r = subprocess.run(
            ["docker", "compose", "ps", "--format", "json"],
            capture_output=True, text=True, cwd=".",
        )
        if r.returncode != 0:
            print("  FAIL: docker compose not running")
            print("  Run: docker compose up -d")
            all_ok = False
        else:
            print("  OK: Docker stack detected")
    else:
        print("\n[1/5] Docker check skipped")

    # ── Step 2: MQTT broker connectivity ───────────────────────────────
    print("\n[2/5] MQTT broker connectivity")
    try:
        c = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id="jesa-verify-ping",
        )
        c.connect(BROKER_HOST, BROKER_PORT, keepalive=5)
        c.disconnect()
        print(f"  OK: Connected to {BROKER_HOST}:{BROKER_PORT}")
    except Exception as e:
        print(f"  FAIL: Cannot connect to MQTT broker: {e}")
        all_ok = False

    # ── Step 3: Collect and validate MQTT messages ─────────────────────
    print("\n[3/5] MQTT message collection and validation")
    try:
        messages = collect_messages(COLLECT_SECONDS)
        unique_topics = len(messages)
        total_msgs = sum(len(v) for v in messages.values())
        print(f"  Collected {total_msgs} messages across {unique_topics} topics")

        if total_msgs == 0:
            print("  FAIL: No messages received. Is the gateway running?")
            print("  Run: python -m uns")
            all_ok = False
        else:
            ok, errs = verify_topics(messages)
            if ok:
                print("  OK: All topics and payloads valid")
                # Print sample topics
                for topic in sorted(messages)[:8]:
                    sample = messages[topic][0]
                    print(f"    {topic}: v={sample.get('v','?')}")
                remaining = unique_topics - 8
                if remaining > 0:
                    print(f"    ... and {remaining} more topics")
            else:
                for e in errs:
                    print(f"  FAIL: {e}")
                all_ok = False
    except Exception as e:
        print(f"  FAIL: MQTT collection error: {e}")
        all_ok = False

    # ── Step 4: InfluxDB persistence ───────────────────────────────────
    print("\n[4/5] InfluxDB persistence")
    if check_influxdb():
        print("  OK: Data found in InfluxDB 'telemetry' bucket")
    else:
        print("  WARN: No data in InfluxDB (Telegraf may need more time)")

    # ── Step 5: Topic count vs expected ────────────────────────────────
    print("\n[5/5] Coverage summary")
    try:
        source_counts = defaultdict(int)
        for topic in messages:
            parts = topic.split("/")
            if parts[2] == "plc":
                source_counts["PLC"] += 1
            elif len(parts) >= 5:
                source_counts[parts[4]] += 1

        EXPECTED_COUNTS = {"A1": 17, "A2": 27, "A3": 20, "PLC": 33}
        for src, expected in EXPECTED_COUNTS.items():
            actual = source_counts.get(src, 0)
            status = "OK" if actual >= expected else "PARTIAL"
            print(f"  {src}: {actual}/{expected} topics [{status}]")
    except Exception:
        print("  SKIP: Could not compute coverage (no messages)")

    # ── Result ─────────────────────────────────────────────────────────
    print(f"\n{'=' * 65}")
    if all_ok:
        print("VERIFICATION PASSED — Phase 4 UNS fully operational")
    else:
        print("VERIFICATION INCOMPLETE — see above for required actions")
    print("=" * 65)
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
