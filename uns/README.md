# UNS — Unified Namespace Gateway

## Architecture

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ A1 :4841 │  │ A2 :4842 │  │ A3 :4843 │  │ PLC :4840│
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     └──────────┬──┴────────────┬┴──────────────┘
                │  OPC UA poll (1 Hz)
         ┌──────┴──────┐
         │  python -m  │   ← Host process
         │    uns      │
         └──────┬──────┘
                │  MQTT publish (JSON)
         ┌──────┴──────┐
         │  Mosquitto  │   ← Docker container :1883 / :9001
         └──────┬──────┘
          ┌─────┴─────┐
     ┌────┴────┐ ┌────┴────┐
     │Telegraf │ │Phase 5  │
     │→InfluxDB│ │ML / 3D  │
     └─────────┘ └─────────┘
```

## Quick Start

### Prerequisites

- Python 3.10+ with `paho-mqtt` and `asyncua` installed
- Docker Desktop running (for the infrastructure stack)

### 1. Start the infrastructure

```bash
docker compose up -d
docker compose ps          # all 3 services should be healthy
```

### 2. Start the asset simulators + PLC

```bash
python -m sim all &        # asset servers on ports 4841-4843
python -m sim.plc &        # supervisory PLC on port 4840
```

### 3. Start the UNS gateway

```bash
python -m uns              # bridges OPC UA → MQTT
```

### 4. Verify

```bash
# Quick test: subscribe and see messages
docker exec jesa-mosquitto mosquitto_sub -t "jesa/#" -C 10

# Full verification
python -m uns.verify
```

### 5. Browse the data

- **MQTT**: `mosquitto_sub -h localhost -t "jesa/site1/#" -v`
- **InfluxDB UI**: http://localhost:8086 (login: `jesa` / `jesa-dev-2026`)
- **InfluxDB query**:
  ```flux
  from(bucket: "telemetry")
    |> range(start: -5m)
    |> filter(fn: (r) => r._measurement == "A1")
    |> limit(n: 10)
  ```

## CLI Options

```
python -m uns [OPTIONS]

  --sources SRC [SRC ...]   OPC UA sources to bridge (default: all)
                            Choices: a1, a2, a3, plc
  --poll SECONDS            Poll interval (default: 1.0)
  --broker HOST             MQTT broker host (default: 127.0.0.1)
  --port PORT               MQTT broker port (default: 1883)
  -v, --verbose             Enable debug logging
```

## Topic Hierarchy

See `docs/uns-spec.md` for the complete specification.

```
jesa/site1/workshop/milling/A1/drive/torque_nm
jesa/site1/workshop/hydraulics/A2/hydraulic/ps1_bar
jesa/site1/fleet/apu/A3/motor/current_a
jesa/site1/plc/a1/stop_command
```

## Payload Format

```json
{
  "ts": "2026-07-13T14:30:00.123Z",
  "v": 156.29,
  "q": "good"
}
```

## Files

| File | Purpose |
|---|---|
| `uns/__init__.py` | Package init |
| `uns/__main__.py` | CLI entry point |
| `uns/config.py` | OPC UA→MQTT mapping, broker settings, topic naming |
| `uns/gateway.py` | Async OPC UA poller + MQTT publisher |
| `uns/verify.py` | End-to-end verification script |
| `docs/uns-spec.md` | UNS specification (topic hierarchy, payload schema, QoS) |
| `docker-compose.yml` | Mosquitto + InfluxDB + Telegraf |
| `infra/mosquitto/mosquitto.conf` | Broker configuration |
| `infra/telegraf/telegraf.conf` | MQTT consumer → InfluxDB writer |
