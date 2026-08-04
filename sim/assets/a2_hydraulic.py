"""A2 - Hydraulic test rig simulator (ZeMA condition monitoring dataset).

Cycle-based replay of the preprocessed 1 Hz archive produced by
``python -m sim.tools.prepare_a2``. Each of the 2205 load cycles lasts
60 dataset seconds; sensor values are published once per dataset second and
the four component condition labels (cooler, valve, pump leakage,
accumulator) are published at the start of each cycle, exactly as annotated
in profile.txt.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

import numpy as np

from sim import config
from sim.common import AssetSimulator, Tag

#: tag key -> npz array name
SENSOR_TAGS = {
    "Hydraulic/PS1_bar": "PS1",
    "Hydraulic/PS2_bar": "PS2",
    "Hydraulic/PS3_bar": "PS3",
    "Hydraulic/PS4_bar": "PS4",
    "Hydraulic/PS5_bar": "PS5",
    "Hydraulic/PS6_bar": "PS6",
    "Hydraulic/Flow1_lpm": "FS1",
    "Hydraulic/Flow2_lpm": "FS2",
    "Motor/Power_W": "EPS1",
    "Motor/Vibration_mms": "VS1",
    "Thermal/TS1_C": "TS1",
    "Thermal/TS2_C": "TS2",
    "Thermal/TS3_C": "TS3",
    "Thermal/TS4_C": "TS4",
    "KPIs/CoolingEfficiency_pct": "CE",
    "KPIs/CoolingPower_kW": "CP",
    "KPIs/EfficiencyFactor_pct": "SE",
}


class A2HydraulicSimulator(AssetSimulator):
    tags = [
        *(Tag(*key.split("/"), 0.0) for key in SENSOR_TAGS),
        Tag("Condition", "CoolerCondition_pct", 0),
        Tag("Condition", "ValveCondition_pct", 0),
        Tag("Condition", "PumpLeakage", 0),
        Tag("Condition", "AccumulatorPressure_bar", 0),
        Tag("Condition", "StableFlag", False),
        Tag("Simulation", "CycleIndex", 0),
        Tag("Simulation", "CycleSecond", 0),
    ]

    def __init__(self, speed: float | None = None, port: int | None = None):
        super().__init__(config.A2, speed=speed, port=port)
        if not config.A2_PREPARED.exists():
            raise FileNotFoundError(
                f"{config.A2_PREPARED} not found - run 'python -m sim.tools.prepare_a2' first"
            )
        archive = np.load(config.A2_PREPARED)
        self._sensors = {key: archive[name] for key, name in SENSOR_TAGS.items()}
        self._profile = archive["profile"]
        self._cycles, self._cycle_seconds = self._profile.shape[0], 60

    async def samples(self) -> AsyncIterator[tuple[dict[str, Any], float]]:
        while True:
            for cycle in range(self._cycles):
                raw_cooler, raw_valve, raw_pump, raw_accum, stable = self._profile[cycle]

                # --- OVERRIDE DÉMO JESA ---
                # Le dataset ZeMA contient des classes dégradées (20, 3, 0 …)
                # qui apparaissent en panne permanente dans le Live Twin.
                # On force l'état OPTIMAL pour tous les cycles :
                #   Cooler=100 (optimal), Valve=100, PumpLeakage=0 (no leak),
                #   Accumulator=130 (optimal pressure).
                # Les valeurs brutes du dataset restent consultables via
                # self._profile[cycle] pour debugging.
                cooler, valve, pump_leak, accumulator = 100, 100, 0, 130

                for second in range(self._cycle_seconds):
                    values: dict[str, Any] = {
                        key: arr[cycle, second] for key, arr in self._sensors.items()
                    }
                    values.update({
                        "Condition/CoolerCondition_pct": cooler,
                        "Condition/ValveCondition_pct": valve,
                        "Condition/PumpLeakage": pump_leak,
                        "Condition/AccumulatorPressure_bar": accumulator,
                        "Condition/StableFlag": stable,
                        "Simulation/CycleIndex": cycle,
                        "Simulation/CycleSecond": second,
                    })
                    yield values, 1.0
