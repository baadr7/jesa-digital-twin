"""Unit tests for uns/gateway.py.

Tests:
- _to_snake() CamelCase → snake_case conversion (incl. acronyms and units)
- AssetMapping.topic() builds correct MQTT topic paths
- PlcMapping.topic() builds correct PLC topic paths
- AssetMapping.is_retained() / qos() policy
- _json_safe() handles all OPC UA variant types
"""
from __future__ import annotations

import pytest

from uns.config import _to_snake, A1, A2, A3, PLC
from uns.gateway import _json_safe


# ── _to_snake ──────────────────────────────────────────────────────────────

class TestToSnake:
    """Verify the CamelCase → snake_case converter."""

    def test_simple_camel(self):
        assert _to_snake("ToolWear") == "tool_wear"

    def test_with_unit_suffix(self):
        assert _to_snake("ToolWear_min") == "tool_wear_min"
        assert _to_snake("RotationalSpeed_rpm") == "rotational_speed_rpm"
        assert _to_snake("Torque_Nm") == "torque_nm"

    def test_acronym_kpis(self):
        assert _to_snake("KPIs") == "kpis"

    def test_acronym_dv_pressure(self):
        assert _to_snake("DVPressure") == "dv_pressure"

    def test_acronym_cooling_power_kw(self):
        assert _to_snake("CoolingPower_kW") == "cooling_power_kw"

    def test_already_snake(self):
        assert _to_snake("ps1_bar") == "ps1_bar"

    def test_single_word(self):
        assert _to_snake("Torque") == "torque"

    def test_two_consecutive_upper(self):
        # e.g. "TWF" → "twf"
        assert _to_snake("TWF") == "twf"

    def test_no_double_underscore(self):
        result = _to_snake("AirTemperature_K")
        assert "__" not in result
        assert result == "air_temperature_k"


# ── AssetMapping.topic() ──────────────────────────────────────────────────

class TestAssetMappingTopic:
    def test_a1_torque(self):
        assert A1.topic("Drive", "Torque_Nm") == \
            "jesa/site1/workshop/milling/A1/drive/torque_nm"

    def test_a1_tool_wear(self):
        assert A1.topic("Tool", "ToolWear_min") == \
            "jesa/site1/workshop/milling/A1/tool/tool_wear_min"

    def test_a1_machine_failure(self):
        assert A1.topic("Status", "MachineFailure") == \
            "jesa/site1/workshop/milling/A1/status/machine_failure"

    def test_a2_ps1(self):
        assert A2.topic("Hydraulic", "PS1_bar") == \
            "jesa/site1/workshop/hydraulics/A2/hydraulic/ps1_bar"

    def test_a2_cooling_efficiency(self):
        assert A2.topic("KPIs", "CoolingEfficiency_pct") == \
            "jesa/site1/workshop/hydraulics/A2/kpis/cooling_efficiency_pct"

    def test_a2_cooling_power_kw(self):
        assert A2.topic("KPIs", "CoolingPower_kW") == \
            "jesa/site1/workshop/hydraulics/A2/kpis/cooling_power_kw"

    def test_a3_tp2(self):
        assert A3.topic("Pneumatic", "TP2_bar") == \
            "jesa/site1/fleet/apu/A3/pneumatic/tp2_bar"

    def test_a3_dv_pressure(self):
        assert A3.topic("Pneumatic", "DVPressure_bar") == \
            "jesa/site1/fleet/apu/A3/pneumatic/dv_pressure_bar"

    def test_a3_source_timestamp(self):
        assert A3.topic("Simulation", "SourceTimestamp") == \
            "jesa/site1/fleet/apu/A3/simulation/source_timestamp"


# ── PlcMapping.topic() ────────────────────────────────────────────────────

class TestPlcMappingTopic:
    def test_system_mode(self):
        assert PLC.topic("System", "Mode") == "jesa/site1/plc/system/mode"

    def test_a1_comm_fault(self):
        assert PLC.topic("A1", "CommFault") == "jesa/site1/plc/a1/comm_fault"

    def test_a2_motor_overload(self):
        assert PLC.topic("A2", "MotorOverload") == "jesa/site1/plc/a2/motor_overload"

    def test_a3_low_pressure(self):
        assert PLC.topic("A3", "LowPressure") == "jesa/site1/plc/a3/low_pressure"


# ── Retain / QoS policy ───────────────────────────────────────────────────

class TestRetainPolicy:
    def test_identification_retained(self):
        assert A1.is_retained("Identification", "AssetId") is True

    def test_speed_factor_retained(self):
        assert A1.is_retained("Simulation", "SpeedFactor") is True

    def test_process_tag_retained(self):
        """Process folder is now fully retained (all folders are)."""
        assert A1.is_retained("Process", "AirTemperature_K") is True

    def test_identification_qos1(self):
        assert A1.qos("Identification", "AssetId") == 1

    def test_process_qos1(self):
        """All retained folders use QoS 1."""
        assert A1.qos("Process", "AirTemperature_K") == 1


# ── _json_safe ────────────────────────────────────────────────────────────

class TestJsonSafe:
    def test_int(self):
        assert _json_safe(42) == 42

    def test_float(self):
        assert _json_safe(3.14) == pytest.approx(3.14)

    def test_string(self):
        assert _json_safe("hello") == "hello"

    def test_bool_true(self):
        assert _json_safe(True) is True

    def test_bool_false(self):
        assert _json_safe(False) is False

    def test_bytes(self):
        assert _json_safe(b"abc") == "abc"

    def test_numpy_scalar(self):
        """Objects with .real attribute (numpy scalar) → float via float(value)."""
        # Use a real numeric type that has .real (complex number's real part works)
        # In production this is numpy.float64; we test with a minimal stand-in
        # that actually supports float() conversion.
        class FakeNumpy(float):
            """Minimal numpy scalar stand-in: is a float, has .real."""
            pass
        val = FakeNumpy(1.23)
        assert _json_safe(val) == pytest.approx(1.23)

    def test_unknown_object_becomes_string(self):
        result = _json_safe(object())
        assert isinstance(result, str)
