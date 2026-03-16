# SQL Server Control Center

Operational dashboard for SQL Server wait analysis, query activity, blocking, and server health.

## Features

- Wait categories: CPU, I/O, Memory, Other
- Cumulative wait time since last restart
- Top wait types with clickable wait details
- Active waits and blocking sessions
- Expensive queries with average duration, CPU, reads, and writes
- Wait distribution and signal vs resource charts
- Database size and server utilization cards
- Auto-refresh selector with `Off`, seconds, and minutes
- CSV export of the current dashboard dataset
- Pattern-based recommendations with CPU pressure warning when signal waits exceed 25%
- Connection management for SQL Server instances

## Run

1. Install dependencies:

```powershell
npm install
```

2. Configure environment variables from `.env.example`.

3. Start the server:

```powershell
npm start
```

4. Open `http://127.0.0.1:3000`

## Endpoints

- `GET /healthz` returns a simple health payload
- `GET /api/waits` returns the dashboard dataset
- `GET /api/databases` lists databases for the selected server connection

## Notes

- The app binds to `127.0.0.1` by default.
- `VIEW SERVER STATE` permission is required to query wait and request DMVs.
- Windows Authentication support is intended for Windows hosts.
- Wait statistics are cumulative since the last SQL Server restart unless a history store is added.
