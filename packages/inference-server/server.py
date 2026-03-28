"""
inference_server.py
────────────────────
Minimal FastAPI server that loads the compiled Concrete ML model
and exposes a /predict endpoint for the TypeScript SDK.

Runs inside Docker alongside the SDK.
"""

import os
import json
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
from concrete.ml.common.serialization.loaders import load

# ── Config ────────────────────────────────────────────────────

MODEL_PATH    = os.getenv("MODEL_PATH",    "/artifacts/anomaly_model.json")
MANIFEST_PATH = os.getenv("MANIFEST_PATH", "/artifacts/anomaly_model.manifest.json")
SIMULATE_FHE  = os.getenv("SIMULATE_FHE",  "true").lower() == "true"

FEATURE_NAMES = [
    "tx_value_eth", "tx_count_1h", "tx_count_24h", "unique_counterparts",
    "gas_price_gwei", "contract_interaction", "time_since_last_tx", "balance_change_ratio",
]

# ── Load model at startup ─────────────────────────────────────

print(f"Loading model from {MODEL_PATH}...")

with open(MODEL_PATH, "r") as f:
    model = load(f)

# Load manifest for schema info
with open(MANIFEST_PATH, "r") as f:
    manifest = json.load(f)

# Compile the FHE circuit using the same data distribution as training
# (random data causes assertion errors in the MLIR compiler)
print("Compiling FHE circuit...")

def generate_compile_data(n=200, seed=42):
    rng = np.random.default_rng(seed)
    normal = np.column_stack([
        rng.lognormal(0.5, 1.0, n).clip(0, 100),
        rng.poisson(5, n).clip(0, 50).astype(float),
        rng.poisson(30, n).clip(0, 200).astype(float),
        rng.poisson(8, n).clip(0, 50).astype(float),
        rng.normal(30, 15, n).clip(1, 500),
        rng.binomial(1, 0.6, n).astype(float),
        rng.exponential(3600, n).clip(0, 86400),
        rng.normal(0.0, 0.1, n).clip(-1, 1),
    ])
    anomaly = np.column_stack([
        rng.lognormal(5.0, 2.0, n).clip(0, 10000),
        rng.poisson(200, n).clip(0, 1000).astype(float),
        rng.poisson(2000, n).clip(0, 10000).astype(float),
        rng.poisson(100, n).clip(0, 500).astype(float),
        rng.normal(500, 200, n).clip(1, 10000),
        rng.binomial(1, 0.95, n).astype(float),
        rng.exponential(60, n).clip(0, 86400),
        rng.uniform(-1, 1, n),
    ])
    return np.vstack([normal, anomaly]).astype(np.float32)

X_compile = generate_compile_data()
model.compile(X_compile)

fhe_mode = "simulate" if SIMULATE_FHE else "execute"
print(f"Model ready. FHE mode: {fhe_mode}")

# ── API ───────────────────────────────────────────────────────

app = FastAPI(title="FHE Agent Guard — Inference Server")


class PredictRequest(BaseModel):
    features: List[float]
    subject: str = ""


class PredictResponse(BaseModel):
    label: str        # "normal" or "anomaly"
    prediction: int   # 0 = normal, 1 = anomaly
    subject: str


@app.get("/health")
def health():
    return {"status": "ok", "model": manifest.get("modelId"), "fhe_mode": fhe_mode}


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    if len(req.features) != len(FEATURE_NAMES):
        raise HTTPException(
            status_code=422,
            detail=f"Expected {len(FEATURE_NAMES)} features, got {len(req.features)}"
        )

    X = np.array([req.features], dtype=np.float32)

    # Run inference — "simulate" uses FHE simulation (fast), "execute" uses real FHE (slow)
    prediction = model.predict(X, fhe=fhe_mode)
    pred_int = int(prediction[0])
    label = manifest["labels"].get(str(pred_int), "unknown")

    return PredictResponse(
        label=label,
        prediction=pred_int,
        subject=req.subject,
    )


@app.get("/schema")
def schema():
    return {
        "features": FEATURE_NAMES,
        "inputSchema": manifest.get("inputSchema", []),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)