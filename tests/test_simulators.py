import pytest
from sim.assets.a1_milling import A1MillingMachine

def test_a1_milling_machine_initialization():
    asset = A1MillingMachine("A1")
    assert asset.asset_id == "A1"
    assert asset.health_status == "Good"
    
def test_a1_milling_machine_step():
    asset = A1MillingMachine("A1")
    # Store initial wear
    initial_wear = asset.tool_wear
    
    # Run simulation step
    payloads = asset.step(dt=1.0)
    
    # Check that payloads were generated for the topics
    assert len(payloads) > 0
    topics = [topic for topic, value in payloads]
    assert "jesa/site1/workshop/milling/A1/process/air_temperature_k" in topics
    
    # Wear should increase after running a step
    assert asset.tool_wear >= initial_wear
