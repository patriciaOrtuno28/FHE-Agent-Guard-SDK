"""
inference_server.py
────────────────────
FastAPI server that loads the compiled Concrete ML model from a mounted
artifacts volume and exposes a /predict endpoint for the TypeScript SDK.

Startup requirements:
  - /artifacts/anomaly_model.json      (compiled model weights — run pnpm models:compile)
  - /artifacts/anomaly_model.manifest.json  (schema metadata — committed to git)

FHE modes (SIMULATE_FHE env var):
  true  — FHE simulation: same quantized graph, no real encryption. Fast, good for dev.
  false — Real FHE execution: actual encrypted inference. Slow but cryptographically correct.
"""

import os
import sys
import json
import hashlib
import logging
import numpy as np
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Header, Request
from pydantic import BaseModel
from typing import List
from concrete.ml.common.serialization.loaders import load
from collections import defaultdict, deque
import time

# ── Structured JSON logging ───────────────────────────────────

class _JsonFormatter(logging.Formatter):
    """Emit one JSON object per log line for easy parsing by log aggregators."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts":    datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "msg":   record.getMessage(),
        }
        # Merge any extra fields attached via `extra=` kwarg
        for key, val in record.__dict__.items():
            if key not in logging.LogRecord.__dict__ and not key.startswith("_"):
                payload[key] = val
        return json.dumps(payload)


def _setup_logging() -> logging.Logger:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    return logging.getLogger("inference")


log = _setup_logging()


def _hash_subject(subject: str) -> str:
    """SHA-256 prefix of subject address — identifies it in logs without revealing plaintext."""
    return hashlib.sha256(subject.strip().lower().encode()).hexdigest()[:16]


# ── Config ────────────────────────────────────────────────────

MODEL_PATH    = os.getenv("MODEL_PATH",    "/artifacts/anomaly_model.json")
MANIFEST_PATH = os.getenv("MANIFEST_PATH", "/artifacts/anomaly_model.manifest.json")
SIMULATE_FHE  = os.getenv("SIMULATE_FHE",  "true").lower() == "true"

FEATURE_NAMES = [
    "tx_value_eth", "tx_count_1h", "tx_count_24h", "unique_counterparts",
    "gas_price_gwei", "contract_interaction", "time_since_last_tx", "balance_change_ratio",
]

INFERENCE_API_KEY = os.getenv("INFERENCE_API_KEY", "")
RATE_LIMIT_WINDOW_SECS = int(os.getenv("RATE_LIMIT_WINDOW_SECS", "60"))
RATE_LIMIT_MAX_REQUESTS = int(os.getenv("RATE_LIMIT_MAX_REQUESTS", "30"))

# ── Startup checks ────────────────────────────────────────────

_rate_buckets = defaultdict(deque)

def _require_bearer_token(authorization: str | None) -> str:
    if not INFERENCE_API_KEY:
        raise HTTPException(status_code=500, detail="Inference API key is not configured")

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    token = authorization.removeprefix("Bearer ").strip()
    if token != INFERENCE_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid bearer token")

    return token

def _enforce_rate_limit(bucket_key: str) -> None:
    now = time.time()
    bucket = _rate_buckets[bucket_key]

    while bucket and now - bucket[0] > RATE_LIMIT_WINDOW_SECS:
      bucket.popleft()

    if len(bucket) >= RATE_LIMIT_MAX_REQUESTS:
      raise HTTPException(status_code=429, detail="Rate limit exceeded")

    bucket.append(now)

# Fail fast with a clear, actionable message if artifacts are missing.

def _check_artifact(path: str, label: str) -> None:
    if not os.path.exists(path):
        log.error("Missing artifact", extra={"artifact": label, "path": path,
                  "fix": "run pnpm models:compile then restart inference server"})
        sys.exit(1)

_check_artifact(MANIFEST_PATH, "anomaly_model.manifest.json")
_check_artifact(MODEL_PATH,    "anomaly_model.json")

# ── Load manifest ─────────────────────────────────────────────

log.info("Loading manifest", extra={"path": MANIFEST_PATH})
with open(MANIFEST_PATH, "r") as f:
    manifest = json.load(f)

# ── Load model ────────────────────────────────────────────────

log.info("Loading model", extra={"path": MODEL_PATH})
with open(MODEL_PATH, "r") as f:
    model = load(f)

# ── Compile FHE circuit ───────────────────────────────────────
# Concrete ML requires recompilation after deserialisation.
# Use data matching the training distribution — random data causes
# assertion errors in the MLIR compiler.

log.info("Compiling FHE circuit", extra={"note": "takes ~30s"})

def _compile_data(n: int = 200, seed: int = 42) -> np.ndarray:
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

model.compile(_compile_data())

fhe_mode = "simulate" if SIMULATE_FHE else "execute"
log.info("Model ready", extra={"fhe_mode": fhe_mode, "model": manifest.get("modelId")})

# ── API ───────────────────────────────────────────────────────

app = FastAPI(title="FHE Agent Guard — Inference Server")


class PredictRequest(BaseModel):
    features: List[float]
    subject: str = ""


class PredictResponse(BaseModel):
    label: str       # "normal" or "anomaly"
    prediction: int  # 0 = normal, 1 = anomaly
    risk_probability: float
    trust_score: int
    subject: str


@app.get("/health")
def health():
    return {
        "status":   "ok",
        "model":    manifest.get("modelId"),
        "version":  manifest.get("version"),
        "fhe_mode": fhe_mode,
    }


@app.post("/predict", response_model=PredictResponse)
def predict(
    req: PredictRequest,
    request: Request,
    authorization: str | None = Header(default=None),
):
    token = _require_bearer_token(authorization)
    client_ip = request.client.host if request.client else "unknown"
    bucket_key = f"{token}:{client_ip}"
    _enforce_rate_limit(bucket_key)

    if len(req.features) != len(FEATURE_NAMES):
        raise HTTPException(
            status_code=422,
            detail=f"Expected {len(FEATURE_NAMES)} features, got {len(req.features)}",
        )

    subject_hash = _hash_subject(req.subject)
    t0 = time.perf_counter()

    X = np.array([req.features], dtype=np.float32)

    # Preferred: probability output
    proba = model.predict_proba(X, fhe=fhe_mode)
    risk_probability = float(proba[0][1])   # class 1 = anomaly/risky

    prediction = 1 if risk_probability >= 0.5 else 0
    trust_score = int(np.clip(round((1.0 - risk_probability) * 10), 0, 10))

    label = "trusted" if trust_score >= 7 else "blocked"

    latency_ms = round((time.perf_counter() - t0) * 1000, 2)

    log.info(
        "predict",
        extra={
            "subject_hash":    subject_hash,
            "label":           label,
            "trust_score":     trust_score,
            "risk_probability": round(risk_probability, 4),
            "fhe_mode":        fhe_mode,
            "latency_ms":      latency_ms,
            "client_ip":       client_ip,
        },
    )

    return PredictResponse(
        label=label,
        prediction=prediction,
        risk_probability=risk_probability,
        trust_score=trust_score,
        subject=req.subject,
    )


@app.get("/schema")
def schema():
    return {
        "features":    FEATURE_NAMES,
        "inputSchema": manifest.get("inputSchema", []),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
