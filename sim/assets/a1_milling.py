"""A1 - Milling machine simulator (AI4I 2020 dataset).

Event-based replay: one CSV row is one machined part. Every
``A1_PART_INTERVAL_S`` dataset seconds the process values of the next part
are published, so tool wear accumulates and the five labelled failure modes
(TWF, HDF, PWF, OSF, RNF) appear exactly as recorded. The dataset wraps
around after 10,000 parts.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

import pandas as pd

from sim import config
from sim.common import AssetSimulator, Tag


class A1MillingSimulator(AssetSimulator):
    tags = [
        Tag("Part", "ProductId", ""),
        Tag("Part", "ProductType", ""),
        Tag("Process", "AirTemperature_K", 0.0),
        Tag("Process", "ProcessTemperature_K", 0.0),
        Tag("Drive", "RotationalSpeed_rpm", 0.0),
        Tag("Drive", "Torque_Nm", 0.0),
        Tag("Tool", "ToolWear_min", 0),
        Tag("Status", "MachineFailure", False),
        Tag("Status", "TWF", False),
        Tag("Status", "HDF", False),
        Tag("Status", "PWF", False),
        Tag("Status", "OSF", False),
        Tag("Status", "RNF", False),
        Tag("Simulation", "PartIndex", 0),
    ]

    def __init__(self, speed: float | None = None, port: int | None = None):
        super().__init__(config.A1, speed=speed, port=port)
        self._df = pd.read_csv(config.A1_DATASET)

    async def samples(self) -> AsyncIterator[tuple[dict[str, Any], float]]:
        while True:
            for row in self._df.itertuples(index=False):
                # Column order: UDI, Product ID, Type, Air temperature [K],
                # Process temperature [K], Rotational speed [rpm],
                # Torque [Nm], Tool wear [min], Machine failure,
                # TWF, HDF, PWF, OSF, RNF
                (udi, product_id, ptype, air_t, proc_t, speed_rpm, torque,
                 wear, failure, twf, hdf, pwf, osf, rnf) = row
                values = {
                    "Part/ProductId": product_id,
                    "Part/ProductType": ptype,
                    "Process/AirTemperature_K": air_t,
                    "Process/ProcessTemperature_K": proc_t,
                    "Drive/RotationalSpeed_rpm": speed_rpm,
                    "Drive/Torque_Nm": torque,
                    "Tool/ToolWear_min": wear,
                    "Status/MachineFailure": failure,
                    "Status/TWF": twf,
                    "Status/HDF": hdf,
                    "Status/PWF": pwf,
                    "Status/OSF": osf,
                    "Status/RNF": rnf,
                    "Simulation/PartIndex": udi,
                }
                yield values, config.A1_PART_INTERVAL_S
