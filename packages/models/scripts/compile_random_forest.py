"""
compile_anomaly_model.py
────────────────────────
Trains a one-class anomaly detector using Concrete ML's RandomForestClassifier.
Since Concrete ML does not implement IsolationForest, we simulate anomaly detection
by training a binary classifier on normal vs. synthetic anomalous samples.

Usage:
    python scripts/compile_isolation_forest.py --dry-run
    python scripts/compile_isolation_forest.py --output ./artifacts
"""

import argparse
import json
import os
import time

import numpy as np
from concrete.ml.sklearn import RandomForestClassifier

FEATURE_NAMES = [
    "tx_value_eth",
    "tx_count_1h",
    "tx_count_24h",
    "unique_counterparts",
    "gas_price_gwei",
    "contract_interaction",
    "time_since_last_tx",
    "balance_change_ratio",
]

FEATURE_RANGES = {
    "tx_value_eth":         (0,    10000),
    "tx_count_1h":          (0,    1000),
    "tx_count_24h":         (0,    10000),
    "unique_counterparts":  (0,    500),
    "gas_price_gwei":       (0,    10000),
    "contract_interaction": (0,    1),
    "time_since_last_tx":   (0,    86400),
    "balance_change_ratio": (-1,   1),
}


def generate_training_data(n_normal=4000, n_anomaly=1000, seed=42):
    """Generate normal (label=0) and anomalous (label=1) transaction features."""
    rng = np.random.default_rng(seed)

    # Normal transactions
    normal = {
        "tx_value_eth":         rng.lognormal(0.5, 1.0, n_normal).clip(0, 100),
        "tx_count_1h":          rng.poisson(5, n_normal).clip(0, 50),
        "tx_count_24h":         rng.poisson(30, n_normal).clip(0, 200),
        "unique_counterparts":  rng.poisson(8, n_normal).clip(0, 50),
        "gas_price_gwei":       rng.normal(30, 15, n_normal).clip(1, 500),
        "contract_interaction": rng.binomial(1, 0.6, n_normal).astype(float),
        "time_since_last_tx":   rng.exponential(3600, n_normal).clip(0, 86400),
        "balance_change_ratio": rng.normal(0.0, 0.1, n_normal).clip(-1, 1),
    }

    # Anomalous transactions — exaggerated values
    anomaly = {
        "tx_value_eth":         rng.lognormal(5.0, 2.0, n_anomaly).clip(0, 10000),
        "tx_count_1h":          rng.poisson(200, n_anomaly).clip(0, 1000),
        "tx_count_24h":         rng.poisson(2000, n_anomaly).clip(0, 10000),
        "unique_counterparts":  rng.poisson(100, n_anomaly).clip(0, 500),
        "gas_price_gwei":       rng.normal(500, 200, n_anomaly).clip(1, 10000),
        "contract_interaction": rng.binomial(1, 0.95, n_anomaly).astype(float),
        "time_since_last_tx":   rng.exponential(60, n_anomaly).clip(0, 86400),
        "balance_change_ratio": rng.uniform(-1, 1, n_anomaly),
    }

    X_normal  = np.column_stack([normal[f]  for f in FEATURE_NAMES])
    X_anomaly = np.column_stack([anomaly[f] for f in FEATURE_NAMES])

    X = np.vstack([X_normal, X_anomaly])
    y = np.array([0] * n_normal + [1] * n_anomaly)

    return X, y


def quantize(X):
    """Scale features to [0, 255] integer range for FHE."""
    X_q = np.zeros_like(X, dtype=np.int64)
    for i, name in enumerate(FEATURE_NAMES):
        lo, hi = FEATURE_RANGES[name]
        rng = hi - lo or 1
        X_q[:, i] = np.clip(((X[:, i] - lo) / rng) * 255, 0, 255).astype(np.int64)
    return X_q


def compile_model(X_float, y_train, n_bits=6):
    print(f"Training RandomForestClassifier ({X_float.shape[0]} samples, n_bits={n_bits})...")

    model = RandomForestClassifier(
        n_estimators=10,
        max_depth=4,
        n_bits=n_bits,
        random_state=42,
    )

    # Concrete ML expects float32 inputs — it handles quantization internally
    X_f32 = X_float.astype(np.float32)
    model.fit(X_f32, y_train)
    print("Compiling to FHE circuit...")
    model.compile(X_f32)
    print("Compilation complete.")
    return model


def save_artefact(model, output_dir):
    os.makedirs(output_dir, exist_ok=True)

    # Concrete ML serializes the full model (weights + quantization params) as JSON.
    # The FHE circuit is NOT stored — it must be recompiled on load (per official docs).
    # See: https://docs.zama.ai/concrete-ml/guides/serialization
    model_path = os.path.join(output_dir, "anomaly_model.json")
    with open(model_path, "w") as f:
        model.dump(f)

    manifest = {
        "modelId":        "base-anomaly-rf-v1",
        "version":        "1.0.0",
        "modelType":      "RandomForestClassifier",
        "modelPath":      model_path,
        "compiledAt":     int(time.time() * 1000),
        "nBits":          model.n_bits,
        "nEstimators":    model.n_estimators,
        "labels":         {"0": "normal", "1": "anomaly"},
        "note":           "FHE circuit must be recompiled after loading. Call model.compile(X_train) before inference.",
        "inputSchema": [
            {"name": name, "type": "float32", "min": FEATURE_RANGES[name][0], "max": FEATURE_RANGES[name][1]}
            for name in FEATURE_NAMES
        ],
    }

    manifest_path = os.path.join(output_dir, "anomaly_model.manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output",  default="./artifacts")
    parser.add_argument("--n-bits",  type=int, default=6)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    print("═" * 50)
    print("FHE Agent Guard — Model Compiler")
    print("Model: RandomForestClassifier (anomaly detection)")
    print("═" * 50)

    X_raw, y = generate_training_data()
    print(f"Training data: {X_raw.shape}, anomalies: {y.sum()}/{len(y)}")

    if args.dry_run:
        # Quick sanity check without FHE compilation
        from sklearn.ensemble import RandomForestClassifier as SklearnRF
        model = SklearnRF(n_estimators=10, max_depth=4, random_state=42)
        model.fit(X_raw, y)
        acc = model.score(X_raw, y)
        print(f"\n[dry-run] sklearn accuracy: {acc:.3f}")
        print("[dry-run] Concrete ML import: OK")
        print("[dry-run] Environment ready for full compilation.")
        return

    model = compile_model(X_raw, y, n_bits=args.n_bits)
    manifest = save_artefact(model, args.output)

    print()
    print("═" * 50)
    print("✅ Artefact saved:")
    print(f"   Model:    {manifest['modelPath']}")
    print(f"   Manifest: {args.output}/anomaly_model.manifest.json")
    print("═" * 50)


if __name__ == "__main__":
    main()