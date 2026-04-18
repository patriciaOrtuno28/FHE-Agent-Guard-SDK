"""
augment_with_personal_wallets.py
─────────────────────────────────
Appends synthetic personal-wallet rows to test_data.csv.

The original dataset was scraped from mainnet DeFi protocol addresses that
happened to have zero recent transactions at collection time — so 109/110
"normal" rows have tx_count_24h=0. This teaches the model that zero activity
= trusted, and any activity = suspicious. Regular users score 2/10 as a result.

This script adds:
  • 160 synthetic NORMAL rows spanning the full activity range of real users
    (dormant → occasional → active → heavy DeFi)
  • 60 synthetic ANOMALY rows with clear attack signatures
    (bot spam, large drain, flash-loan pattern)

Usage:
    python packages/models/scripts/augment_with_personal_wallets.py
    python packages/models/scripts/augment_with_personal_wallets.py \
        --csv packages/models/data/test_data.csv --seed 123 --dry-run
"""

from __future__ import annotations

import argparse
import csv
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

OUTPUT_COLUMNS = [
    "tx_value_eth",
    "tx_count_1h",
    "tx_count_24h",
    "unique_counterparts",
    "gas_price_gwei",
    "contract_interaction",
    "time_since_last_tx",
    "balance_change_ratio",
    "label",
    "subject",
    "source",
    "observed_at",
    "label_reason",
]

NOW = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
SOURCE = "synthetic:personal-wallet-augmentation"


def _row(rng: random.Random, label: str, reason: str, **kw) -> dict:
    return {
        "tx_value_eth":         round(kw["tx_value_eth"], 6),
        "tx_count_1h":          kw["tx_count_1h"],
        "tx_count_24h":         kw["tx_count_24h"],
        "unique_counterparts":  kw["unique_counterparts"],
        "gas_price_gwei":       round(kw["gas_price_gwei"], 2),
        "contract_interaction": kw["contract_interaction"],
        "time_since_last_tx":   min(int(kw["time_since_last_tx"]), 86400),
        "balance_change_ratio": round(max(-1.0, min(1.0, kw["balance_change_ratio"])), 6),
        "label":                label,
        "subject":              f"0x{''.join(f'{rng.randint(0,255):02x}' for _ in range(20))}",
        "source":               SOURCE,
        "observed_at":          NOW,
        "label_reason":         reason,
    }


def generate_normal_rows(rng: random.Random, n: int) -> list[dict]:
    rows: list[dict] = []

    # ── Tier 1: Dormant personal wallet (last tx > 24h ago, no recent activity)
    # Represents users who transact infrequently — weekly or less.
    # n1 = n // 4
    n1 = n // 4
    for _ in range(n1):
        rows.append(_row(
            rng, "normal", "synthetic: dormant personal wallet",
            tx_value_eth=rng.uniform(0.0, 2.0),
            tx_count_1h=0,
            tx_count_24h=0,
            unique_counterparts=rng.randint(0, 2),
            gas_price_gwei=rng.uniform(5, 40),
            contract_interaction=0,
            time_since_last_tx=rng.randint(86400, 86400),
            balance_change_ratio=rng.uniform(-0.05, 0.05),
        ))

    # ── Tier 2: Low-activity personal wallet (1–3 tx in last 24h)
    # Represents your typical user who sends ETH or buys NFTs occasionally.
    n2 = n // 4
    for _ in range(n2):
        tx24 = rng.randint(1, 3)
        tx1  = rng.randint(0, min(tx24, 2))
        rows.append(_row(
            rng, "normal", "synthetic: low-activity personal wallet",
            tx_value_eth=rng.uniform(0.001, 1.5),
            tx_count_1h=tx1,
            tx_count_24h=tx24,
            unique_counterparts=rng.randint(1, 3),
            gas_price_gwei=rng.uniform(8, 50),
            contract_interaction=rng.randint(0, 1),
            time_since_last_tx=rng.randint(300, 43200),
            balance_change_ratio=rng.uniform(-0.1, 0.1),
        ))

    # ── Tier 3: Moderate personal wallet (4–15 tx/day)
    # Regular DeFi user, swaps occasionally, holds and trades.
    n3 = n // 4
    for _ in range(n3):
        tx24 = rng.randint(4, 15)
        tx1  = rng.randint(0, min(tx24, 4))
        rows.append(_row(
            rng, "normal", "synthetic: moderate personal wallet",
            tx_value_eth=rng.uniform(0.01, 5.0),
            tx_count_1h=tx1,
            tx_count_24h=tx24,
            unique_counterparts=rng.randint(2, 8),
            gas_price_gwei=rng.uniform(10, 60),
            contract_interaction=rng.randint(0, 1),
            time_since_last_tx=rng.randint(60, 7200),
            balance_change_ratio=rng.uniform(-0.15, 0.15),
        ))

    # ── Tier 4: Active DeFi personal wallet (15–60 tx/day)
    # Power user, yield farming, multiple protocols daily.
    n4 = n - n1 - n2 - n3
    for _ in range(n4):
        tx24 = rng.randint(15, 60)
        tx1  = rng.randint(0, min(tx24 // 6, 10))
        rows.append(_row(
            rng, "normal", "synthetic: active DeFi personal wallet",
            tx_value_eth=rng.uniform(0.1, 20.0),
            tx_count_1h=tx1,
            tx_count_24h=tx24,
            unique_counterparts=rng.randint(3, 15),
            gas_price_gwei=rng.uniform(15, 80),
            contract_interaction=1,
            time_since_last_tx=rng.randint(30, 3600),
            balance_change_ratio=rng.uniform(-0.2, 0.2),
        ))

    return rows


def generate_anomaly_rows(rng: random.Random, n: int) -> list[dict]:
    rows: list[dict] = []

    # ── Bot / spam wallet
    n1 = n // 3
    for _ in range(n1):
        tx24 = rng.randint(200, 3000)
        rows.append(_row(
            rng, "anomaly", "synthetic: bot / spam wallet",
            tx_value_eth=rng.uniform(0.0, 0.01),
            tx_count_1h=rng.randint(20, min(tx24, 500)),
            tx_count_24h=tx24,
            unique_counterparts=rng.randint(50, 400),
            gas_price_gwei=rng.uniform(100, 2000),
            contract_interaction=rng.randint(0, 1),
            time_since_last_tx=rng.randint(1, 120),
            balance_change_ratio=rng.uniform(-0.05, 0.05),
        ))

    # ── Large-value drain / exit scam
    n2 = n // 3
    for _ in range(n2):
        rows.append(_row(
            rng, "anomaly", "synthetic: large-value drain / exit scam",
            tx_value_eth=rng.uniform(500, 5000),
            tx_count_1h=rng.randint(1, 5),
            tx_count_24h=rng.randint(2, 10),
            unique_counterparts=rng.randint(1, 4),
            gas_price_gwei=rng.uniform(500, 8000),
            contract_interaction=0,
            time_since_last_tx=rng.randint(30, 600),
            balance_change_ratio=rng.uniform(-1.0, -0.7),
        ))

    # ── Flash loan / contract exploit
    n3 = n - n1 - n2
    for _ in range(n3):
        tx24 = rng.randint(10, 80)
        rows.append(_row(
            rng, "anomaly", "synthetic: flash-loan / contract exploit",
            tx_value_eth=rng.uniform(100, 3000),
            tx_count_1h=rng.randint(5, min(tx24, 40)),
            tx_count_24h=tx24,
            unique_counterparts=rng.randint(10, 60),
            gas_price_gwei=rng.uniform(200, 6000),
            contract_interaction=1,
            time_since_last_tx=rng.randint(5, 300),
            balance_change_ratio=rng.uniform(-0.95, -0.5),
        ))

    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Augment test_data.csv with personal-wallet profiles")
    parser.add_argument("--csv",       default="packages/models/data/test_data.csv")
    parser.add_argument("--n-normal",  type=int, default=160)
    parser.add_argument("--n-anomaly", type=int, default=60)
    parser.add_argument("--seed",      type=int, default=7)
    parser.add_argument("--dry-run",   action="store_true")
    args = parser.parse_args(argv)

    csv_path = Path(args.csv)
    if not csv_path.exists():
        print(f"ERROR: {csv_path} not found.", file=sys.stderr)
        return 1

    rng = random.Random(args.seed)
    normal_rows  = generate_normal_rows(rng, args.n_normal)
    anomaly_rows = generate_anomaly_rows(rng, args.n_anomaly)
    new_rows = normal_rows + anomaly_rows
    rng.shuffle(new_rows)

    if args.dry_run:
        from collections import Counter
        labels = Counter(r["label"] for r in new_rows)
        print(f"[dry-run] Would append {len(new_rows)} rows: {dict(labels)}")
        tx24_normal = [r["tx_count_24h"] for r in normal_rows]
        print(f"[dry-run] Normal tx_count_24h: min={min(tx24_normal)} max={max(tx24_normal)} "
              f"mean={sum(tx24_normal)/len(tx24_normal):.1f}")
        return 0

    with csv_path.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=OUTPUT_COLUMNS)
        for row in new_rows:
            writer.writerow(row)

    existing = sum(1 for _ in csv_path.open(encoding="utf-8")) - 1  # subtract header
    print(f"Done. Appended {len(new_rows)} rows "
          f"({len(normal_rows)} normal, {len(anomaly_rows)} anomaly). "
          f"CSV now has {existing} data rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
