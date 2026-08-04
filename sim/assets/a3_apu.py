"""A3 - Metro APU air compressor simulator (MetroPT-3 dataset).

Time-accelerated stream replay of the 15.17 M row CSV (Feb-Aug 2020,
nominally 1 Hz). The file is read in chunks so memory stays flat, and the
pause between two samples is derived from the recorded timestamps; logging
gaps longer than ``A3_MAX_GAP_S`` are clamped so replay never stalls while
the train was parked. The recorded timestamp is republished as
``Simulation/SourceTimestamp`` so downstream consumers can correlate
anomalies with the documented air-leak failures.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

import pandas as pd

from sim import config
from sim.common import AssetSimulator, Tag

#: tag key -> CSV column ("DV_eletric" is misspelled in the source file)
COLUMN_TAGS = {
    "Pneumatic/TP2_bar": "TP2",
    "Pneumatic/TP3_bar": "TP3",
    "Pneumatic/H1_bar": "H1",
    "Pneumatic/DVPressure_bar": "DV_pressure",
    "Pneumatic/Reservoirs_bar": "Reservoirs",
    "Motor/Current_A": "Motor_current",
    "Oil/Temperature_C": "Oil_temperature",
    "Digital/COMP": "COMP",
    "Digital/DVElectric": "DV_eletric",
    "Digital/Towers": "Towers",
    "Digital/MPG": "MPG",
    "Digital/LPS": "LPS",
    "Digital/PressureSwitch": "Pressure_switch",
    "Digital/OilLevel": "Oil_level",
    "Digital/CaudalImpulses": "Caudal_impulses",
}

ANALOG_PREFIXES = ("Pneumatic/", "Motor/", "Oil/")
CHUNK_ROWS = 20_000


class A3ApuSimulator(AssetSimulator):
    tags = [
        *(
            Tag(*key.split("/"), 0.0 if key.startswith(ANALOG_PREFIXES) else False)
            for key in COLUMN_TAGS
        ),
        Tag("Simulation", "RowIndex", 0),
        Tag("Simulation", "SourceTimestamp", ""),
    ]

    def __init__(self, speed: float | None = None, port: int | None = None):
        super().__init__(config.A3, speed=speed, port=port)
        if not config.A3_DATASET.exists():
            raise FileNotFoundError(config.A3_DATASET)

    def _chunks(self):
        return pd.read_csv(
            config.A3_DATASET,
            index_col=0,
            parse_dates=["timestamp"],
            chunksize=CHUNK_ROWS,
        )

    async def samples(self) -> AsyncIterator[tuple[dict[str, Any], float]]:
        while True:
            previous_ts: pd.Timestamp | None = None
            for chunk in self._chunks():
                timestamps = chunk["timestamp"]
                columns = {key: chunk[col] for key, col in COLUMN_TAGS.items()}
                for pos in range(len(chunk)):
                    ts = timestamps.iloc[pos]
                    if previous_ts is None:
                        dt = 1.0
                    else:
                        dt = min(max((ts - previous_ts).total_seconds(), 0.0),
                                 config.A3_MAX_GAP_S)
                    previous_ts = ts
                    values: dict[str, Any] = {
                        key: series.iloc[pos] for key, series in columns.items()
                    }
                    values["Simulation/RowIndex"] = chunk.index[pos]
                    values["Simulation/SourceTimestamp"] = ts.isoformat()

                    # --- OVERRIDE DÉMO JESA ---
                    # Le dataset MetroPT-3 contient des phases où
                    # LPS=1 (Low Pressure Switch < 7 bar) et Oil_level=1
                    # (niveau huile bas) sur de longues périodes. Pour la
                    # démonstration on force ces drapeaux à 0 (nominal) afin
                    # qu'A3 n'apparaisse pas en warning permanent sur le
                    # dashboard simulator et dans le PLC.
                    values["Digital/LPS"]       = 0
                    values["Digital/OilLevel"]  = 0

                    yield values, dt
