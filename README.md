# SQL Server Wait Statistics Dashboard

Single-page dashboard for SQL Server wait analysis using:

- `sys.dm_os_wait_stats` for cumulative waits since last restart
- `sys.dm_exec_requests` for active waits

## Features

- Wait categories: CPU, I/O, Memory, Other
- Cumulative wait time since SQL Server start
- Top wait types with average wait per task
- Active waits table
- Wait distribution chart
- Signal vs resource wait split
- Pattern-based recommendations
- Auto-refresh every 5 seconds
- CPU pressure highlight when signal waits exceed 25%

## Run

1. Install dependencies:

```powershell
npm install
```

2. Configure environment variables using `.env.example`.

3. Start the server:

```powershell
npm start
```

4. Open `http://localhost:3000`

## Notes

- The dashboard excludes common benign idle waits to keep the top waits meaningful.
- `VIEW SERVER STATE` permission is required to query these DMVs.
