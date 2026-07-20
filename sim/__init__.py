"""JESA digital twin - asset simulation package.

Replays the three reference datasets as live OPC UA servers:

    A1  Milling machine        (AI4I 2020)                 opc.tcp://:4841
    A2  Hydraulic test rig     (ZeMA condition monitoring) opc.tcp://:4842
    A3  APU air compressor     (MetroPT-3)                 opc.tcp://:4843

See sim/README.md for usage and the OPC UA address space layout.
"""

__version__ = "0.1.0"
