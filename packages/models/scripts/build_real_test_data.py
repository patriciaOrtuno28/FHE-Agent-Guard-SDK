#!/usr/bin/env python3
"""
Build a real, labeled Ethereum dataset for `packages/models/data/test_data.csv`.

What this script does
---------------------
1. Collects labeled Ethereum addresses from free/public sources referenced by TODO.md:
   - Etherscan labels (via a public GitHub dump of Etherscan labels when direct pages are anti-bot protected)
   - Forta labelled datasets
   - EtherScamDB
   - Public sanctions / exploit/community feeds (OFAC list + PlusToken historic exploit addresses)
2. Fetches real on-chain activity for each address from Blockscout's free Ethereum API.
3. Derives the 8 model features expected by `compile_random_forest.py`.
4. Writes a CSV with metadata columns (`subject`, `source`, `observed_at`, `label_reason`).

Examples
--------
    python packages/models/scripts/build_real_test_data.py \
      --output packages/models/data/test_data.csv

    python packages/models/scripts/build_real_test_data.py \
      --min-rows 160 \
      --max-benign 220 \
      --max-anomaly 220 \
      --output packages/models/data/test_data.csv

    # Offline parser/feature smoke-test (no network needed)
    python packages/models/scripts/build_real_test_data.py --self-test
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import random
import re
import statistics
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urlencode

try:
    import requests
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "Missing dependency: requests. Install with `pip install requests` or add it to requirements.txt."
    ) from exc

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover
    yaml = None


ADDRESS_RE = re.compile(r"0x[a-fA-F0-9]{40}")
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

FEATURE_COLUMNS = [
    "tx_value_eth",
    "tx_count_1h",
    "tx_count_24h",
    "unique_counterparts",
    "gas_price_gwei",
    "contract_interaction",
    "time_since_last_tx",
    "balance_change_ratio",
]

OUTPUT_COLUMNS = [
    *FEATURE_COLUMNS,
    "label",
    "subject",
    "source",
    "observed_at",
    "label_reason",
]

ETHERSCAN_LABEL_LISTING = (
    "https://github.com/brianleect/etherscan-labels/tree/main/data/etherscan/accounts"
)
RAW_GITHUB = "https://raw.githubusercontent.com"
BLOCKSCOUT_API = "https://eth.blockscout.com/api/v2"

SUSPICIOUS_SLUG_KEYWORDS = {
    "hack",
    "exploit",
    "attack",
    "vulnerability",
    "phish",
    "scam",
    "heist",
    "drainer",
    "sanction",
    "ofac",
    "compromised",
    "malicious",
    "plus",
    "tornado-cash",
    "stolen",
}

SAFE_BENIGN_SLUGS = {
    "1inch",
    "aave",
    "across-protocol",
    "alchemix-finance",
    "ankr",
    "arbitrum",
    "art-blocks",
    "audius",
    "augur",
    "aura-finance",
    "axie-infinity",
    "balancer",
    "bancor",
    "binance",
    "coinbase",
    "compound",
    "curve",
    "ens",
    "kraken",
    "lido",
    "maker",
    "opensea",
    "optimism",
    "rocket-pool",
    "safe",
    "sushiswap",
    "uniswap",
    "yearn-finance",
    "chainlink",
    "polygon",
    "blur",
}


@dataclass(frozen=True)
class CandidateAddress:
    address: str
    label: int
    source: str
    label_reason: str


@dataclass
class FeatureRow:
    tx_value_eth: float
    tx_count_1h: int
    tx_count_24h: int
    unique_counterparts: int
    gas_price_gwei: float
    contract_interaction: int
    time_since_last_tx: int
    balance_change_ratio: float
    label: str
    subject: str
    source: str
    observed_at: str
    label_reason: str

    def as_csv_row(self) -> Dict[str, Any]:
        return {
            "tx_value_eth": round(float(self.tx_value_eth), 8),
            "tx_count_1h": int(self.tx_count_1h),
            "tx_count_24h": int(self.tx_count_24h),
            "unique_counterparts": int(self.unique_counterparts),
            "gas_price_gwei": round(float(self.gas_price_gwei), 8),
            "contract_interaction": int(self.contract_interaction),
            "time_since_last_tx": int(self.time_since_last_tx),
            "balance_change_ratio": round(float(self.balance_change_ratio), 8),
            "label": self.label,
            "subject": self.subject,
            "source": self.source,
            "observed_at": self.observed_at,
            "label_reason": self.label_reason,
        }


class HTTPCache:
    def __init__(self, cache_dir: Path, refresh: bool = False):
        self.cache_dir = cache_dir
        self.refresh = refresh
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def key_path(self, url: str) -> Path:
        digest = hashlib.sha1(url.encode("utf-8")).hexdigest()
        return self.cache_dir / f"{digest}.cache"

    def get(self, url: str) -> Optional[bytes]:
        path = self.key_path(url)
        if self.refresh or not path.exists():
            return None
        return path.read_bytes()

    def set(self, url: str, content: bytes) -> None:
        self.key_path(url).write_bytes(content)


class Fetcher:
    def __init__(
        self,
        cache_dir: Path,
        refresh: bool = False,
        timeout: int = 30,
        sleep_s: float = 0.15,
    ):
        self.cache = HTTPCache(cache_dir, refresh=refresh)
        self.timeout = timeout
        self.sleep_s = sleep_s
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/123.0 Safari/537.36"
                ),
                "Accept": "*/*",
            }
        )

    def get_bytes(self, url: str) -> bytes:
        cached = self.cache.get(url)
        if cached is not None:
            return cached

        last_exc: Optional[BaseException] = None
        for attempt in range(4):
            try:
                res = self.session.get(url, timeout=self.timeout)
                if res.status_code == 404:
                    raise FileNotFoundError(url)
                res.raise_for_status()
                content = res.content
                self.cache.set(url, content)
                if self.sleep_s > 0:
                    time.sleep(self.sleep_s)
                return content
            except Exception as exc:  # pragma: no cover - network/runtime dependent
                last_exc = exc
                backoff = (attempt + 1) * 1.5
                time.sleep(backoff)
        raise RuntimeError(f"Failed to fetch {url}: {last_exc}")

    def get_text(self, url: str) -> str:
        return self.get_bytes(url).decode("utf-8", errors="replace")

    def get_json(self, url: str) -> Any:
        return json.loads(self.get_text(url))


class SourceCollector:
    def __init__(self, fetcher: Fetcher):
        self.fetcher = fetcher

    def collect(self) -> List[CandidateAddress]:
        out: List[CandidateAddress] = []
        out.extend(self._collect_from_forta())
        out.extend(self._collect_from_etherscamdb())
        out.extend(self._collect_from_ofac())
        out.extend(self._collect_from_plustoken())
        out.extend(self._collect_from_etherscan_dump())
        return dedupe_candidates(out)

    def _collect_from_forta(self) -> List[CandidateAddress]:
        urls = {
            "forta:phishing_scams": (
                1,
                "phishing / forta labels",
                f"{RAW_GITHUB}/forta-network/labelled-datasets/main/labels/1/phishing_scams.csv",
                ("address",),
            ),
            "forta:malicious_smart_contracts": (
                1,
                "malicious smart contract / forta labels",
                f"{RAW_GITHUB}/forta-network/labelled-datasets/main/labels/1/malicious_smart_contracts.csv",
                ("contract_address",),
            ),
            "forta:etherscan_malicious_labels": (
                1,
                "exploit/heist/phish-hack / forta labels",
                f"{RAW_GITHUB}/forta-network/labelled-datasets/main/labels/1/etherscan_malicious_labels.csv",
                ("address",),
            ),
        }
        rows: List[CandidateAddress] = []
        for source_name, (label, reason, url, preferred_cols) in urls.items():
            try:
                text = self.fetcher.get_text(url)
            except Exception:
                continue
            rows.extend(
                parse_csv_addresses(
                    text,
                    label=label,
                    source=source_name,
                    label_reason=reason,
                    preferred_columns=preferred_cols,
                )
            )
        return rows

    def _collect_from_etherscamdb(self) -> List[CandidateAddress]:
        url = f"{RAW_GITHUB}/MrLuit/EtherScamDB/master/_data/scams.yaml"
        try:
            text = self.fetcher.get_text(url)
        except Exception:
            return []
        records = parse_etherscamdb_yaml(text)
        return [
            CandidateAddress(
                address=a,
                label=1,
                source="etherscamdb",
                label_reason=(f"{category} / {subcategory}".strip(" /") or "etherscamdb scam"),
            )
            for a, category, subcategory in records
        ]

    def _collect_from_ofac(self) -> List[CandidateAddress]:
        urls = [
            f"{RAW_GITHUB}/ultrasoundmoney/ofac-ethereum-addresses/main/data.csv",
            f"{RAW_GITHUB}/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/ETH.json",
        ]
        out: List[CandidateAddress] = []
        for url in urls:
            try:
                text = self.fetcher.get_text(url)
            except Exception:
                continue
            if url.endswith(".csv"):
                out.extend(
                    parse_csv_addresses(
                        text,
                        label=1,
                        source="ofac",
                        label_reason="sanctioned / public OFAC list",
                        preferred_columns=("address", "Address"),
                    )
                )
            else:
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    continue
                for addr in iter_addresses_from_object(payload):
                    out.append(
                        CandidateAddress(
                            address=addr,
                            label=1,
                            source="ofac",
                            label_reason="sanctioned / public OFAC list",
                        )
                    )
        return out

    def _collect_from_plustoken(self) -> List[CandidateAddress]:
        url = f"{RAW_GITHUB}/elementus-io/plustoken/master/plustoken-ethereum-addresses.csv"
        try:
            text = self.fetcher.get_text(url)
        except Exception:
            return []
        return parse_csv_addresses(
            text,
            label=1,
            source="historical-exploit:plustoken",
            label_reason="historical exploit / plustoken",
            preferred_columns=("address",),
        )

    def _collect_from_etherscan_dump(self) -> List[CandidateAddress]:
        try:
            html = self.fetcher.get_text(ETHERSCAN_LABEL_LISTING)
        except Exception:
            return []

        csv_names = sorted(
            set(
                re.findall(
                    r'/brianleect/etherscan-labels/blob/main/data/etherscan/accounts/([^"?#]+\.csv)',
                    html,
                )
            )
        )
        if not csv_names:
            return []

        suspicious_csvs: List[str] = []
        benign_csvs: List[str] = []
        for name in csv_names:
            slug = name[:-4]
            slug_l = slug.lower()
            if any(keyword in slug_l for keyword in SUSPICIOUS_SLUG_KEYWORDS):
                suspicious_csvs.append(name)
            if slug in SAFE_BENIGN_SLUGS:
                benign_csvs.append(name)

        # Fallbacks when GitHub listing shape changes or the curated slugs are sparse.
        if not benign_csvs:
            benign_csvs = [
                "aave.csv",
                "1inch.csv",
                "balancer.csv",
                "bancor.csv",
                "ankr.csv",
                "aura-finance.csv",
                "audius.csv",
                "augur.csv",
            ]
        if not suspicious_csvs:
            suspicious_csvs = [
                "bancor-contract-vulnerability.csv",
            ]

        out: List[CandidateAddress] = []
        out.extend(self._collect_csv_group_from_dump(benign_csvs[:18], label=0))
        out.extend(self._collect_csv_group_from_dump(suspicious_csvs[:12], label=1))
        return out

    def _collect_csv_group_from_dump(
        self, csv_names: Sequence[str], label: int
    ) -> List[CandidateAddress]:
        out: List[CandidateAddress] = []
        for name in csv_names:
            slug = name[:-4]
            url = (
                f"{RAW_GITHUB}/brianleect/etherscan-labels/main/"
                f"data/etherscan/accounts/{name}"
            )
            try:
                text = self.fetcher.get_text(url)
            except Exception:
                continue
            out.extend(
                parse_csv_addresses(
                    text,
                    label=label,
                    source=f"etherscan-label-dump:{slug}",
                    label_reason=f"etherscan label dump / {slug}",
                    preferred_columns=("address", "Address", "account", "wallet"),
                )
            )
        return out


class BlockscoutFeatureBuilder:
    def __init__(
        self, fetcher: Fetcher, api_base: str = BLOCKSCOUT_API, max_pages: int = 10
    ):
        self.fetcher = fetcher
        self.api_base = api_base.rstrip("/")
        self.max_pages = max_pages

    def build_row(self, candidate: CandidateAddress) -> Optional[FeatureRow]:
        address = checksumish(candidate.address)
        info = self._get_address_info(address)
        txs = self._get_recent_transactions(address)
        if not txs:
            # No indexed txs: still build a real, mostly-zero row from current chain state.
            txs = []

        now = datetime.now(timezone.utc)
        cutoff_1h = now.timestamp() - 3600
        cutoff_24h = now.timestamp() - 86400

        parsed_txs = [parse_blockscout_tx(tx) for tx in txs]
        parsed_txs = [tx for tx in parsed_txs if tx is not None]
        parsed_txs.sort(key=lambda x: x["timestamp"], reverse=True)

        txs_1h = [tx for tx in parsed_txs if tx["timestamp"] >= cutoff_1h]
        txs_24h = [tx for tx in parsed_txs if tx["timestamp"] >= cutoff_24h]

        subject_l = address.lower()
        sent_24h = [tx for tx in txs_24h if tx.get("from") == subject_l]
        latest_sent = (
            sent_24h[0]
            if sent_24h
            else next(
                (tx for tx in parsed_txs if tx.get("from") == subject_l),
                None,
            )
        )
        tx_value_eth = wei_to_eth(
            latest_sent.get("value_wei", 0) if latest_sent else 0
        )

        counterparts = set()
        for tx in txs_24h:
            counterpart = tx.get("to") if tx.get("from") == subject_l else tx.get("from")
            if counterpart and counterpart != subject_l:
                counterparts.add(counterpart)

        gas_prices = [
            tx["gas_price_gwei"]
            for tx in txs_24h
            if tx.get("gas_price_gwei") is not None
        ]
        gas_price_gwei = float(statistics.median(gas_prices)) if gas_prices else 0.0

        contract_interaction = (
            1
            if any(tx.get("contract_interaction") for tx in txs_24h)
            else int(bool(info.get("is_contract")))
        )

        if parsed_txs:
            last_ts = int(parsed_txs[0]["timestamp"])
            time_since_last_tx = max(0, int(now.timestamp()) - last_ts)
        else:
            time_since_last_tx = 86400

        current_balance = safe_int(info.get("coin_balance", 0))
        previous_balance = self._get_previous_balance(address)
        if previous_balance > 0:
            balance_change_ratio = (current_balance - previous_balance) / previous_balance
        else:
            balance_change_ratio = 0.0
        balance_change_ratio = clamp(balance_change_ratio, -1.0, 1.0)

        return FeatureRow(
            tx_value_eth=tx_value_eth,
            tx_count_1h=len(txs_1h),
            tx_count_24h=len(txs_24h),
            unique_counterparts=len(counterparts),
            gas_price_gwei=gas_price_gwei,
            contract_interaction=contract_interaction,
            time_since_last_tx=min(time_since_last_tx, 86400),
            balance_change_ratio=balance_change_ratio,
            label="anomaly" if candidate.label == 1 else "normal",
            subject=address,
            source=candidate.source,
            observed_at=now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            label_reason=candidate.label_reason,
        )

    def _get_address_info(self, address: str) -> Dict[str, Any]:
        return self.fetcher.get_json(f"{self.api_base}/addresses/{address}")

    def _get_recent_transactions(self, address: str) -> List[Dict[str, Any]]:
        all_items: List[Dict[str, Any]] = []
        params: Dict[str, Any] = {}
        cutoff_24h = datetime.now(timezone.utc).timestamp() - 86400

        for _ in range(self.max_pages):
            query = f"?{urlencode(params)}" if params else ""
            payload = self.fetcher.get_json(
                f"{self.api_base}/addresses/{address}/transactions{query}"
            )
            items = payload.get("items", []) if isinstance(payload, dict) else []
            if not items:
                break
            all_items.extend(items)

            timestamps = []
            for item in items:
                parsed = parse_blockscout_ts(item.get("timestamp"))
                if parsed is not None:
                    timestamps.append(parsed)
            if timestamps and min(timestamps) < cutoff_24h:
                break

            next_page_params = (
                payload.get("next_page_params") if isinstance(payload, dict) else None
            )
            if not next_page_params:
                break
            params = next_page_params
        return all_items

    def _get_previous_balance(self, address: str) -> int:
        try:
            payload = self.fetcher.get_json(
                f"{self.api_base}/addresses/{address}/coin-balance-history-by-day"
            )
        except Exception:
            return 0

        items = (
            payload
            if isinstance(payload, list)
            else payload.get("items", [])
            if isinstance(payload, dict)
            else []
        )
        cleaned: List[Tuple[str, int]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            date_s = str(item.get("date") or item.get("day") or "")
            value = safe_int(item.get("value", 0))
            if date_s:
                cleaned.append((date_s, value))
        cleaned.sort(key=lambda x: x[0])
        if len(cleaned) >= 2:
            return cleaned[-2][1]
        if len(cleaned) == 1:
            return cleaned[0][1]
        return 0


def parse_csv_addresses(
    text: str,
    label: int,
    source: str,
    label_reason: str,
    preferred_columns: Sequence[str] = (),
) -> List[CandidateAddress]:
    text = text.strip()
    if not text:
        return []
    reader = csv.DictReader(io.StringIO(text))
    out: List[CandidateAddress] = []
    preferred_l = {c.lower() for c in preferred_columns}

    for row in reader:
        if not row:
            continue
        addresses: List[str] = []

        # First try preferred columns
        for key, value in row.items():
            if key and key.lower() in preferred_l:
                addresses.extend(extract_addresses(value))

        # Then fall back to any address-looking cell
        if not addresses:
            for value in row.values():
                addresses.extend(extract_addresses(value))

        # If the row contains multiple addresses, keep all; many exploit datasets do.
        for address in addresses:
            out.append(
                CandidateAddress(
                    address=checksumish(address),
                    label=label,
                    source=source,
                    label_reason=label_reason,
                )
            )
    return out


def parse_etherscamdb_yaml(text: str) -> List[Tuple[str, str, str]]:
    """Return (address, category, subcategory)."""
    if yaml is not None:
        try:
            payload = yaml.safe_load(text)
            return _parse_etherscamdb_object(payload)
        except Exception:
            pass

    # Minimal regex fallback when PyYAML is unavailable.
    blocks = re.split(r"\n(?=-\s+id:)", text)
    out: List[Tuple[str, str, str]] = []
    for block in blocks:
        category_match = re.search(r"\n\s*category:\s*(.+)", block)
        subcategory_match = re.search(r"\n\s*subcategory:\s*(.+)", block)
        category = (
            category_match.group(1).strip() if category_match else "scam"
        ).strip("'\"")
        subcategory = (
            subcategory_match.group(1).strip() if subcategory_match else ""
        ).strip("'\"")
        for address in extract_addresses(block):
            out.append((checksumish(address), category, subcategory))
    return out


def _parse_etherscamdb_object(payload: Any) -> List[Tuple[str, str, str]]:
    out: List[Tuple[str, str, str]] = []
    if not isinstance(payload, list):
        return out
    for item in payload:
        if not isinstance(item, dict):
            continue
        category = str(item.get("category") or "scam")
        subcategory = str(item.get("subcategory") or "")
        addresses = item.get("addresses") or []
        if isinstance(addresses, str):
            addresses = extract_addresses(addresses)
        if not isinstance(addresses, list):
            continue
        for address in addresses:
            if is_valid_address(address):
                out.append((checksumish(address), category, subcategory))
    return out


def iter_addresses_from_object(obj: Any) -> Iterable[str]:
    if isinstance(obj, dict):
        for key, value in obj.items():
            if isinstance(value, str):
                yield from extract_addresses(value)
            else:
                yield from iter_addresses_from_object(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from iter_addresses_from_object(value)
    elif isinstance(obj, str):
        yield from extract_addresses(obj)


def parse_blockscout_ts(value: Any) -> Optional[float]:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def parse_blockscout_tx(tx: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    ts = parse_blockscout_ts(tx.get("timestamp"))
    if ts is None:
        return None
    from_hash = None
    to_hash = None
    if isinstance(tx.get("from"), dict):
        from_hash = tx["from"].get("hash")
    elif isinstance(tx.get("from"), str):
        from_hash = tx.get("from")
    if isinstance(tx.get("to"), dict):
        to_hash = tx["to"].get("hash")
    elif isinstance(tx.get("to"), str):
        to_hash = tx.get("to")

    to_obj = tx.get("to") if isinstance(tx.get("to"), dict) else {}
    contract_interaction = bool(
        (isinstance(to_obj, dict) and to_obj.get("is_contract"))
        or tx.get("decoded_input")
        or (
            tx.get("method") not in (None, "", "transfer", "transferFrom")
            and str(tx.get("method")).lower() != "transfer"
        )
        or str(tx.get("raw_input") or "").strip() not in ("", "0x")
    )

    gas_price_wei = safe_int(tx.get("gas_price", 0))
    return {
        "timestamp": float(ts),
        "from": checksumish(from_hash).lower()
        if is_valid_address(from_hash)
        else None,
        "to": checksumish(to_hash).lower() if is_valid_address(to_hash) else None,
        "value_wei": safe_int(tx.get("value", 0)),
        "gas_price_gwei": wei_to_gwei(gas_price_wei) if gas_price_wei > 0 else None,
        "contract_interaction": contract_interaction,
    }


def dedupe_candidates(candidates: Sequence[CandidateAddress]) -> List[CandidateAddress]:
    best: Dict[str, CandidateAddress] = {}
    for candidate in candidates:
        address = checksumish(candidate.address)
        if not is_valid_address(address):
            continue
        if address.lower() == ZERO_ADDRESS.lower():
            continue
        existing = best.get(address.lower())
        if existing is None:
            best[address.lower()] = CandidateAddress(
                address, candidate.label, candidate.source, candidate.label_reason
            )
            continue
        # Prefer anomaly labels over benign labels on conflicts.
        if candidate.label > existing.label:
            best[address.lower()] = CandidateAddress(
                address, candidate.label, candidate.source, candidate.label_reason
            )
    return list(best.values())


def stable_sample(
    candidates: Sequence[CandidateAddress], limit: int, seed: int
) -> List[CandidateAddress]:
    items = list(candidates)
    rng = random.Random(seed)
    rng.shuffle(items)
    items.sort(
        key=lambda c: hashlib.sha1(
            f"{c.address}|{c.source}".encode("utf-8")
        ).hexdigest()
    )
    return items[:limit]


def extract_addresses(value: Any) -> List[str]:
    if value is None:
        return []
    return [checksumish(m.group(0)) for m in ADDRESS_RE.finditer(str(value))]


def is_valid_address(value: Any) -> bool:
    return bool(value) and bool(ADDRESS_RE.fullmatch(str(value).strip()))


def checksumish(address: Any) -> str:
    return str(address).strip()


def safe_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return default
        return int(value)
    s = str(value).strip()
    if not s:
        return default
    try:
        return int(s)
    except ValueError:
        try:
            return int(float(s))
        except ValueError:
            return default


def wei_to_eth(value_wei: int) -> float:
    return float(value_wei) / 1e18


def wei_to_gwei(value_wei: int) -> float:
    return float(value_wei) / 1e9


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def write_rows(rows: Sequence[FeatureRow], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow(row.as_csv_row())


def build_dataset(args: argparse.Namespace) -> int:
    fetcher = Fetcher(
        cache_dir=Path(args.cache_dir),
        refresh=args.refresh,
        timeout=args.timeout,
        sleep_s=args.sleep,
    )
    collector = SourceCollector(fetcher)
    feature_builder = BlockscoutFeatureBuilder(
        fetcher,
        api_base=args.blockscout_api,
        max_pages=args.max_pages,
    )

    candidates = collector.collect()
    benign = [c for c in candidates if c.label == 0]
    anomaly = [c for c in candidates if c.label == 1]

    if args.verbose:
        print(
            f"Collected candidate addresses: benign={len(benign)} "
            f"anomaly={len(anomaly)} total={len(candidates)}"
        )

    benign = stable_sample(benign, args.max_benign * 3, seed=args.seed)
    anomaly = stable_sample(anomaly, args.max_anomaly * 3, seed=args.seed + 1)

    rows: List[FeatureRow] = []
    seen_subjects = set()
    benign_count = 0
    anomaly_count = 0
    failures = 0

    worklist = []
    max_len = max(len(benign), len(anomaly))
    for i in range(max_len):
        if i < len(benign):
            worklist.append(benign[i])
        if i < len(anomaly):
            worklist.append(anomaly[i])

    for candidate in worklist:
        if candidate.label == 0 and benign_count >= args.max_benign:
            continue
        if candidate.label == 1 and anomaly_count >= args.max_anomaly:
            continue

        try:
            row = feature_builder.build_row(candidate)
        except Exception as exc:  # pragma: no cover - depends on live APIs
            failures += 1
            if args.verbose:
                print(f"[skip] {candidate.address} ({candidate.source}) -> {exc}")
            continue

        if row is None:
            failures += 1
            continue
        if row.subject.lower() in seen_subjects:
            continue

        seen_subjects.add(row.subject.lower())
        rows.append(row)
        if candidate.label == 0:
            benign_count += 1
        else:
            anomaly_count += 1

        if args.verbose and len(rows) % 10 == 0:
            print(
                f"Built {len(rows)} rows so far "
                f"(benign={benign_count}, anomaly={anomaly_count})"
            )

        if (
            len(rows) >= args.target_rows
            and benign_count >= min(args.max_benign, args.target_rows // 3)
            and anomaly_count >= min(args.max_anomaly, args.target_rows // 3)
        ):
            break

    if len(rows) < args.min_rows:
        raise RuntimeError(
            f"Only built {len(rows)} rows "
            f"(benign={benign_count}, anomaly={anomaly_count}, failures={failures}). "
            f"Increase source limits, rerun with --refresh, or relax --min-rows."
        )

    write_rows(rows, Path(args.output))
    print(
        f"Wrote {len(rows)} rows to {args.output} "
        f"(benign={benign_count}, anomaly={anomaly_count}, failures={failures})"
    )
    return 0


def run_self_test() -> int:
    """Offline smoke-test for parsers + feature derivation using local fixtures only."""
    tmp_dir = Path("/tmp/fhe_guard_self_test")
    tmp_dir.mkdir(parents=True, exist_ok=True)

    class FixtureFetcher:
        def __init__(self):
            self.fixtures = {
                ETHERSCAN_LABEL_LISTING: b'''
                <a href="/brianleect/etherscan-labels/blob/main/data/etherscan/accounts/aave.csv">aave.csv</a>
                <a href="/brianleect/etherscan-labels/blob/main/data/etherscan/accounts/bancor-contract-vulnerability.csv">bancor-contract-vulnerability.csv</a>
                ''',
                f"{RAW_GITHUB}/brianleect/etherscan-labels/main/data/etherscan/accounts/aave.csv": b"address,name\n0x1111111111111111111111111111111111111111,Aave Treasury\n",
                f"{RAW_GITHUB}/brianleect/etherscan-labels/main/data/etherscan/accounts/bancor-contract-vulnerability.csv": b"address,name\n0x2222222222222222222222222222222222222222,Bancor Exploit\n",
                f"{RAW_GITHUB}/forta-network/labelled-datasets/main/labels/1/phishing_scams.csv": b"address,is_contract\n0x3333333333333333333333333333333333333333,false\n",
                f"{RAW_GITHUB}/forta-network/labelled-datasets/main/labels/1/malicious_smart_contracts.csv": b"contract_address,contract_tag\n0x4444444444444444444444444444444444444444,exploit\n",
                f"{RAW_GITHUB}/forta-network/labelled-datasets/main/labels/1/etherscan_malicious_labels.csv": b"address,etherscan_tag\n0x5555555555555555555555555555555555555555,phish-hack\n",
                f"{RAW_GITHUB}/MrLuit/EtherScamDB/master/_data/scams.yaml": b"- id: 1\n  category: Phishing\n  subcategory: Wallet\n  addresses:\n    - '0x6666666666666666666666666666666666666666'\n",
                f"{RAW_GITHUB}/ultrasoundmoney/ofac-ethereum-addresses/main/data.csv": b"address,program\n0x7777777777777777777777777777777777777777,SDN\n",
                f"{RAW_GITHUB}/elementus-io/plustoken/master/plustoken-ethereum-addresses.csv": b"address\n0x8888888888888888888888888888888888888888\n",
                f"{BLOCKSCOUT_API}/addresses/0x1111111111111111111111111111111111111111": json.dumps({"hash":"0x1111111111111111111111111111111111111111","coin_balance":"1000000000000000000","is_contract":False}).encode(),
                f"{BLOCKSCOUT_API}/addresses/0x1111111111111111111111111111111111111111/transactions": json.dumps({"items":[{"timestamp":"2026-03-30T12:00:00Z","from":{"hash":"0x1111111111111111111111111111111111111111"},"to":{"hash":"0x9999999999999999999999999999999999999999","is_contract":True},"value":"500000000000000000","gas_price":"20000000000","method":"swap","raw_input":"0xabcdef"}],"next_page_params":None}).encode(),
                f"{BLOCKSCOUT_API}/addresses/0x1111111111111111111111111111111111111111/coin-balance-history-by-day": json.dumps([{"date":"2026-03-29","value":"800000000000000000"},{"date":"2026-03-30","value":"1000000000000000000"}]).encode(),
            }

        def get_text(self, url: str) -> str:
            return self.fixtures[url].decode("utf-8")

        def get_json(self, url: str) -> Any:
            return json.loads(self.fixtures[url].decode("utf-8"))

    fetcher = FixtureFetcher()
    collector = SourceCollector(fetcher)  # type: ignore[arg-type]
    candidates = collector.collect()
    assert any(c.label == 0 for c in candidates), "expected benign candidates"
    assert any(c.label == 1 for c in candidates), "expected anomaly candidates"

    feature_builder = BlockscoutFeatureBuilder(fetcher)  # type: ignore[arg-type]
    benign = next(
        c for c in candidates
        if c.address.lower() == "0x1111111111111111111111111111111111111111"
    )
    row = feature_builder.build_row(benign)
    assert row is not None
    assert row.tx_value_eth > 0
    assert row.contract_interaction == 1
    assert row.label == "normal"

    output = tmp_dir / "self_test.csv"
    write_rows([row], output)
    print(f"Self-test passed. Wrote fixture CSV to {output}")
    return 0


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build packages/models/data/test_data.csv from real on-chain activity"
    )
    parser.add_argument("--output", default="packages/models/data/test_data.csv")
    parser.add_argument("--cache-dir", default="packages/models/.cache/real-data")
    parser.add_argument("--blockscout-api", default=BLOCKSCOUT_API)
    parser.add_argument(
        "--target-rows",
        type=int,
        default=220,
        help="Stop early once this many rows are built",
    )
    parser.add_argument(
        "--min-rows",
        type=int,
        default=120,
        help="Fail if fewer rows than this are built",
    )
    parser.add_argument("--max-benign", type=int, default=140)
    parser.add_argument("--max-anomaly", type=int, default=140)
    parser.add_argument(
        "--max-pages",
        type=int,
        default=10,
        help="Max Blockscout tx pages per address",
    )
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.12,
        help="Sleep between uncached HTTP requests",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Ignore HTTP cache and refetch",
    )
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run offline smoke-test and exit",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        return run_self_test()
    return build_dataset(args)


if __name__ == "__main__":
    raise SystemExit(main())