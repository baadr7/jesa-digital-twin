import pytest
from sim.assets.a1_milling import A1MillingSimulator

def test_a1_milling_machine_initialization():
    asset = A1MillingSimulator()
    assert asset.cfg.asset_id == "A1"
    assert asset.port == 4841
    
def test_a1_milling_machine_tags():
    asset = A1MillingSimulator()
    # Check that all expected tags exist
    tag_keys = [tag.key for tag in asset.tags]
    assert "Process/AirTemperature_K" in tag_keys
    assert "Tool/ToolWear_min" in tag_keys
    assert "Status/MachineFailure" in tag_keys
