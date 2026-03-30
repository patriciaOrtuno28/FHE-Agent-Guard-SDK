""" compile_random_forest.py ──────────────────────── 
Train and compile a Concrete ML RandomForestClassifier from a real labeled dataset. 
Usage: 
    python scripts/compile_random_forest.py --dataset /app/data/your_dataset.csv --dry-run 
    python scripts/compile_random_forest.py --dataset /app/data/your_dataset.csv --output ./artifacts 
"""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd
from concrete.ml.sklearn import RandomForestClassifier
from sklearn.metrics import accuracy_score, precision_recall_fscore_support
from sklearn.model_selection import train_test_split

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
    "tx_value_eth": (0, 10000),
    "tx_count_1h": (0, 1000),
    "tx_count_24h": (0, 10000),
    "unique_counterparts": (0, 500),
    "gas_price_gwei": (0, 10000),
    "contract_interaction": (0, 1),
    "time_since_last_tx": (0, 86400),
    "balance_change_ratio": (-1, 1),
}

RECOMMENDED_META_COLUMNS = [
    "subject",
    "source",
    "observed_at",
    "label_reason",
]


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
            return h.hexdigest()


def read_dataset(path: str) -> pd.DataFrame:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Dataset not found: {path}")
    suffix = p.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(p)
    if suffix == ".parquet":
        return pd.read_parquet(p)
    raise ValueError("Dataset must be .csv or .parquet")


def normalize_labels(series: pd.Series) -> np.ndarray:
    if pd.api.types.is_numeric_dtype(series):
        vals = series.astype(int).to_numpy()
        unique = set(np.unique(vals).tolist())
        if not unique.issubset({0, 1}):
            raise ValueError(f"Numeric labels must be 0/1. Got: {sorted(unique)}")
        return vals

    lowered = series.astype(str).str.strip().str.lower()
    mapping = {
        "0": 0,
        "1": 1,
        "normal": 0,
        "benign": 0,
        "safe": 0,
        "anomaly": 1,
        "anomalous": 1,
        "malicious": 1,
        "fraud": 1,
        "exploit": 1,
        "suspicious": 1,
    }
    mapped = lowered.map(mapping)
    if mapped.isna().any():
        bad = sorted(lowered[mapped.isna()].unique().tolist())
        raise ValueError(f"Unsupported label values: {bad}")
    return mapped.astype(int).to_numpy()


def clip_feature_ranges(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    for name in FEATURE_NAMES:
        lo, hi = FEATURE_RANGES[name]
        out[name] = pd.to_numeric(out[name], errors="coerce").clip(lo, hi)
        return out


def validate_dataset(df: pd.DataFrame, label_column: str) -> None:
    required = FEATURE_NAMES + [label_column]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Dataset missing required columns: {missing}")
    if len(df) < 100:
        raise ValueError("Dataset too small. Provide at least 100 labeled rows.")
    if df[label_column].isna().any():
        raise ValueError(f"Label column '{label_column}' contains nulls")


def load_real_training_data(path: str, label_column: str):
    df = read_dataset(path)
    validate_dataset(df, label_column)
    df = clip_feature_ranges(df)
    df = df.dropna(subset=FEATURE_NAMES + [label_column]).copy()
    X = df[FEATURE_NAMES].astype(np.float32).to_numpy()
    y = normalize_labels(df[label_column])
    positives = int(y.sum())
    negatives = int((y == 0).sum())
    if positives == 0 or negatives == 0:
        raise ValueError("Dataset must contain both normal and anomaly rows")
    meta = {
        "rows": int(len(df)),
        "normalRows": negatives,
        "anomalyRows": positives,
        "columns": list(df.columns),
        "availableMetaColumns": [
            c for c in RECOMMENDED_META_COLUMNS if c in df.columns
        ],
    }
    return X, y, meta


def compile_model(X_train, y_train, n_bits=6):
    print(
        f"Training RandomForestClassifier ({X_train.shape[0]} train rows, n_bits={n_bits})..."
    )
    model = RandomForestClassifier(
        n_estimators=10,
        max_depth=4,
        n_bits=n_bits,
        random_state=42,
    )
    X_f32 = X_train.astype(np.float32)
    model.fit(X_f32, y_train)
    print("Compiling to FHE circuit...")
    model.compile(X_f32)
    print("Compilation complete.")
    return model


def evaluate_model(model, X_test, y_test):
    preds = model.predict(X_test.astype(np.float32))
    accuracy = float(accuracy_score(y_test, preds))
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_test,
        preds,
        average="binary",
        zero_division=0,
    )
    return {
        "accuracy": round(accuracy, 6),
        "precision": round(float(precision), 6),
        "recall": round(float(recall), 6),
        "f1": round(float(f1), 6),
        "testRows": int(len(y_test)),
    }


def save_artifacts(model, output_dir, manifest, metrics):
    os.makedirs(output_dir, exist_ok=True)
    model_path = os.path.join(output_dir, "anomaly_model.json")
    with open(model_path, "w") as f:
        model.dump(f)
        manifest["modelPath"] = model_path
        manifest["metrics"] = metrics
        manifest_path = os.path.join(output_dir, "anomaly_model.manifest.json")
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)
            metrics_path = os.path.join(output_dir, "training_metrics.json")
            with open(metrics_path, "w") as f:
                json.dump(metrics, f, indent=2)
                return model_path, manifest_path, metrics_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset", required=True, help="Path to labeled CSV or Parquet dataset"
    )
    parser.add_argument("--label-column", default="label")
    parser.add_argument("--output", default="./artifacts")
    parser.add_argument("--n-bits", type=int, default=6)
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--model-version", default="2.0.0")
    parser.add_argument("--model-id", default="base-anomaly-rf-v2")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    print("=" * 50)
    print("FHE Agent Guard - Real-Data Model Compiler")
    print("=" * 50)
    print(f"Dataset: {args.dataset}")

    X, y, dataset_meta = load_real_training_data(args.dataset, args.label_column)
    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=args.test_size,
        random_state=42,
        stratify=y,
    )

    print(
        f"Loaded {len(X)} rows | "
        f"train={len(X_train)} | "
        f"test={len(X_test)} | "
        f"anomalies={int(y.sum())}"
    )

    if args.dry_run:
        print("[dry-run] Dataset loaded and validated successfully.")
        return

    model = compile_model(X_train, y_train, n_bits=args.n_bits)

    metrics = evaluate_model(model, X_test, y_test)

    manifest = {
        "modelId": args.model_id,
        "version": args.model_version,
        "modelType": "RandomForestClassifier",
        "compiledAt": int(time.time() * 1000),
        "nBits": model.n_bits,
        "nEstimators": model.n_estimators,
        "labels": {"0": "normal", "1": "anomaly"},
        "inputSchema": [
            {
                "name": name,
                "type": "float32",
                "min": FEATURE_RANGES[name][0],
                "max": FEATURE_RANGES[name][1],
            }
            for name in FEATURE_NAMES
        ],
        "trainingData": {
            "path": args.dataset,
            "sha256": file_sha256(args.dataset),
            "labelColumn": args.label_column,
            "rows": dataset_meta["rows"],
            "normalRows": dataset_meta["normalRows"],
            "anomalyRows": dataset_meta["anomalyRows"],
            "availableMetaColumns": dataset_meta["availableMetaColumns"],
            "provenanceNote": "Real labeled on-chain dataset supplied externally by the operator.",
        },
    }

    model_path, manifest_path, metrics_path = save_artifacts(
        model,
        args.output,
        manifest,
        metrics,
    )

    print()
    print("=" * 50)
    print("Artifacts saved")
    print(f"Model: {model_path}")
    print(f"Manifest: {manifest_path}")
    print(f"Metrics: {metrics_path}")
    print("=" * 50)


if __name__ == "__main__":
    main()
