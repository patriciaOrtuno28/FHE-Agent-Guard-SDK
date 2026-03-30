# Training data

Drop the real labeled dataset here before running the compiler.

Supported formats:
- `.csv`
- `.parquet`

Required columns:
- `tx_value_eth`
- `tx_count_1h`
- `tx_count_24h`
- `unique_counterparts`
- `gas_price_gwei`
- `contract_interaction`
- `time_since_last_tx`
- `balance_change_ratio`
- `label`

Recommended extra columns:
- `subject`
- `source`
- `observed_at`
- `label_reason`