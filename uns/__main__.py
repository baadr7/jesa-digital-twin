"""Entry point for the UNS gateway.

Usage:
    python -m uns                       # all sources, 1 Hz
    python -m uns --poll 0.5            # 500 ms poll interval
    python -m uns --sources a1 plc      # specific sources only
    python -m uns --broker 192.168.1.10 # remote MQTT broker
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from uns import config
from uns.gateway import run_gateway

SOURCE_MAP = {
    "a1": config.A1,
    "a2": config.A2,
    "a3": config.A3,
    "plc": config.PLC,
}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="JESA UNS Gateway — OPC UA → MQTT bridge")
    parser.add_argument(
        "--sources", nargs="*", metavar="SRC",
        choices=list(SOURCE_MAP), default=None,
        help="OPC UA sources to bridge (default: all). Choices: a1, a2, a3, plc")
    parser.add_argument(
        "--poll", type=float, default=config.POLL_INTERVAL_S,
        help=f"Poll interval in seconds (default: {config.POLL_INTERVAL_S})")
    parser.add_argument(
        "--broker", type=str, default=config.MQTT_HOST,
        help=f"MQTT broker host (default: {config.MQTT_HOST})")
    parser.add_argument(
        "--port", type=int, default=config.MQTT_PORT,
        help=f"MQTT broker port (default: {config.MQTT_PORT})")
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Enable debug logging")
    args = parser.parse_args()

    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(name)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    sources = None
    if args.sources:
        sources = [SOURCE_MAP[s] for s in args.sources]

    try:
        asyncio.run(run_gateway(
            sources=sources,
            poll_interval=args.poll,
            mqtt_host=args.broker,
            mqtt_port=args.port,
        ))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
