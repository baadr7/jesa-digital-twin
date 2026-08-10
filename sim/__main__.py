"""Command-line entry point for the asset simulators.

Examples:
    python -m sim a1                        # milling machine, real time, port 4841
    python -m sim a3 --speed 600            # APU compressor, 600x accelerated
    python -m sim all                       # all three assets in one process
    python -m sim all --demo-stable         # force A2/A3 to healthy state (for presentations)
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

from sim.assets import A1MillingSimulator, A2HydraulicSimulator, A3ApuSimulator

SIMULATORS = {
    "a1": A1MillingSimulator,
    "a2": A2HydraulicSimulator,
    "a3": A3ApuSimulator,
}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m sim",
        description="JESA digital twin - dataset replay OPC UA servers",
    )
    parser.add_argument("asset", choices=[*SIMULATORS, "all"], help="asset to simulate")
    parser.add_argument(
        "--speed", type=float, default=None,
        help="replay acceleration (dataset seconds per real second); "
             "defaults per asset: a1=1, a2=1, a3=60",
    )
    parser.add_argument(
        "--port", type=int, default=None,
        help="OPC UA port override (single asset only)",
    )
    parser.add_argument(
        "--demo-stable", action="store_true", default=False,
        help=(
            "Force A2 condition labels to optimal (cooler=100, valve=100, pump=0, accum=130) "
            "and suppress A3 LPS/OilLevel flags. "
            "Use for live demonstrations where a permanently-degraded display is undesirable. "
            "Sets env var JESA_DEMO_STABLE=1 which the simulators check at runtime."
        ),
    )
    args = parser.parse_args(argv)
    if args.asset == "all" and args.port is not None:
        parser.error("--port cannot be used with 'all'")
    return args


async def amain(args: argparse.Namespace) -> None:
    if args.demo_stable:
        os.environ["JESA_DEMO_STABLE"] = "1"
        logging.getLogger("sim").info(
            "Demo-stable mode ON — A2 conditions forced optimal, A3 flags suppressed"
        )
    names = list(SIMULATORS) if args.asset == "all" else [args.asset]
    sims = [SIMULATORS[name](speed=args.speed, port=args.port) for name in names]
    await asyncio.gather(*(sim.run() for sim in sims))


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("asyncua").setLevel(logging.WARNING)
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        logging.getLogger("sim").info("stopped by user")


if __name__ == "__main__":
    main()
