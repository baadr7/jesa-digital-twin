import pytest
import numpy as np
from pathlib import Path
from uns.ml_inference_service import A1Predictor

A1_MODEL_PATH = Path("notebooks/models/a1_classifier.joblib")

@pytest.mark.skipif(not A1_MODEL_PATH.exists(), reason="A1 model file not found")
def test_a1_predictor_initialization():
    predictor = A1Predictor()
    assert predictor.model is not None, "A1 model failed to load. Ensure 'notebooks/models/a1_classifier.joblib' exists."
    assert "AirTemp_K" in predictor.state

@pytest.mark.skipif(not A1_MODEL_PATH.exists(), reason="A1 model file not found")
def test_a1_predictor_predict():
    predictor = A1Predictor()
    # Force a normal state
    predictor.state["AirTemp_K"] = 298.0
    predictor.state["ProcTemp_K"] = 308.0
    predictor.state["Speed_rpm"] = 1500.0
    predictor.state["Torque_Nm"] = 40.0
    predictor.state["ToolWear_min"] = 10.0
    
    result = predictor.predict()
    assert result is not None
    assert "machine_failure" in result
    assert "failure_probability" in result
    assert 0.0 <= result["failure_probability"] <= 1.0
