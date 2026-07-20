"""Central configuration for the asset simulators.

Paths are resolved relative to the repository root so the package can be
launched from any working directory with ``python -m sim``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

A1_DATASET = REPO_ROOT / "ai4i+2020+predictive+maintenance+dataset" / "ai4i2020.csv"
A2_DATASET_DIR = REPO_ROOT / "condition+monitoring+of+hydraulic+systems"
A3_DATASET = REPO_ROOT / "metropt+3+dataset" / "MetroPT3(AirCompressor).csv"

# Preprocessed artefacts live next to the code, not next to the raw data.
DATA_DIR = REPO_ROOT / "sim" / "data"
A2_PREPARED = DATA_DIR / "a2_1hz.npz"


@dataclass(frozen=True)
class AssetConfig:
    """Static per-asset settings.

    ``default_speed`` is the replay acceleration: dataset seconds elapsed per
    real second. 1.0 replays in real time.
    """

    asset_id: str
    description: str
    port: int
    default_speed: float


A1 = AssetConfig(
    asset_id="A1",
    description="Milling machine (AI4I 2020 predictive maintenance dataset)",
    port=4841,
    default_speed=1.0,
)

A2 = AssetConfig(
    asset_id="A2",
    description="Hydraulic test rig (ZeMA condition monitoring dataset)",
    port=4842,
    default_speed=1.0,
)

A3 = AssetConfig(
    asset_id="A3",
    description="Metro APU air compressor (MetroPT-3 dataset)",
    port=4843,
    # 6 months of data; 60x lets one day of operation pass in 24 minutes.
    default_speed=60.0,
)

# Dataset-time seconds between two machined parts on A1 (one CSV row = one part).
A1_PART_INTERVAL_S = 10.0

# A3 recordings contain long gaps (train parked, logger offline). Any gap
# larger than this many dataset seconds is clamped so replay never stalls.
A3_MAX_GAP_S = 60.0
