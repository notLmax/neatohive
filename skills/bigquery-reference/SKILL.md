---
name: bigquery-reference
description: "BigQuery CLI reference. Use when you need to query datasets, manage tables, or load/export data via the bq CLI."
---

# BigQuery (`bq`) CLI Reference

## Common Commands

```bash
# Run a query
bq query --use_legacy_sql=false 'SELECT * FROM `project.dataset.table` LIMIT 10'

# List datasets
bq ls

# Show table schema
bq show --schema project:dataset.table

# Load data
bq load --source_format=CSV project:dataset.table ./data.csv

# Export data
bq extract project:dataset.table gs://bucket/export.csv
```

## Key Flags

| Flag | Purpose |
|------|---------|
| `--use_legacy_sql=false` | Use standard SQL (always use this) |
| `--format=prettyjson` | Pretty-print JSON output |
| `--max_rows=N` | Limit result rows |
| `--source_format=FMT` | CSV, JSON, AVRO, PARQUET for loads |

## Neato Data

- **Project:** neato-data (GCP service account in 1Password)
- **Primary data:** SP API reports + Amazon Ads data