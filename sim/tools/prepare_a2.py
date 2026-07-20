"""Preprocess the ZeMA hydraulic dataset for replay.

The raw dataset stores each sensor as a (2205 cycles x N samples) matrix,
with N depending on the sampling rate (100 Hz -> 6000, 10 Hz -> 600,
1 Hz -> 60 samples per 60 s cycle). Streaming raw 100 Hz waveforms through
OPC UA and the UNS would be wasteful (roughly 450 MB of text), so every
sensor is downsampled to 1 Hz by averaging within each second, giving a
uniform (2205 x 60) matrix per sensor. The per-cycle condition labels from
profile.txt are carried along unchanged.

Output: sim/data/a2_1hz.npz (float32, compressed).

Usage:
    python -m sim.tools.prepare_a2
"""

from __future__ import annotations

import logging
import time

import numpy as np
import pandas as pd

from sim import config

log = logging.getLogger("sim.prepare_a2")

CYCLES = 2205
CYCLE_SECONDS = 60

#: sensor file stem -> native samples per cycle
SENSORS = {
    "PS1": 6000, "PS2": 6000, "PS3": 6000, "PS4": 6000, "PS5": 6000, "PS6": 6000,
    "EPS1": 6000,
    "FS1": 600, "FS2": 600,
    "TS1": 60, "TS2": 60, "TS3": 60, "TS4": 60,
    "VS1": 60,
    "CE": 60, "CP": 60, "SE": 60,
}


def load_sensor(name: str, samples_per_cycle: int) -> np.ndarray:
    """Load one sensor matrix and downsample it to 1 Hz (2205 x 60)."""
    path = config.A2_DATASET_DIR / f"{name}.txt"
    raw = pd.read_csv(path, sep="\t", header=None, dtype=np.float32).to_numpy()
    if raw.shape != (CYCLES, samples_per_cycle):
        raise ValueError(f"{name}: unexpected shape {raw.shape}")
    per_second = samples_per_cycle // CYCLE_SECONDS
    if per_second == 1:
        return raw
    return raw.reshape(CYCLES, CYCLE_SECONDS, per_second).mean(axis=2, dtype=np.float32)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)

    arrays: dict[str, np.ndarray] = {}
    for name, samples in SENSORS.items():
        t0 = time.perf_counter()
        arrays[name] = load_sensor(name, samples)
        log.info("%-5s loaded and downsampled in %.1fs", name, time.perf_counter() - t0)

    profile = pd.read_csv(
        config.A2_DATASET_DIR / "profile.txt", sep="\t", header=None,
        names=["cooler", "valve", "pump_leak", "accumulator", "stable"],
    ).to_numpy(dtype=np.int32)
    if profile.shape != (CYCLES, 5):
        raise ValueError(f"profile.txt: unexpected shape {profile.shape}")
    arrays["profile"] = profile

    np.savez_compressed(config.A2_PREPARED, **arrays)
    size_mb = config.A2_PREPARED.stat().st_size / 1e6
    log.info("wrote %s (%.1f MB)", config.A2_PREPARED, size_mb)


if __name__ == "__main__":
    main()
