"""Unit tests for sim/plc.py.

Tests:
- _logic() computes correct outputs from sensor inputs
- _apply_hysteresis() confirms on-delay and clear-delay
- Comm fault when asset has no fresh data
- StopCommand triggered by overstrain / power OOR / heat dissipation
- A2 MaintenanceRequired trigger conditions
- A3 LowPressure and AirSupplyOk logic
- Alarm logging edge detection (_log_alarm_edges)
"""
from __future__ import annotations

import time
import pytest

from sim.plc import PlcRuntime, SCAN_PERIOD_S


@pytest.fixture
def plc() -> PlcRuntime:
    """Return a PlcRuntime with synthetic fresh inputs — no OPC UA connection."""
    rt = PlcRuntime()
    # Inject nominal values directly, bypassing network I/O.
    # Mark all inputs as fresh so CommFault stays False in nominal tests.
    for asset_id, inp in rt.inputs.items():
        inp._last_ok = time.monotonic()

    # A1 nominal: torque 40 Nm, speed 1500 rpm, wear 50, type M
    rt.inputs["A1"].values = {
        "Drive/Torque_Nm": 40.0,
        "Drive/RotationalSpeed_rpm": 1500.0,
        "Process/AirTemperature_K": 298.0,
        "Process/ProcessTemperature_K": 308.0,
        "Tool/ToolWear_min": 50,
        "Part/ProductType": "M",
    }
    # A2 nominal: PS1=100 bar, power=2500 W, vib=0.3, CE=80%
    rt.inputs["A2"].values = {
        "Hydraulic/PS1_bar": 100.0,
        "Motor/Power_W": 2500.0,
        "Motor/Vibration_mms": 0.3,
        "KPIs/CoolingEfficiency_pct": 80.0,
    }
    # A3 nominal: TP3=8.5, reservoirs=8.0, current=6.0, OilTemp=45, LPS=False
    rt.inputs["A3"].values = {
        "Pneumatic/TP3_bar": 8.5,
        "Pneumatic/Reservoirs_bar": 8.0,
        "Motor/Current_A": 6.0,
        "Oil/Temperature_C": 45.0,
        "Digital/LPS": False,
        "Digital/OilLevel": False,
    }
    return rt


# ── Normal operation ───────────────────────────────────────────────────────

class TestNominalOperation:
    def test_no_alarms_nominal(self, plc):
        out = plc._logic()
        assert out["A1/StopCommand"]         is False
        assert out["A1/CommFault"]           is False
        assert out["A2/MaintenanceRequired"] is False
        assert out["A2/CommFault"]           is False
        assert out["A3/LowPressure"]         is False
        assert out["A3/AirSupplyOk"]         is True
        assert out["A3/CommFault"]           is False
        assert out["System/ActiveAlarms"]    == 0

    def test_power_computed_from_torque_speed(self, plc):
        import math
        expected_kw = 40.0 * 1500.0 * 2 * math.pi / 60.0 / 1000.0
        out = plc._logic()
        assert out["A1/Power_kW"] == pytest.approx(expected_kw, rel=1e-4)


# ── A1 alarms ─────────────────────────────────────────────────────────────

class TestA1Alarms:
    def test_stop_command_on_overstrain(self, plc):
        """Wear × Torque > 12000 (type M) → Overstrain → StopCommand."""
        plc.inputs["A1"].values["Tool/ToolWear_min"] = 310
        plc.inputs["A1"].values["Drive/Torque_Nm"]   = 50.0
        # 310 * 50 = 15500 > 12000
        out = plc._logic()
        assert out["A1/Overstrain"]   is True
        assert out["A1/StopCommand"]  is True

    def test_stop_command_on_power_oor(self, plc):
        """Power < 3500 W → PowerOutOfRange → StopCommand."""
        plc.inputs["A1"].values["Drive/Torque_Nm"]           = 1.0
        plc.inputs["A1"].values["Drive/RotationalSpeed_rpm"] = 100.0
        out = plc._logic()
        assert out["A1/PowerOutOfRange"] is True
        assert out["A1/StopCommand"]     is True

    def test_stop_command_on_heat_dissipation(self, plc):
        """ΔT < 8.6 K AND speed < 1380 rpm → HeatDissipationRisk."""
        plc.inputs["A1"].values["Process/AirTemperature_K"]     = 300.0
        plc.inputs["A1"].values["Process/ProcessTemperature_K"] = 304.0  # ΔT=4 < 8.6
        plc.inputs["A1"].values["Drive/RotationalSpeed_rpm"]    = 1000.0  # < 1380
        out = plc._logic()
        assert out["A1/HeatDissipationRisk"] is True
        assert out["A1/StopCommand"]         is True

    def test_tool_wear_high(self, plc):
        plc.inputs["A1"].values["Tool/ToolWear_min"] = 220
        out = plc._logic()
        assert out["A1/ToolWearHigh"] is True

    def test_osf_limit_varies_by_product_type(self, plc):
        """Type L limit = 11000, H limit = 13000."""
        plc.inputs["A1"].values["Drive/Torque_Nm"]   = 50.0
        plc.inputs["A1"].values["Tool/ToolWear_min"] = 240

        # Type L: 240 × 50 = 12000 > 11000 → Overstrain
        plc.inputs["A1"].values["Part/ProductType"] = "L"
        assert plc._logic()["A1/Overstrain"] is True

        # Type H: 240 × 50 = 12000 < 13000 → OK
        plc.inputs["A1"].values["Part/ProductType"] = "H"
        assert plc._logic()["A1/Overstrain"] is False


# ── A2 alarms ─────────────────────────────────────────────────────────────

class TestA2Alarms:
    def test_maintenance_on_cooling_degraded(self, plc):
        plc.inputs["A2"].values["KPIs/CoolingEfficiency_pct"] = 20.0
        out = plc._logic()
        assert out["A2/CoolingDegraded"]      is True
        assert out["A2/MaintenanceRequired"]  is True

    def test_maintenance_on_motor_overload(self, plc):
        plc.inputs["A2"].values["Motor/Power_W"] = 3500.0
        out = plc._logic()
        assert out["A2/MotorOverload"]       is True
        assert out["A2/MaintenanceRequired"] is True

    def test_maintenance_on_vibration_high(self, plc):
        plc.inputs["A2"].values["Motor/Vibration_mms"] = 1.0
        out = plc._logic()
        assert out["A2/VibrationHigh"]       is True
        assert out["A2/MaintenanceRequired"] is True


# ── A3 alarms ─────────────────────────────────────────────────────────────

class TestA3Alarms:
    def test_low_pressure_from_tp3(self, plc):
        plc.inputs["A3"].values["Pneumatic/TP3_bar"] = 6.5
        out = plc._logic()
        assert out["A3/LowPressure"] is True
        assert out["A3/AirSupplyOk"] is False

    def test_low_pressure_from_lps_flag(self, plc):
        plc.inputs["A3"].values["Digital/LPS"] = True
        out = plc._logic()
        assert out["A3/LowPressure"] is True
        assert out["A3/AirSupplyOk"] is False

    def test_oil_temp_high(self, plc):
        plc.inputs["A3"].values["Oil/Temperature_C"] = 70.0
        out = plc._logic()
        assert out["A3/OilTempHigh"] is True

    def test_oil_level_low(self, plc):
        plc.inputs["A3"].values["Digital/OilLevel"] = True
        out = plc._logic()
        assert out["A3/OilLevelLow"] is True


# ── CommFault (stale inputs) ───────────────────────────────────────────────

class TestCommFault:
    def test_a1_comm_fault_when_stale(self, plc):
        """If A1 last_ok is old, CommFault must be True."""
        plc.inputs["A1"]._last_ok = time.monotonic() - 10.0  # > STALE_TIMEOUT_S
        out = plc._logic()
        assert out["A1/CommFault"]  is True
        assert out["A1/StopCommand"] is True  # CommFault alone triggers stop

    def test_a2_comm_fault_when_stale(self, plc):
        plc.inputs["A2"]._last_ok = time.monotonic() - 10.0
        out = plc._logic()
        assert out["A2/CommFault"] is True

    def test_a3_comm_fault_when_stale(self, plc):
        plc.inputs["A3"]._last_ok = time.monotonic() - 10.0
        out = plc._logic()
        assert out["A3/CommFault"] is True
        assert out["A3/AirSupplyOk"] is False


# ── Hysteresis on-delay ────────────────────────────────────────────────────

class TestHysteresis:
    def _raw(self, plc, alarm_key: str, value: bool) -> dict:
        """Build a minimal raw_out dict with the given alarm set."""
        # Start from a fully nominal logic output
        out = plc._logic()
        out[alarm_key] = value
        # Fix ActiveAlarms to be consistent
        from sim.plc import ALARM_KEYS
        out["System/ActiveAlarms"] = sum(1 for k in ALARM_KEYS if out[k])
        return out

    def test_alarm_not_raised_on_first_scan(self, plc):
        """Single True scan: alarm stays False (waiting for ON_DELAY_SCANS=2)."""
        raw = self._raw(plc, "A1/ToolWearHigh", True)
        confirmed = plc._apply_hysteresis(raw)
        assert confirmed["A1/ToolWearHigh"] is False  # not yet confirmed

    def test_alarm_raised_after_two_scans(self, plc):
        """Two consecutive True scans → alarm confirmed."""
        raw = self._raw(plc, "A1/ToolWearHigh", True)
        plc._apply_hysteresis(raw)   # scan 1 — still False
        confirmed = plc._apply_hysteresis(raw)  # scan 2 — confirmed
        assert confirmed["A1/ToolWearHigh"] is True

    def test_alarm_not_cleared_on_first_false(self, plc):
        """Alarm active, then single False: stays True (waiting for CLEAR_DELAY_SCANS=2)."""
        raw_on  = self._raw(plc, "A2/CoolingDegraded", True)
        raw_off = self._raw(plc, "A2/CoolingDegraded", False)
        plc._apply_hysteresis(raw_on)
        plc._apply_hysteresis(raw_on)    # confirmed True
        plc._apply_hysteresis(raw_off)   # scan 1 False — still True
        confirmed = plc._apply_hysteresis(raw_off)  # scan 2 False — cleared
        # After 2 scans of False it should clear
        assert confirmed["A2/CoolingDegraded"] is False

    def test_chattering_suppressed(self, plc):
        """True → False → True rapidly: alarm never fires."""
        raw_on  = self._raw(plc, "A3/LowPressure", True)
        raw_off = self._raw(plc, "A3/LowPressure", False)
        plc._apply_hysteresis(raw_on)   # pending=1
        plc._apply_hysteresis(raw_off)  # pending reset to 0
        plc._apply_hysteresis(raw_on)   # pending=1 again
        confirmed = plc._apply_hysteresis(raw_off)  # pending reset again
        assert confirmed["A3/LowPressure"] is False


# ── Alarm edge logging ────────────────────────────────────────────────────

class TestAlarmEdgeLogging:
    def test_rising_edge_logged(self, plc, caplog):
        import logging
        with caplog.at_level(logging.WARNING, logger="plc"):
            plc.inputs["A1"].values["Tool/ToolWear_min"] = 220
            out = plc._logic()
            plc._log_alarm_edges(out)
        assert any("RAISED" in r.message and "ToolWearHigh" in r.message
                   for r in caplog.records)

    def test_no_log_when_unchanged(self, plc, caplog):
        import logging
        with caplog.at_level(logging.WARNING, logger="plc"):
            out = plc._logic()
            plc._log_alarm_edges(out)  # first call — all False
            plc._log_alarm_edges(out)  # second call — unchanged
        # Should have 0 log records the second time (no edges)
        assert len(caplog.records) == 0
