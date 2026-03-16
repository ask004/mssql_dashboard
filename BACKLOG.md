# Backlog

## Done

- [x] Build a modern dark-themed SQL Server dashboard
- [x] Add connection management UI
- [x] Support SQL authentication
- [x] Support Windows authentication on Windows hosts
- [x] Query `sys.dm_os_wait_stats`
- [x] Query `sys.dm_exec_requests`
- [x] Categorize waits into CPU, I/O, Memory, and Other
- [x] Show cumulative wait time since last restart
- [x] Show top wait types
- [x] Show average wait time per task
- [x] Show active waits
- [x] Show wait distribution chart
- [x] Show signal vs resource waits
- [x] Highlight CPU pressure when signal wait exceeds 25%
- [x] Add recommendations based on wait patterns
- [x] Auto-refresh with selectable interval
- [x] Add database selector on dashboard
- [x] Show blocking sessions
- [x] Show expensive queries
- [x] Filter expensive queries to `execution_count > 50`
- [x] Show selected database size
- [x] Show server CPU, memory, and network utilization
- [x] Add wait type modal with built-in summaries and SQLskills links
- [x] Add full query text modal for expensive queries
- [x] Improve security by removing secret exposure from API responses
- [x] Encrypt persisted secrets at rest with DPAPI on Windows
- [x] Bind server to localhost by default
- [x] Disable SQL text exposure by default for active waits
- [x] Add git repository and publish to GitHub

## V2

- [ ] Add history snapshot storage
- [ ] Support last 1 hour / 1 day / 1 week / 1 month trend views
- [ ] Compute wait deltas between snapshots instead of restart-level totals only
- [ ] Add trend charts for waits, CPU, memory, and network
- [ ] Add Query Store integration
- [ ] Add baseline comparison and anomaly detection
- [ ] Add alerting rules
- [ ] Make secret storage Linux-compatible for Ubuntu hosting
- [ ] Support Ubuntu-hosted integrated authentication via Kerberos if needed
- [ ] Add application authentication/authorization
- [ ] Expand built-in wait type summary coverage

## Notes

- Current wait statistics are restart-scoped, not history-scoped.
- Active waits are real-time.
- Expensive queries are based on plan cache/query stats, not full historical storage.
