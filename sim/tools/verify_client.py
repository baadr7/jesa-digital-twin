"""OPC UA verification client for the asset simulators and the PLC.

Connects to one or more endpoints, browses the full address space and reads
every variable twice with a delay in between, proving that values are being
published and are actually changing.

Usage:
    python -m sim.tools.verify_client                  # a1 a2 a3 plc
    python -m sim.tools.verify_client a1 plc
    python -m sim.tools.verify_client a1 --delay 12
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass
from typing import Any

from asyncua.client.client import Client
from asyncua import ua

from sim import config
from sim.plc import PLC_PORT


@dataclass(frozen=True)
class Target:
    object_name: str
    namespace: str
    url: str


def _sim_target(cfg: config.AssetConfig) -> Target:
    asset = cfg.asset_id.lower()
    return Target(cfg.asset_id, f"urn:jesa:sim:{asset}",
                  f"opc.tcp://127.0.0.1:{cfg.port}/jesa/{asset}")


TARGETS = {
    "a1": _sim_target(config.A1),
    "a2": _sim_target(config.A2),
    "a3": _sim_target(config.A3),
    "plc": Target("PLC", "urn:jesa:plc", f"opc.tcp://127.0.0.1:{PLC_PORT}/jesa/plc"),
}


async def read_all_variables(client: Client, target: Target) -> dict[str, Any]:
    """Read every variable under Objects/<object_name>, keyed by Folder/Name."""
    nsidx = await client.get_namespace_index(target.namespace)
    root = await client.nodes.objects.get_child(f"{nsidx}:{target.object_name}")
    out: dict[str, Any] = {}
    for folder in await root.get_children():
        folder_name = (await folder.read_browse_name()).Name
        for node in await folder.get_children():
            if await node.read_node_class() != ua.NodeClass.Variable:
                continue
            name = (await node.read_browse_name()).Name
            out[f"{folder_name}/{name}"] = await node.read_value()
    return out


async def verify(target: Target, delay: float) -> bool:
    async with Client(target.url) as client:
        first = await read_all_variables(client, target)
        await asyncio.sleep(delay)
        second = await read_all_variables(client, target)

    changed = sorted(k for k in first if first[k] != second[k])
    print(f"\n{target.object_name} @ {target.url}")
    print(f"  variables: {len(first)}, changed after {delay:.0f}s: {len(changed)}")
    for key in sorted(first):
        marker = "*" if key in changed else " "
        print(f"  {marker} {key:38} {first[key]!r:>24}  ->  {second[key]!r}")

    ok = bool(changed)
    if not ok:
        print(f"  FAIL: no variable changed on {target.object_name}")
    return ok


async def amain(names: list[str], delay: float) -> int:
    results = [await verify(TARGETS[name], delay) for name in names]
    print("\nresult:", "OK" if all(results) else "FAIL")
    return 0 if all(results) else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify running simulators / PLC")
    parser.add_argument("targets", nargs="*", metavar="target",
                        help="a1, a2, a3, plc (default: all)")
    parser.add_argument("--delay", type=float, default=5.0,
                        help="seconds between the two reads (default 5)")
    args = parser.parse_args()
    names = [name.lower() for name in args.targets] or list(TARGETS)
    unknown = [name for name in names if name not in TARGETS]
    if unknown:
        parser.error(f"unknown target(s): {', '.join(unknown)}")
    sys.exit(asyncio.run(amain(names, args.delay)))


if __name__ == "__main__":
    main()
