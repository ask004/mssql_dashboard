const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sql = require("mssql");
const sqlNative = require("mssql/msnodesqlv8");

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const dataDir = path.join(__dirname, "data");
const connectionsFile = path.join(dataDir, "connections.json");
const poolCache = new Map();
const windowsIdentity = [process.env.USERDOMAIN, process.env.USERNAME]
  .filter(Boolean)
  .join("\\");
const encryptionScope = "CurrentUser";
const exposeSqlText =
  (process.env.EXPOSE_SQL_TEXT || "false").toLowerCase() === "true";

const excludedWaits = [
  "BROKER_EVENTHANDLER",
  "BROKER_RECEIVE_WAITFOR",
  "BROKER_TASK_STOP",
  "BROKER_TO_FLUSH",
  "BROKER_TRANSMITTER",
  "CHECKPOINT_QUEUE",
  "CHKPT",
  "CLR_AUTO_EVENT",
  "CLR_MANUAL_EVENT",
  "CLR_SEMAPHORE",
  "DBMIRROR_DBM_EVENT",
  "DBMIRROR_EVENTS_QUEUE",
  "DBMIRROR_WORKER_QUEUE",
  "DBMIRRORING_CMD",
  "DIRTY_PAGE_POLL",
  "DISPATCHER_QUEUE_SEMAPHORE",
  "EXECSYNC",
  "FSAGENT",
  "FT_IFTS_SCHEDULER_IDLE_WAIT",
  "FT_IFTSHC_MUTEX",
  "HADR_CLUSAPI_CALL",
  "HADR_FILESTREAM_IOMGR_IOCOMPLETION",
  "HADR_LOGCAPTURE_WAIT",
  "HADR_NOTIFICATION_DEQUEUE",
  "HADR_TIMER_TASK",
  "HADR_WORK_QUEUE",
  "KSOURCE_WAKEUP",
  "LAZYWRITER_SLEEP",
  "LOGMGR_QUEUE",
  "MEMORY_ALLOCATION_EXT",
  "ONDEMAND_TASK_QUEUE",
  "PARALLEL_REDO_DRAIN_WORKER",
  "PARALLEL_REDO_LOG_CACHE",
  "PARALLEL_REDO_TRAN_LIST",
  "PARALLEL_REDO_WORKER_SYNC",
  "PARALLEL_REDO_WORKER_WAIT_WORK",
  "PREEMPTIVE_OS_FLUSHFILEBUFFERS",
  "PREEMPTIVE_XE_GETTARGETSTATE",
  "PWAIT_ALL_COMPONENTS_INITIALIZED",
  "PWAIT_DIRECTLOGCONSUMER_GETNEXT",
  "QDS_PERSIST_TASK_MAIN_LOOP_SLEEP",
  "QDS_ASYNC_QUEUE",
  "QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP",
  "QDS_SHUTDOWN_QUEUE",
  "REDO_THREAD_PENDING_WORK",
  "REQUEST_FOR_DEADLOCK_SEARCH",
  "RESOURCE_QUEUE",
  "SERVER_IDLE_CHECK",
  "SLEEP_BPOOL_FLUSH",
  "SLEEP_DBSTARTUP",
  "SLEEP_DCOMSTARTUP",
  "SLEEP_MASTERDBREADY",
  "SLEEP_MASTERMDREADY",
  "SLEEP_MASTERUPGRADED",
  "SLEEP_MSDBSTARTUP",
  "SLEEP_SYSTEMTASK",
  "SLEEP_TASK",
  "SLEEP_TEMPDBSTARTUP",
  "SNI_HTTP_ACCEPT",
  "SP_SERVER_DIAGNOSTICS_SLEEP",
  "SQLTRACE_BUFFER_FLUSH",
  "SQLTRACE_INCREMENTAL_FLUSH_SLEEP",
  "SQLTRACE_WAIT_ENTRIES",
  "WAIT_FOR_RESULTS",
  "WAITFOR",
  "WAITFOR_TASKSHUTDOWN",
  "WAIT_XTP_RECOVERY",
  "WAIT_XTP_HOST_WAIT",
  "WAIT_XTP_OFFLINE_CKPT_NEW_LOG",
  "WAIT_XTP_CKPT_CLOSE",
  "XE_DISPATCHER_JOIN",
  "XE_DISPATCHER_WAIT",
  "XE_TIMER_EVENT"
];

const waitQuery = `
  SET NOCOUNT ON;

  DECLARE @excluded TABLE (wait_type sysname PRIMARY KEY);
  INSERT INTO @excluded(wait_type) VALUES ${excludedWaits
    .map((_, index) => `(@wait${index})`)
    .join(",")};

  ;WITH wait_data AS (
    SELECT
      ws.wait_type,
      ws.wait_time_ms,
      ws.signal_wait_time_ms,
      ws.waiting_tasks_count,
      ws.wait_time_ms - ws.signal_wait_time_ms AS resource_wait_time_ms
    FROM sys.dm_os_wait_stats AS ws
    WHERE ws.wait_type COLLATE DATABASE_DEFAULT NOT IN (
      SELECT wait_type COLLATE DATABASE_DEFAULT FROM @excluded
    )
      AND ws.waiting_tasks_count > 0
      AND ws.wait_time_ms > 0
  )
  SELECT
    osi.sqlserver_start_time,
    SUM(wait_time_ms) AS total_wait_time_ms,
    SUM(signal_wait_time_ms) AS total_signal_wait_time_ms,
    SUM(resource_wait_time_ms) AS total_resource_wait_time_ms,
    SUM(waiting_tasks_count) AS total_waiting_tasks
  FROM wait_data
  CROSS JOIN sys.dm_os_sys_info AS osi
  GROUP BY osi.sqlserver_start_time;

  ;WITH wait_data AS (
    SELECT TOP (12)
      ws.wait_type,
      ws.wait_time_ms,
      ws.signal_wait_time_ms,
      ws.waiting_tasks_count,
      ws.wait_time_ms - ws.signal_wait_time_ms AS resource_wait_time_ms
    FROM sys.dm_os_wait_stats AS ws
    WHERE ws.wait_type COLLATE DATABASE_DEFAULT NOT IN (
      SELECT wait_type COLLATE DATABASE_DEFAULT FROM @excluded
    )
      AND ws.waiting_tasks_count > 0
      AND ws.wait_time_ms > 0
    ORDER BY ws.wait_time_ms DESC
  ),
  totals AS (
    SELECT SUM(wait_time_ms) AS total_wait_time_ms
    FROM sys.dm_os_wait_stats
    WHERE wait_type COLLATE DATABASE_DEFAULT NOT IN (
      SELECT wait_type COLLATE DATABASE_DEFAULT FROM @excluded
    )
      AND waiting_tasks_count > 0
      AND wait_time_ms > 0
  )
  SELECT
    wd.wait_type,
    wd.wait_time_ms,
    wd.signal_wait_time_ms,
    wd.resource_wait_time_ms,
    wd.waiting_tasks_count,
    CAST(wd.wait_time_ms * 100.0 / NULLIF(t.total_wait_time_ms, 0) AS decimal(10, 2)) AS wait_pct,
    CAST(wd.wait_time_ms * 1.0 / NULLIF(wd.waiting_tasks_count, 0) AS decimal(18, 2)) AS avg_wait_time_ms
  FROM wait_data AS wd
  CROSS JOIN totals AS t
  ORDER BY wd.wait_time_ms DESC;

  ;WITH wait_data AS (
    SELECT
      ws.wait_type,
      ws.wait_time_ms
    FROM sys.dm_os_wait_stats AS ws
    WHERE ws.wait_type COLLATE DATABASE_DEFAULT NOT IN (
      SELECT wait_type COLLATE DATABASE_DEFAULT FROM @excluded
    )
      AND ws.waiting_tasks_count > 0
      AND ws.wait_time_ms > 0
  )
  SELECT
    CASE
      WHEN wait_type LIKE 'SOS_SCHEDULER_YIELD'
        OR wait_type LIKE 'CXCONSUMER'
        OR wait_type LIKE 'CXPACKET'
        OR wait_type LIKE 'THREADPOOL'
        OR wait_type LIKE 'PREEMPTIVE_%' THEN 'CPU'
      WHEN wait_type LIKE 'PAGEIOLATCH%'
        OR wait_type LIKE 'IO_COMPLETION'
        OR wait_type LIKE 'ASYNC_IO_COMPLETION'
        OR wait_type LIKE 'WRITELOG'
        OR wait_type LIKE 'LOGBUFFER'
        OR wait_type LIKE 'BACKUPIO'
        OR wait_type LIKE 'TRACEWRITE'
        OR wait_type LIKE 'FCB_REPLICA_WRITE'
        OR wait_type LIKE 'HADR_SYNC_COMMIT'
        OR wait_type LIKE 'HADR_DATABASE_FLOW_CONTROL' THEN 'I/O'
      WHEN wait_type LIKE 'RESOURCE_SEMAPHORE%'
        OR wait_type LIKE 'CMEMTHREAD'
        OR wait_type LIKE 'CMEMPARTITIONED'
        OR wait_type LIKE 'MEMORY_ALLOCATION_EXT'
        OR wait_type LIKE 'MEMORY_GRANT_UPDATE'
        OR wait_type LIKE 'RESERVED_MEMORY_ALLOCATION_EXT'
        OR wait_type LIKE 'MEMORYCLERK_SQLBUFFERPOOL' THEN 'Memory'
      ELSE 'Other'
    END AS category,
    SUM(wait_time_ms) AS wait_time_ms
  FROM wait_data
  GROUP BY
    CASE
      WHEN wait_type LIKE 'SOS_SCHEDULER_YIELD'
        OR wait_type LIKE 'CXCONSUMER'
        OR wait_type LIKE 'CXPACKET'
        OR wait_type LIKE 'THREADPOOL'
        OR wait_type LIKE 'PREEMPTIVE_%' THEN 'CPU'
      WHEN wait_type LIKE 'PAGEIOLATCH%'
        OR wait_type LIKE 'IO_COMPLETION'
        OR wait_type LIKE 'ASYNC_IO_COMPLETION'
        OR wait_type LIKE 'WRITELOG'
        OR wait_type LIKE 'LOGBUFFER'
        OR wait_type LIKE 'BACKUPIO'
        OR wait_type LIKE 'TRACEWRITE'
        OR wait_type LIKE 'FCB_REPLICA_WRITE'
        OR wait_type LIKE 'HADR_SYNC_COMMIT'
        OR wait_type LIKE 'HADR_DATABASE_FLOW_CONTROL' THEN 'I/O'
      WHEN wait_type LIKE 'RESOURCE_SEMAPHORE%'
        OR wait_type LIKE 'CMEMTHREAD'
        OR wait_type LIKE 'CMEMPARTITIONED'
        OR wait_type LIKE 'MEMORY_ALLOCATION_EXT'
        OR wait_type LIKE 'MEMORY_GRANT_UPDATE'
        OR wait_type LIKE 'RESERVED_MEMORY_ALLOCATION_EXT'
        OR wait_type LIKE 'MEMORYCLERK_SQLBUFFERPOOL' THEN 'Memory'
      ELSE 'Other'
    END;

  SELECT
    r.session_id,
    DB_NAME(r.database_id) AS database_name,
    r.status,
    r.command,
    r.cpu_time,
    r.total_elapsed_time,
    r.wait_type,
    r.wait_time,
    r.last_wait_type,
    r.blocking_session_id,
    SUBSTRING(
      st.text,
      (r.statement_start_offset / 2) + 1,
      CASE
        WHEN r.statement_end_offset = -1 THEN LEN(CONVERT(nvarchar(max), st.text))
        ELSE (r.statement_end_offset - r.statement_start_offset) / 2 + 1
      END
    ) AS current_statement
  FROM sys.dm_exec_requests AS r
  CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) AS st
  WHERE r.session_id <> @@SPID
    AND r.wait_type IS NOT NULL
    AND (@selectedDatabase IS NULL OR DB_NAME(r.database_id) = @selectedDatabase)
  ORDER BY r.wait_time DESC, r.cpu_time DESC;

  SELECT TOP (10)
    CONVERT(varchar(128), qs.sql_handle, 2) AS sql_id,
    DB_NAME(CONVERT(int, pa.value)) AS database_name,
    qs.execution_count,
    CAST((qs.total_elapsed_time * 1.0 / NULLIF(qs.execution_count, 0)) / 1000.0 AS decimal(18, 2)) AS duration_time_avg_ms,
    CAST((qs.total_logical_reads * 1.0 / NULLIF(qs.execution_count, 0)) AS decimal(18, 2)) AS logical_reads_avg,
    LEFT(LTRIM(RTRIM(SUBSTRING(
      st.text,
      (qs.statement_start_offset / 2) + 1,
      CASE
        WHEN qs.statement_end_offset = -1 THEN LEN(CONVERT(nvarchar(max), st.text))
        ELSE (qs.statement_end_offset - qs.statement_start_offset) / 2 + 1
      END
    ))), 50) AS statement_preview
  FROM sys.dm_exec_query_stats AS qs
  CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) AS st
  CROSS APPLY sys.dm_exec_plan_attributes(qs.plan_handle) AS pa
  WHERE pa.attribute = 'dbid'
    AND (@selectedDatabase IS NULL OR DB_NAME(CONVERT(int, pa.value)) = @selectedDatabase)
  ORDER BY duration_time_avg_ms DESC, logical_reads_avg DESC;

  SELECT
    blocked.session_id AS blocked_session_id,
    blocked.blocking_session_id,
    DB_NAME(blocked.database_id) AS database_name,
    blocked.wait_type,
    blocked.wait_time,
    blocker.status AS blocker_status,
    blocker.command AS blocker_command,
    blocked.status AS blocked_status
  FROM sys.dm_exec_requests AS blocked
  LEFT JOIN sys.dm_exec_requests AS blocker
    ON blocked.blocking_session_id = blocker.session_id
  WHERE blocked.blocking_session_id > 0
    AND (@selectedDatabase IS NULL OR DB_NAME(blocked.database_id) = @selectedDatabase)
  ORDER BY blocked.wait_time DESC, blocked.session_id;

  SELECT
    DB_NAME(mf.database_id) AS database_name,
    CAST(SUM(CASE WHEN mf.type_desc = 'ROWS' THEN mf.size END) * 8.0 / 1024 AS decimal(18, 2)) AS data_size_mb,
    CAST(SUM(CASE WHEN mf.type_desc = 'LOG' THEN mf.size END) * 8.0 / 1024 AS decimal(18, 2)) AS log_size_mb,
    CAST(SUM(mf.size) * 8.0 / 1024 AS decimal(18, 2)) AS total_size_mb
  FROM sys.master_files AS mf
  WHERE @selectedDatabase IS NOT NULL
    AND DB_NAME(mf.database_id) = @selectedDatabase
  GROUP BY DB_NAME(mf.database_id);

  ;WITH cpu_sample AS (
    SELECT TOP (1)
      record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]', 'int') AS system_idle_pct,
      record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]', 'int') AS sql_cpu_pct
    FROM (
      SELECT
        CONVERT(xml, rb.record) AS record,
        rb.[timestamp]
      FROM sys.dm_os_ring_buffers AS rb
      WHERE rb.ring_buffer_type = 'RING_BUFFER_SCHEDULER_MONITOR'
        AND rb.record LIKE '%<SystemHealth>%'
    ) AS samples
    ORDER BY [timestamp] DESC
  ),
  network_counters AS (
    SELECT
      MAX(CASE WHEN counter_name = 'Bytes Sent to Transport/sec' THEN cntr_value END) AS bytes_sent_per_sec,
      MAX(CASE WHEN counter_name = 'Bytes Received from Transport/sec' THEN cntr_value END) AS bytes_received_per_sec
    FROM sys.dm_os_performance_counters
    WHERE object_name LIKE '%SQL Statistics%'
      AND counter_name IN ('Bytes Sent to Transport/sec', 'Bytes Received from Transport/sec')
  )
  SELECT
    cpu.sql_cpu_pct,
    CASE
      WHEN cpu.system_idle_pct IS NULL OR cpu.sql_cpu_pct IS NULL THEN NULL
      ELSE 100 - cpu.system_idle_pct - cpu.sql_cpu_pct
    END AS other_cpu_pct,
    pm.physical_memory_in_use_kb / 1024 AS sql_memory_mb,
    sm.total_physical_memory_kb / 1024 AS total_memory_mb,
    (sm.total_physical_memory_kb - sm.available_physical_memory_kb) / 1024 AS used_memory_mb,
    CAST(
      ((sm.total_physical_memory_kb - sm.available_physical_memory_kb) * 100.0)
      / NULLIF(sm.total_physical_memory_kb, 0) AS decimal(10, 2)
    ) AS memory_utilization_pct,
    nc.bytes_sent_per_sec,
    nc.bytes_received_per_sec
  FROM cpu_sample AS cpu
  CROSS JOIN sys.dm_os_process_memory AS pm
  CROSS JOIN sys.dm_os_sys_memory AS sm
  CROSS JOIN network_counters AS nc;
`;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function ensureStorage() {
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(connectionsFile)) {
    const initial = {
      selectedConnectionId: null,
      connections: []
    };

    fs.writeFileSync(connectionsFile, JSON.stringify(initial, null, 2));
  }
}

function getEnvConnection() {
  if (process.env.DB_CONNECTION_STRING) {
    return {
      id: "env-connection",
      name: process.env.DB_LABEL || "Environment connection",
      server: process.env.DB_SERVER || "from connection string",
      authType: "sql",
      encrypt: (process.env.DB_ENCRYPT || "false").toLowerCase() === "true",
      trustServerCertificate:
        (process.env.DB_TRUST_CERT || "true").toLowerCase() === "true",
      port: Number(process.env.DB_PORT || 1433),
      username: process.env.DB_USER || "",
      password: process.env.DB_PASSWORD || "",
      connectionString: process.env.DB_CONNECTION_STRING,
      source: "env",
      isReadonly: true
    };
  }

  if (process.env.DB_SERVER || process.env.DB_USER) {
    return {
      id: "env-connection",
      name: process.env.DB_LABEL || "Environment connection",
      server: process.env.DB_SERVER || "localhost",
      authType: "sql",
      encrypt: (process.env.DB_ENCRYPT || "false").toLowerCase() === "true",
      trustServerCertificate:
        (process.env.DB_TRUST_CERT || "true").toLowerCase() === "true",
      port: Number(process.env.DB_PORT || 1433),
      username: process.env.DB_USER || "",
      password: process.env.DB_PASSWORD || "",
      source: "env",
      isReadonly: true
    };
  }

  return null;
}

function readConnectionStore() {
  ensureStorage();
  const raw = fs.readFileSync(connectionsFile, "utf8");
  const store = JSON.parse(raw);
  let changed = false;
  store.connections = (store.connections || []).map((connection) => {
    const normalized = normalizeStoredConnection(connection);
    if (
      normalized.passwordEncrypted !== connection.passwordEncrypted ||
      normalized.connectionStringEncrypted !== connection.connectionStringEncrypted ||
      normalized.password !== connection.password ||
      normalized.connectionString !== connection.connectionString
    ) {
      changed = true;
    }
    return normalized;
  });
  const envConnection = getEnvConnection();

  if (envConnection) {
    const filtered = (store.connections || []).filter(
      (connection) => connection.id !== envConnection.id
    );
    store.connections = [envConnection, ...filtered];

    if (!store.selectedConnectionId) {
      store.selectedConnectionId = envConnection.id;
    }
  }

  if (changed) {
    writeConnectionStore(store);
  }

  return {
    selectedConnectionId: store.selectedConnectionId || null,
    connections: Array.isArray(store.connections) ? store.connections : []
  };
}

function writeConnectionStore(store) {
  const sanitizedConnections = store.connections.filter(
    (connection) => connection.source !== "env"
  );

  const payload = {
    selectedConnectionId: store.selectedConnectionId,
    connections: sanitizedConnections
  };

  fs.writeFileSync(connectionsFile, JSON.stringify(payload, null, 2));
}

function encryptSecret(value) {
  if (!value) {
    return "";
  }

  return crypto
    .dpapiProtect(Buffer.from(String(value), "utf8"), null, encryptionScope)
    .toString("base64");
}

function decryptSecret(value) {
  if (!value) {
    return "";
  }

  try {
    return crypto
      .dpapiUnprotect(Buffer.from(String(value), "base64"), null, encryptionScope)
      .toString("utf8");
  } catch (_error) {
    return String(value);
  }
}

function normalizeStoredConnection(connection) {
  const normalized = { ...connection };

  if (normalized.password && !normalized.passwordEncrypted) {
    normalized.password = encryptSecret(normalized.password);
    normalized.passwordEncrypted = true;
  }

  if (normalized.connectionString && !normalized.connectionStringEncrypted) {
    normalized.connectionString = encryptSecret(normalized.connectionString);
    normalized.connectionStringEncrypted = true;
  }

  return normalized;
}

function materializeConnection(connection) {
  const normalized = normalizeStoredConnection(connection);
  return {
    ...normalized,
    password: normalized.passwordEncrypted
      ? decryptSecret(normalized.password)
      : normalized.password || "",
    connectionString: normalized.connectionStringEncrypted
      ? decryptSecret(normalized.connectionString)
      : normalized.connectionString || ""
  };
}

function sanitizeConnection(connection) {
  return {
    id: connection.id,
    name: connection.name,
    server: connection.server,
    port: Number(connection.port || 1433),
    authType: connection.authType || "sql",
    username: connection.username || "",
    encrypt: Boolean(connection.encrypt),
    trustServerCertificate: Boolean(connection.trustServerCertificate),
    source: connection.source || "local",
    isReadonly: Boolean(connection.isReadonly),
    hasConnectionString: Boolean(connection.connectionString),
    effectiveIdentity:
      connection.authType === "windows" ? windowsIdentity || "Current Windows session" : ""
  };
}

function validateConnectionInput(input) {
  const connectionString = String(input.connectionString || "").trim();
  const authType = input.authType === "windows" ? "windows" : "sql";

  if (!String(input.name || "").trim()) {
    return "Connection name is required.";
  }

  if (connectionString) {
    return null;
  }

  if (!String(input.server || "").trim()) {
    return "Server is required.";
  }

  if (authType === "sql" && !String(input.username || "").trim()) {
    return "Username is required for SQL authentication.";
  }

  return null;
}

function buildSqlConfig(connection) {
  if ((connection.authType || "sql") === "windows") {
    const serverWithPort = connection.server.includes(",")
      ? connection.server
      : `${connection.server},${Number(connection.port || 1433)}`;

    return {
      server: serverWithPort,
      database: "master",
      driver: process.env.SQL_ODBC_DRIVER || "ODBC Driver 18 for SQL Server",
      options: {
        trustedConnection: true,
        encrypt: Boolean(connection.encrypt),
        trustServerCertificate: Boolean(connection.trustServerCertificate)
      }
    };
  }

  if (connection.connectionString) {
    return {
      connectionString: connection.connectionString,
      options: {
        encrypt: Boolean(connection.encrypt),
        trustServerCertificate: Boolean(connection.trustServerCertificate)
      }
    };
  }

  const config = {
    server: connection.server,
    database: "master",
    port: Number(connection.port || 1433),
    options: {
      encrypt: Boolean(connection.encrypt),
      trustServerCertificate: Boolean(connection.trustServerCertificate)
    }
  };

  if ((connection.authType || "sql") === "sql") {
    config.user = connection.username;
    config.password = connection.password || "";
  }

  return config;
}

function getSqlClient(connection) {
  return (connection.authType || "sql") === "windows" ? sqlNative : sql;
}

function categorizeWait(waitType = "") {
  if (
    /^SOS_SCHEDULER_YIELD$|^CX(CONSUMER|PACKET)$|^THREADPOOL$|^PREEMPTIVE_/i.test(
      waitType
    )
  ) {
    return "CPU";
  }

  if (
    /^(PAGEIOLATCH|IO_COMPLETION|ASYNC_IO_COMPLETION|WRITELOG|LOGBUFFER|BACKUPIO|TRACEWRITE|FCB_REPLICA_WRITE|HADR_SYNC_COMMIT|HADR_DATABASE_FLOW_CONTROL)/i.test(
      waitType
    )
  ) {
    return "I/O";
  }

  if (
    /^(RESOURCE_SEMAPHORE|RESOURCE_SEMAPHORE_QUERY_COMPILE|CMEMTHREAD|CMEMPARTITIONED|MEMORY_ALLOCATION_EXT|MEMORY_GRANT_UPDATE|RESERVED_MEMORY_ALLOCATION_EXT|MEMORYCLERK_SQLBUFFERPOOL)/i.test(
      waitType
    )
  ) {
    return "Memory";
  }

  return "Other";
}

function buildRecommendations(topWaits, signalPct, activeWaits) {
  const notes = [];
  const top = topWaits[0];

  if (signalPct > 25) {
    notes.push({
      severity: "high",
      title: "CPU pressure detected",
      detail:
        "Signal waits exceed 25% of total wait time. Check scheduler saturation, parallelism settings, and expensive CPU-bound queries."
    });
  }

  if (top && top.category === "I/O") {
    notes.push({
      severity: "medium",
      title: "I/O waits dominate",
      detail:
        "Storage latency is a likely bottleneck. Review PAGEIOLATCH/WRITELOG patterns, file placement, and long-running read or log-heavy workloads."
    });
  }

  if (top && top.category === "Memory") {
    notes.push({
      severity: "medium",
      title: "Memory contention pattern",
      detail:
        "Memory-class waits are leading. Check memory grants, buffer pool pressure, and query plans with large spills or sorts."
    });
  }

  if (
    activeWaits.some((wait) =>
      ["LCK_M_S", "LCK_M_X", "LCK_M_U", "LCK_M_IX"].includes(wait.wait_type)
    )
  ) {
    notes.push({
      severity: "medium",
      title: "Blocking is visible in active requests",
      detail:
        "Lock waits are currently active. Review blocking chains, transaction scope, and missing indexes that prolong locks."
    });
  }

  if (!notes.length) {
    notes.push({
      severity: "low",
      title: "No dominant pressure pattern",
      detail:
        "Current waits look mixed. Compare with a known baseline and correlate spikes with workload changes before tuning."
    });
  }

  return notes;
}

async function getPoolForConnection(connection) {
  const liveConnection = materializeConnection(connection);
  const key = liveConnection.id;

  if (!poolCache.has(key)) {
    const sqlClient = getSqlClient(liveConnection);
    const pool = new sqlClient.ConnectionPool(buildSqlConfig(liveConnection));
    poolCache.set(key, pool.connect());
  }

  return poolCache.get(key);
}

async function clearPool(connectionId) {
  if (!poolCache.has(connectionId)) {
    return;
  }

  const poolPromise = poolCache.get(connectionId);
  poolCache.delete(connectionId);

  try {
    const pool = await poolPromise;
    await pool.close();
  } catch (_error) {
    return;
  }
}

function getSelectedConnection() {
  const store = readConnectionStore();
  const selected = store.connections.find(
    (connection) => connection.id === store.selectedConnectionId
  );

  return {
    store,
    selectedConnection: selected || null
  };
}

async function queryWaitStats(connection) {
  const pool = await getPoolForConnection(connection);
  const request = pool.request();
  const sqlClient = getSqlClient(connection);
  const selectedDatabase = null;

  excludedWaits.forEach((wait, index) => {
    request.input(`wait${index}`, sqlClient.NVarChar, wait);
  });
  request.input("selectedDatabase", sqlClient.NVarChar, selectedDatabase);

  const result = await request.batch(waitQuery);
  return buildWaitPayload(result, connection, selectedDatabase);
}

function buildWaitPayload(result, connection, selectedDatabase) {
  const summary = result.recordsets[0][0] || {
    sqlserver_start_time: null,
    total_wait_time_ms: 0,
    total_signal_wait_time_ms: 0,
    total_resource_wait_time_ms: 0,
    total_waiting_tasks: 0
  };

  const topWaits = (result.recordsets[1] || []).map((row) => ({
    ...row,
    category: categorizeWait(row.wait_type)
  }));

  const categoryTotals = (result.recordsets[2] || []).reduce(
    (acc, row) => {
      acc[row.category] = Number(row.wait_time_ms || 0);
      return acc;
    },
    { CPU: 0, "I/O": 0, Memory: 0, Other: 0 }
  );

  const activeWaits = (result.recordsets[3] || []).map((row) => ({
    ...row,
    current_statement: exposeSqlText ? row.current_statement : null,
    category: categorizeWait(row.wait_type)
  }));

  const longRunningQueries = (result.recordsets[4] || []).map((row) => ({
    ...row,
    current_statement: exposeSqlText ? row.current_statement : null
  }));

  const blockingSessions = result.recordsets[5] || [];
  const databaseSize = result.recordsets[6]?.[0] || null;
  const serverUtilization = result.recordsets[7]?.[0] || null;

  const signalWaitPct = summary.total_wait_time_ms
    ? Number(
        (
          (summary.total_signal_wait_time_ms / summary.total_wait_time_ms) *
          100
        ).toFixed(2)
      )
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    sqlserverStartTime: summary.sqlserver_start_time,
    connection: sanitizeConnection(connection),
    selectedDatabase,
    totals: {
      cumulativeWaitMs: Number(summary.total_wait_time_ms || 0),
      cumulativeSignalWaitMs: Number(summary.total_signal_wait_time_ms || 0),
      cumulativeResourceWaitMs: Number(summary.total_resource_wait_time_ms || 0),
      cumulativeWaitingTasks: Number(summary.total_waiting_tasks || 0),
      signalWaitPct
    },
    categories: categoryTotals,
    topWaits,
    activeWaits,
    longRunningQueries,
    blockingSessions,
    databaseSize,
    serverUtilization,
    cpuPressure: signalWaitPct > 25,
    recommendations: buildRecommendations(topWaits, signalWaitPct, activeWaits)
  };
}

async function listDatabases(connection) {
  const pool = await getPoolForConnection(connection);
  const result = await pool.request().query(`
    SELECT name
    FROM sys.databases
    WHERE state_desc = 'ONLINE'
    ORDER BY CASE WHEN database_id = 1 THEN 0 ELSE 1 END, name;
  `);

  return result.recordset.map((row) => row.name);
}

async function getQueryTextBySqlId(connection, sqlId) {
  const pool = await getPoolForConnection(connection);
  const sqlClient = getSqlClient(connection);
  const handle = Buffer.from(sqlId, "hex");
  const result = await pool.request().input("sqlHandle", sqlClient.VarBinary, handle).query(`
    SELECT text
    FROM sys.dm_exec_sql_text(@sqlHandle);
  `);

  return result.recordset[0]?.text || null;
}

app.get("/api/connections", (_req, res) => {
  const store = readConnectionStore();

  res.json({
    windowsIdentity: windowsIdentity || "Current Windows session",
    selectedConnectionId: store.selectedConnectionId,
    connections: store.connections.map(sanitizeConnection)
  });
});

app.post("/api/connections", async (req, res) => {
  const error = validateConnectionInput(req.body || {});
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const store = readConnectionStore();
  const connection = normalizeStoredConnection({
    id: crypto.randomUUID(),
    name: String(req.body.name).trim(),
    server: String(req.body.server || "").trim(),
    port: Number(req.body.port || 1433),
    authType: req.body.authType === "windows" ? "windows" : "sql",
    username: String(req.body.username || "").trim(),
    password: String(req.body.password || ""),
    encrypt: Boolean(req.body.encrypt),
    trustServerCertificate: Boolean(req.body.trustServerCertificate),
    connectionString: String(req.body.connectionString || "").trim(),
    source: "local",
    isReadonly: false
  });

  store.connections.push(connection);
  if (!store.selectedConnectionId) {
    store.selectedConnectionId = connection.id;
  }
  writeConnectionStore(store);

  res.status(201).json({ connection: sanitizeConnection(connection) });
});

app.put("/api/connections/:id", async (req, res) => {
  const store = readConnectionStore();
  const existing = store.connections.find(
    (connection) => connection.id === req.params.id
  );

  if (!existing) {
    res.status(404).json({ error: "Connection not found." });
    return;
  }

  if (existing.isReadonly) {
    res.status(403).json({ error: "Environment connection cannot be modified." });
    return;
  }

  const error = validateConnectionInput(req.body || {});
  if (error) {
    res.status(400).json({ error });
    return;
  }

  Object.assign(existing, {
    name: String(req.body.name).trim(),
    server: String(req.body.server || "").trim(),
    port: Number(req.body.port || 1433),
    authType: req.body.authType === "windows" ? "windows" : "sql",
    username: String(req.body.username || "").trim(),
    password: encryptSecret(String(req.body.password || "")),
    passwordEncrypted: true,
    encrypt: Boolean(req.body.encrypt),
    trustServerCertificate: Boolean(req.body.trustServerCertificate),
    connectionString: encryptSecret(String(req.body.connectionString || "").trim()),
    connectionStringEncrypted: true
  });

  writeConnectionStore(store);
  await clearPool(existing.id);

  res.json({ connection: sanitizeConnection(existing) });
});

app.delete("/api/connections/:id", async (req, res) => {
  const store = readConnectionStore();
  const existing = store.connections.find(
    (connection) => connection.id === req.params.id
  );

  if (!existing) {
    res.status(404).json({ error: "Connection not found." });
    return;
  }

  if (existing.isReadonly) {
    res.status(403).json({ error: "Environment connection cannot be deleted." });
    return;
  }

  store.connections = store.connections.filter(
    (connection) => connection.id !== req.params.id
  );

  if (store.selectedConnectionId === req.params.id) {
    store.selectedConnectionId = store.connections[0]?.id || null;
  }

  writeConnectionStore(store);
  await clearPool(req.params.id);

  res.status(204).end();
});

app.post("/api/connections/select/:id", (req, res) => {
  const store = readConnectionStore();
  const existing = store.connections.find(
    (connection) => connection.id === req.params.id
  );

  if (!existing) {
    res.status(404).json({ error: "Connection not found." });
    return;
  }

  store.selectedConnectionId = existing.id;
  writeConnectionStore(store);

  res.json({
    selectedConnectionId: existing.id,
    connection: sanitizeConnection(existing)
  });
});

app.post("/api/connections/test", async (req, res) => {
  const error = validateConnectionInput(req.body || {});
  if (error) {
    res.status(400).json({ error });
    return;
  }

  const probeConnection = {
    id: "probe",
    name: String(req.body.name || "Probe"),
    server: String(req.body.server || "").trim(),
    port: Number(req.body.port || 1433),
    authType: req.body.authType === "windows" ? "windows" : "sql",
    username: String(req.body.username || "").trim(),
    password: String(req.body.password || ""),
    encrypt: Boolean(req.body.encrypt),
    trustServerCertificate: Boolean(req.body.trustServerCertificate),
    connectionString: String(req.body.connectionString || "").trim()
  };

  const sqlClient = getSqlClient(probeConnection);
  const pool = new sqlClient.ConnectionPool(buildSqlConfig(probeConnection));

  try {
    await pool.connect();
    const result = await pool
      .request()
      .query("SELECT @@SERVERNAME AS server_name, DB_NAME() AS database_name");

    res.json({
      ok: true,
      serverName: result.recordset[0]?.server_name || probeConnection.server,
      databaseName: result.recordset[0]?.database_name || "master"
    });
  } catch (testError) {
    res.status(400).json({
      ok: false,
      error: "Connection test failed."
    });
  } finally {
    await pool.close();
  }
});

app.get("/api/databases", async (req, res) => {
  const { store, selectedConnection } = getSelectedConnection();
  const requestedId = String(req.query.connectionId || store.selectedConnectionId || "");
  const connection = store.connections.find((item) => item.id === requestedId) || selectedConnection;

  if (!connection) {
    res.status(400).json({
      error: "No SQL Server connection selected.",
      detail: "Select a connection before requesting databases."
    });
    return;
  }

  try {
    const databases = await listDatabases(connection);
    res.json({
      connectionId: connection.id,
      databases
    });
  } catch (error) {
    await clearPool(connection.id);
    res.status(500).json({
      error: "Failed to load databases",
      detail: "Database list could not be loaded."
    });
  }
});

app.get("/api/query-text/:sqlId", async (req, res) => {
  const { selectedConnection } = getSelectedConnection();

  if (!selectedConnection) {
    res.status(400).json({
      error: "No SQL Server connection selected."
    });
    return;
  }

  const sqlId = String(req.params.sqlId || "").trim();
  if (!/^[0-9A-Fa-f]+$/.test(sqlId)) {
    res.status(400).json({
      error: "Invalid SQL ID."
    });
    return;
  }

  try {
    const text = await getQueryTextBySqlId(selectedConnection, sqlId);
    if (!text) {
      res.status(404).json({
        error: "Query text not found in plan cache."
      });
      return;
    }

    res.json({
      sqlId,
      text
    });
  } catch (_error) {
    await clearPool(selectedConnection.id);
    res.status(500).json({
      error: "Query text could not be loaded."
    });
  }
});

app.get("/api/waits", async (_req, res) => {
  const { selectedConnection } = getSelectedConnection();

  if (!selectedConnection) {
    res.status(400).json({
      error: "No SQL Server connection selected.",
      detail: "Create or select a connection from the Connections screen."
    });
    return;
  }

  try {
    const pool = await getPoolForConnection(selectedConnection);
    const request = pool.request();
    const sqlClient = getSqlClient(selectedConnection);
    const selectedDatabase = String(_req.query.database || "").trim() || null;

    excludedWaits.forEach((wait, index) => {
      request.input(`wait${index}`, sqlClient.NVarChar, wait);
    });
    request.input("selectedDatabase", sqlClient.NVarChar, selectedDatabase);

    const result = await request.batch(waitQuery);
    const payload = buildWaitPayload(result, selectedConnection, selectedDatabase);
    res.json(payload);
  } catch (error) {
    await clearPool(selectedConnection.id);
    res.status(500).json({
      error: "Failed to load wait statistics",
      connection: sanitizeConnection(selectedConnection)
    });
  }
});

ensureStorage();

app.listen(port, host, () => {
  console.log(`Dashboard available at http://${host}:${port}`);
});
