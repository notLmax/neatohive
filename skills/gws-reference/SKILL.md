---
name: gws-reference
description: "Google Workspace CLI reference. Use when you need to query Drive, Sheets, Gmail, Calendar, Docs, or any Google Workspace service via the gws CLI."
---

# Google Workspace (`gws`) CLI Reference

## Pattern

```bash
gws <service> <resource> [sub-resource] <method> [flags]
```

## Common Examples

```bash
# Drive
gws drive files list --params '{"pageSize": 10}'
gws drive files get --params '{"fileId": "abc123"}'

# Sheets
gws sheets spreadsheets get --params '{"spreadsheetId": "..."}'
gws sheets spreadsheets.values get --params '{"spreadsheetId": "...", "range": "Sheet1!A1:D10"}'

# Gmail
gws gmail users messages list --params '{"userId": "me"}'
gws gmail users messages send --params '{"userId": "me"}' --json '{"raw": "..."}'

# Calendar
gws calendar events list --params '{"calendarId": "primary"}'

# Docs
gws docs documents get --params '{"documentId": "..."}'

# Discover API schema for any method
gws schema drive.files.list
```

## Key Flags

| Flag | Purpose |
|------|---------|
| `--params <JSON>` | URL/query parameters |
| `--json <JSON>` | Request body (POST/PATCH/PUT) |
| `--format <FMT>` | Output: json (default), table, yaml, csv |
| `--page-all` | Auto-paginate (NDJSON, one line per page) |
| `--upload <PATH>` | Upload a file (multipart) |
| `--output <PATH>` | Save binary response to file |

## Available Services

Drive, Sheets, Gmail, Calendar, Docs, Slides, Tasks, People, Chat, Forms, Keep, Meet.