# NeuroPilot Ops Dashboard (local)

Static HTML/JS reads JSON from `../ops-snapshot/` (sibling folder under `neuropilot_trading_v2`).

## Why you see 404 on `/ops-snapshot/*.json`

`python3 -m http.server` only serves **the current working directory** as the web root.

If you `cd ops-dashboard` and start the server, the root is `ops-dashboard/` only. The folder `ops-snapshot` is **not** inside that root (it sits next to it on disk), so the server correctly returns **404** for `/ops-snapshot/...`.

## Correct local preview

From **`neuropilot_trading_v2`** (parent of both `ops-dashboard` and `ops-snapshot`):

```bash
cd /path/to/neuropilot_trading_v2
python3 -m http.server 8080
```

Open: **http://localhost:8080/ops-dashboard/**

Ensure snapshots exist (run baseline / `exportOpsSnapshot.js` first).

## Favicon 404

A minimal `favicon.ico` lives at **`neuropilot_trading_v2/favicon.ico`** (web root when you `cd neuropilot_trading_v2` and run `python3 -m http.server`), so `/favicon.ico` should no longer 404.
