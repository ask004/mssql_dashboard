const palette = {
  CPU: "#ff7a59",
  "I/O": "#53c7d8",
  Memory: "#e9c46a",
  Other: "#7487ff"
};

const waitTypeNotes = {
  CXPACKET: {
    en: "Parallel worker coordination wait. Often reviewed together with CXCONSUMER, MAXDOP, cost threshold, and skewed parallel plans."
  },
  CXCONSUMER: {
    en: "Parallel consumer wait. Common in healthy parallel plans, but still useful when paired with high CXPACKET or CPU pressure."
  },
  SOS_SCHEDULER_YIELD: {
    en: "CPU-bound work yielded the scheduler. Sustained high values usually indicate CPU pressure or expensive query plans."
  },
  PAGEIOLATCH_SH: {
    en: "A read had to wait for a data page from storage. High values usually point to read I/O latency or poor buffer cache hit ratio."
  },
  PAGEIOLATCH_EX: {
    en: "Exclusive page I/O wait. Can indicate storage latency on write-heavy or page-modifying activity."
  },
  WRITELOG: {
    en: "Transaction log flush wait. Persistent dominance suggests log disk latency, excessive commit frequency, or heavy write workload."
  },
  ASYNC_NETWORK_IO: {
    en: "SQL Server is waiting for the client to consume result rows. Often application-side row fetching is slow."
  },
  RESOURCE_SEMAPHORE: {
    en: "Query memory grant wait. Usually caused by large sorts, hashes, spills, or insufficient memory for concurrent grants."
  },
  LCK_M_X: {
    en: "Exclusive lock wait. Indicates blocking from concurrent writers or long transactions."
  },
  LCK_M_S: {
    en: "Shared lock wait. Usually readers waiting behind writers or lock escalation and blocking chains."
  },
  THREADPOOL: {
    en: "Worker thread starvation. High severity signal that requests are waiting for available workers."
  },
  HADR_SYNC_COMMIT: {
    en: "Synchronous AG commit wait. Commit latency is impacted by secondary replica acknowledgment."
  },
  IO_COMPLETION: {
    en: "General I/O completion wait. Investigate storage subsystem latency and file activity patterns."
  },
  PAGEIOLATCH_UP: {
    en: "Update latch while waiting on a data page read from storage. Usually points to data file I/O latency."
  },
  PAGELATCH_EX: {
    en: "In-memory page latch wait, not storage I/O. Common causes include allocation bitmap contention or hot pages in tempdb."
  },
  PAGELATCH_UP: {
    en: "In-memory update latch wait. Often investigated for tempdb contention or allocation hotspots."
  },
  LOGBUFFER: {
    en: "Waiting for log buffer access. Can appear with intense logging activity or log throughput pressure."
  },
  LCK_M_U: {
    en: "Update lock wait. Usually indicates blocking between concurrent sessions trying to modify related rows."
  },
  LCK_M_IX: {
    en: "Intent exclusive lock wait. Often part of broader blocking chains on write activity."
  },
  PREEMPTIVE_OS_AUTHENTICATIONOPS: {
    en: "SQL Server is waiting on Windows authentication-related work outside the scheduler. Often appears with login or AD lookup latency."
  },
  BACKUPIO: {
    en: "Backup or restore I/O wait. Indicates throughput or latency pressure on backup storage paths."
  },
  HADR_DATABASE_FLOW_CONTROL: {
    en: "Availability Group flow control wait. Can indicate send or redo backpressure on replicas."
  },
  ASYNC_IO_COMPLETION: {
    en: "Asynchronous I/O completion wait. Review subsystem latency and file access behavior."
  }
};

const state = {
  selectedConnectionId: null,
  selectedDatabase: "",
  refreshIntervalMs: 30000,
  connections: [],
  databases: [],
  dashboardTimer: null,
  windowsIdentity: "Current Windows session"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDuration(ms) {
  if ((Number(ms) || 0) < 1000) {
    return `${Math.round(Number(ms) || 0)} ms`;
  }

  const totalSeconds = Math.floor((Number(ms) || 0) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatBytesPerSecond(value) {
  const bytes = Number(value) || 0;
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB/s`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB/s`;
  }
  return `${bytes} B/s`;
}

function formatMegabytes(value) {
  const mb = Number(value);
  if (!Number.isFinite(mb)) {
    return "-";
  }
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(0)} MB`;
}

function getWaitTypeUrl(waitType) {
  const slug = String(waitType || "").trim().toLowerCase();
  return `https://www.sqlskills.com/help/waits/${encodeURIComponent(slug)}/`;
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(new Date(value));
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function tagCategory(category) {
  const cssName = category === "I/O" ? "IO" : category;
  return `<span class="tag ${cssName}">${escapeHtml(category)}</span>`;
}

function getSelectedConnection() {
  return state.connections.find(
    (connection) => connection.id === state.selectedConnectionId
  );
}

function updateAuthFields() {
  const authType = document.getElementById("authType").value;
  const username = document.getElementById("username");
  const password = document.getElementById("password");
  const hint = document.getElementById("authHint");
  const isWindows = authType === "windows";

  username.disabled = isWindows;
  password.disabled = isWindows;

  if (isWindows) {
    username.value = "";
    password.value = "";
    hint.textContent = `Uses the current Windows login: ${state.windowsIdentity}`;
    return;
  }

  hint.textContent =
    "SQL authentication is selected. Username and password will be sent to SQL Server.";
}

function showView(viewId) {
  document.querySelectorAll(".view").forEach((element) => {
    element.classList.toggle("active", element.id === viewId);
  });

  document.querySelectorAll(".nav-chip").forEach((element) => {
    element.classList.toggle("active", element.dataset.view === viewId);
  });
}

function setNotice(message = "", isError = true) {
  const notice = document.getElementById("dashboardNotice");
  if (!message) {
    notice.classList.add("hidden");
    notice.textContent = "";
    return;
  }

  notice.classList.remove("hidden");
  notice.style.borderColor = isError
    ? "rgba(255, 93, 115, 0.35)"
    : "rgba(88, 214, 141, 0.35)";
  notice.style.background = isError
    ? "rgba(255, 93, 115, 0.08)"
    : "rgba(88, 214, 141, 0.1)";
  notice.textContent = message;
}

function renderDistribution(categories) {
  const entries = Object.entries(categories);
  const total = entries.reduce((sum, [, value]) => sum + Number(value || 0), 0);

  let currentDeg = 0;
  const gradient = entries
    .map(([label, value]) => {
      const pct = total ? (Number(value || 0) / total) * 100 : 0;
      const nextDeg = currentDeg + pct * 3.6;
      const color = palette[label];
      const segment = `${color} ${currentDeg}deg ${nextDeg}deg`;
      currentDeg = nextDeg;
      return segment;
    })
    .join(", ");

  document.getElementById("categoryDonut").style.background = `conic-gradient(${gradient || `${palette.Other} 0 360deg`})`;

  document.getElementById("categoryLegend").innerHTML = entries
    .map(([label, value]) => {
      const pct = total ? ((Number(value || 0) / total) * 100).toFixed(1) : "0.0";
      return `
        <div class="legend-item">
          <div><span class="swatch" style="background:${palette[label]}"></span>${escapeHtml(label)}</div>
          <div>
            <strong>${formatDuration(value)}</strong>
            <span>${pct}%</span>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderTopWaits(topWaits) {
  const body = document.getElementById("topWaitsBody");

  if (!topWaits.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">No wait data returned.</td></tr>`;
    return;
  }

  body.innerHTML = topWaits
    .map(
      (wait) => `
        <tr class="${Number(wait.wait_pct) >= 20 ? "row-hot" : ""}">
          <td>
            <button class="link-button" data-action="open-wait-type" data-wait-type="${escapeHtml(
                wait.wait_type
            )}">
              ${escapeHtml(wait.wait_type)}
            </button>
          </td>
          <td>${tagCategory(wait.category)}</td>
          <td class="align-right nowrap">${formatDuration(wait.wait_time_ms)}</td>
          <td class="align-right nowrap">${formatDuration(wait.avg_wait_time_ms)}</td>
          <td class="align-right">${formatNumber(wait.waiting_tasks_count)}</td>
          <td class="align-right">${wait.wait_pct}%</td>
        </tr>
      `
    )
    .join("");
}

function renderActiveWaits(activeWaits) {
  const body = document.getElementById("activeWaitsBody");

  if (!activeWaits.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">No active waits at refresh time.</td></tr>`;
    return;
  }

  body.innerHTML = activeWaits
    .slice(0, 12)
    .map(
      (wait) => `
        <tr class="${Number(wait.blocking_session_id) > 0 ? "row-blocked" : ""}">
          <td>${wait.session_id}</td>
          <td>
            <button class="link-button" data-action="open-wait-type" data-wait-type="${escapeHtml(
              wait.wait_type
            )}">
              ${escapeHtml(wait.wait_type)}
            </button>
          </td>
          <td>${tagCategory(wait.category)}</td>
          <td>${formatDuration(wait.wait_time)}</td>
          <td>${formatDuration(wait.cpu_time)}</td>
          <td>${wait.blocking_session_id || "-"}</td>
          <td class="sql-text">${escapeHtml((wait.current_statement || "").trim() || "-")}</td>
        </tr>
      `
    )
    .join("");
}

function renderRecommendations(recommendations) {
  document.getElementById("recommendationList").innerHTML = recommendations
    .map(
      (item) => `
        <article class="recommendation ${item.severity}">
          <span>${item.severity} priority</span>
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.detail)}</p>
        </article>
      `
    )
    .join("");
}

function renderLongRunningQueries(queries) {
  const body = document.getElementById("longRunningBody");

  if (!queries.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">No query stats returned for this scope.</td></tr>`;
    return;
  }

  body.innerHTML = queries
    .map(
      (query) => `
        <tr>
          <td>${escapeHtml(query.database_name || "-")}</td>
          <td class="nowrap">${formatDate(query.last_execution_time)}</td>
          <td class="align-right">${formatNumber(query.execution_count)}</td>
          <td class="align-right">${formatDuration(query.duration_time_avg_ms)}</td>
          <td class="align-right">${formatDuration(query.cpu_time_avg_ms)}</td>
          <td class="align-right">${formatNumber(Math.round(Number(query.logical_reads_avg) || 0))}</td>
          <td class="align-right">${formatNumber(Math.round(Number(query.logical_writes_avg) || 0))}</td>
          <td class="sql-text">
            <button class="link-button sql-text-button" data-action="open-query-text" data-sql-id="${escapeHtml(
              query.sql_id || ""
            )}">
              ${escapeHtml((query.statement_preview || "").trim() || "-")}
            </button>
          </td>
        </tr>
      `
    )
    .join("");
}

async function openQueryModal(sqlId) {
  const modal = document.getElementById("queryModal");
  setText("queryModalTitle", "SQL Text");
  setText("queryModalBody", "Loading query text...");
  modal.showModal();

  try {
    const data = await requestJson(`/api/query-text/${encodeURIComponent(sqlId)}`);
    setText("queryModalBody", data.text || "Query text not found.");
  } catch (error) {
    setText("queryModalBody", error.message);
  }
}

function openWaitModal(waitType) {
  const modal = document.getElementById("waitModal");
  const title = String(waitType || "").trim() || "Wait Detail";
  const note = waitTypeNotes[title];
  const link = getWaitTypeUrl(title);
  const body = note
    ? `${escapeHtml(note.en)}<br><br><a href="${link}" target="_blank" rel="noreferrer">${link}</a>`
    : `<a href="${link}" target="_blank" rel="noreferrer">${link}</a>`;

  setText("waitModalTitle", title);
  document.getElementById("waitModalBody").innerHTML = body;
  modal.showModal();
}

function renderBlockingSessions(rows) {
  const body = document.getElementById("blockingBody");

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">No blocking sessions detected.</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .map(
      (row) => `
        <tr class="row-blocked">
          <td>${row.blocked_session_id}</td>
          <td>${row.blocking_session_id}</td>
          <td>${escapeHtml(row.database_name || "-")}</td>
          <td>${escapeHtml(row.wait_type || "-")}</td>
          <td>${formatDuration(row.wait_time)}</td>
          <td>${escapeHtml(row.blocked_status || "-")}</td>
          <td>${escapeHtml(row.blocker_status || "-")}</td>
        </tr>
      `
    )
    .join("");
}

function renderInfraMetrics(serverUtilization, databaseSize) {
  setText(
    "sqlCpuPct",
    serverUtilization?.sql_cpu_pct != null ? `${serverUtilization.sql_cpu_pct}%` : "-"
  );
  setText(
    "memoryUtilPct",
    serverUtilization?.memory_utilization_pct != null
      ? `${serverUtilization.memory_utilization_pct}%`
      : "-"
  );
  setText(
    "networkSent",
    serverUtilization ? formatBytesPerSecond(serverUtilization.bytes_sent_per_sec) : "-"
  );
  setText(
    "databaseSize",
    databaseSize ? formatMegabytes(databaseSize.total_size_mb) : "Select DB"
  );
}

function clearDashboard() {
  setText("generatedAt", "-");
  setText("startTime", "-");
  setText("totalWait", "-");
  setText("totalTasks", "-");
  setText("signalPct", "-");
  setText("signalWaitTime", "-");
  setText("resourceWaitTime", "-");
  setText("cpuPressure", "Normal");
  document.getElementById("cpuPressureCard").classList.remove("alert");
  document.getElementById("signalBar").style.width = "0%";
  document.getElementById("resourceBar").style.width = "0%";
  renderDistribution({ CPU: 0, "I/O": 0, Memory: 0, Other: 0 });
  renderTopWaits([]);
  renderActiveWaits([]);
  renderLongRunningQueries([]);
  renderBlockingSessions([]);
  renderRecommendations([]);
  renderInfraMetrics(null, null);
  renderScopeHint();
}

function renderConnectionHeader() {
  const selected = getSelectedConnection();

  if (!selected) {
    setText("activeConnectionName", "No connection selected");
    setText("activeConnectionMeta", "Create or select a SQL Server connection.");
    return;
  }

  const authLabel =
    selected.authType === "windows"
      ? selected.effectiveIdentity || "Windows auth"
      : selected.username || "SQL auth";

  const dbLabel = state.selectedDatabase || "Server-wide view";
  setText("activeConnectionName", selected.name);
  setText(
    "activeConnectionMeta",
    `${selected.server}:${selected.port} | ${dbLabel} | ${authLabel}`
  );
}

function renderScopeHint() {
  const scopeHint = document.getElementById("scopeHint");
  if (!state.selectedDatabase) {
    scopeHint.textContent =
      "Server-wide cumulative waits. Active waits reflect the selected database scope.";
    return;
  }

  scopeHint.textContent = `Database scope: ${state.selectedDatabase}. Cumulative waits stay server-wide because sys.dm_os_wait_stats is instance-level; active waits are filtered to the selected database.`;
}

function renderDatabaseSelector() {
  const selector = document.getElementById("databaseSelector");
  const options = ['<option value=""></option>']
    .concat(
      state.databases.map(
        (name) =>
          `<option value="${escapeHtml(name)}" ${
            state.selectedDatabase === name ? "selected" : ""
          }>${escapeHtml(name)}</option>`
      )
    )
    .join("");

  selector.innerHTML = options;
  selector.disabled = !state.selectedConnectionId;
  renderConnectionHeader();
  renderScopeHint();
}

function renderConnections() {
  renderConnectionHeader();
  const list = document.getElementById("connectionList");

  if (!state.connections.length) {
    list.innerHTML = `<div class="empty">No connections saved yet.</div>`;
    return;
  }

  list.innerHTML = state.connections
    .map((connection) => {
      const selected = connection.id === state.selectedConnectionId;
      const windowsPill =
        connection.authType === "windows" && connection.effectiveIdentity
          ? `<span class="pill">${escapeHtml(connection.effectiveIdentity)}</span>`
          : "";

      return `
        <article class="connection-card ${selected ? "active" : ""} ${
          connection.isReadonly ? "readonly" : ""
        }">
          <div class="connection-card-info">
            <small>${selected ? "Active target" : "Saved target"}</small>
            <strong>${escapeHtml(connection.name)}</strong>
            <p class="strip-meta">${escapeHtml(connection.server)}:${connection.port}</p>
            <div class="inline-pills">
              <span class="pill info">${
                connection.authType === "windows" ? "Windows auth" : "SQL auth"
              }</span>
              ${windowsPill}
              ${connection.encrypt ? '<span class="pill success">Encrypted</span>' : ""}
              ${connection.source === "env" ? '<span class="pill">Environment</span>' : ""}
            </div>
          </div>
          <div class="connection-card-actions">
            <button class="mini-button" data-action="select" data-id="${connection.id}">
              ${selected ? "Selected" : "Use"}
            </button>
            <button class="mini-button" data-action="edit" data-id="${connection.id}" ${
              connection.isReadonly ? "disabled" : ""
            }>
              Edit
            </button>
            <button class="mini-button danger" data-action="delete" data-id="${connection.id}" ${
              connection.isReadonly ? "disabled" : ""
            }>
              Delete
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}

function getFormData() {
  const form = document.getElementById("connectionForm");
  const data = new FormData(form);
  const authType = data.get("authType") === "windows" ? "windows" : "sql";

  return {
    name: String(data.get("name") || "").trim(),
    server: String(data.get("server") || "").trim(),
    port: Number(data.get("port") || 1433),
    authType,
    username: authType === "windows" ? "" : String(data.get("username") || "").trim(),
    password: authType === "windows" ? "" : String(data.get("password") || ""),
    connectionString: String(data.get("connectionString") || "").trim(),
    encrypt: document.getElementById("encrypt").checked,
    trustServerCertificate: document.getElementById("trustServerCertificate").checked
  };
}

function resetForm() {
  document.getElementById("connectionForm").reset();
  document.getElementById("port").value = 1433;
  document.getElementById("trustServerCertificate").checked = true;
  document.getElementById("connectionId").value = "";
  document.getElementById("formTitle").textContent = "New Connection";
  setTestResult(
    "Not tested",
    "Run a connection test before saving if you want to verify access."
  );
  updateAuthFields();
}

function fillForm(connection) {
  document.getElementById("connectionId").value = connection.id;
  document.getElementById("name").value = connection.name || "";
  document.getElementById("server").value = connection.server || "";
  document.getElementById("port").value = connection.port || 1433;
  document.getElementById("authType").value = connection.authType || "sql";
  document.getElementById("username").value = connection.username || "";
  document.getElementById("password").value = "";
  document.getElementById("connectionString").value = connection.connectionString || "";
  document.getElementById("encrypt").checked = Boolean(connection.encrypt);
  document.getElementById("trustServerCertificate").checked = Boolean(
    connection.trustServerCertificate
  );
  document.getElementById("formTitle").textContent = `Edit: ${connection.name}`;
  setTestResult("Not tested", "Connection definition loaded into the form.");
  updateAuthFields();
}

function setTestResult(status, detail, mode = "") {
  const panel = document.getElementById("testResult");
  panel.classList.remove("success", "error");
  if (mode) {
    panel.classList.add(mode);
  }
  setText("testStatus", status);
  setText("testDetail", detail);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  let data = {};
  try {
    data = await response.json();
  } catch (_error) {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data.detail || data.error || "Request failed");
  }

  return data;
}

async function loadConnections() {
  const data = await requestJson("/api/connections");
  state.windowsIdentity = data.windowsIdentity || "Current Windows session";
  state.connections = data.connections || [];
  state.selectedConnectionId = data.selectedConnectionId || null;
  renderConnections();
  updateAuthFields();
}

async function loadDatabases() {
  if (!state.selectedConnectionId) {
    state.databases = [];
    state.selectedDatabase = "";
    renderDatabaseSelector();
    return;
  }

  const data = await requestJson(
    `/api/databases?connectionId=${encodeURIComponent(state.selectedConnectionId)}`
  );
  state.databases = data.databases || [];
  if (state.selectedDatabase && !state.databases.includes(state.selectedDatabase)) {
    state.selectedDatabase = "";
  }
  renderDatabaseSelector();
}

async function selectConnection(id) {
  await requestJson(`/api/connections/select/${id}`, { method: "POST" });
  state.selectedConnectionId = id;
  state.selectedDatabase = "";
  await loadConnections();
  await loadDatabases();
  setNotice("");
  await loadDashboard();
}

async function saveConnection(event) {
  event.preventDefault();

  const payload = getFormData();
  const id = document.getElementById("connectionId").value;
  const method = id ? "PUT" : "POST";
  const url = id ? `/api/connections/${id}` : "/api/connections";

  await requestJson(url, {
    method,
    body: JSON.stringify(payload)
  });

  await loadConnections();
  if (!id) {
    state.selectedDatabase = "";
  }
  await loadDatabases();
  resetForm();
}

async function deleteConnection(id) {
  await requestJson(`/api/connections/${id}`, { method: "DELETE" });
  await loadConnections();
  await loadDatabases();
  await loadDashboard();
}

async function testConnection() {
  try {
    setTestResult("Testing...", "Connection validation is in progress.");
    const payload = getFormData();
    const data = await requestJson("/api/connections/test", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    setTestResult("Connected", `${data.serverName} | ${data.databaseName}`, "success");
  } catch (error) {
    setTestResult("Connection failed", error.message, "error");
  }
}

async function loadDashboard() {
  try {
    const query = state.selectedDatabase
      ? `?database=${encodeURIComponent(state.selectedDatabase)}`
      : "";
    const data = await requestJson(`/api/waits${query}`);
    setNotice("");
    setText("generatedAt", formatDate(data.generatedAt));
    setText("startTime", formatDate(data.sqlserverStartTime));
    setText("totalWait", formatDuration(data.totals.cumulativeWaitMs));
    setText("totalTasks", formatNumber(data.totals.cumulativeWaitingTasks));
    setText("signalPct", `${data.totals.signalWaitPct}%`);
    setText("signalWaitTime", formatDuration(data.totals.cumulativeSignalWaitMs));
    setText("resourceWaitTime", formatDuration(data.totals.cumulativeResourceWaitMs));
    setText("cpuPressure", data.cpuPressure ? "High" : "Normal");

    document.getElementById("cpuPressureCard").classList.toggle("alert", data.cpuPressure);
    document.getElementById("signalBar").style.width = `${Math.min(data.totals.signalWaitPct, 100)}%`;
    document.getElementById("resourceBar").style.width = `${Math.max(100 - data.totals.signalWaitPct, 0)}%`;

    renderDistribution(data.categories);
    renderTopWaits(data.topWaits);
    renderActiveWaits(data.activeWaits);
    renderLongRunningQueries(data.longRunningQueries || []);
    renderBlockingSessions(data.blockingSessions || []);
    renderInfraMetrics(data.serverUtilization, data.databaseSize);
    renderRecommendations(data.recommendations);
    renderConnectionHeader();
    renderScopeHint();
  } catch (error) {
    clearDashboard();
    renderConnectionHeader();
    renderScopeHint();
    setNotice(error.message);
  }
}

function startAutoRefresh() {
  if (state.dashboardTimer) {
    clearInterval(state.dashboardTimer);
    state.dashboardTimer = null;
  }

  if (!state.refreshIntervalMs) {
    return;
  }

  state.dashboardTimer = setInterval(() => {
    loadDashboard();
  }, state.refreshIntervalMs);
}

function bindEvents() {
  document.querySelectorAll(".nav-chip").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });

  document
    .getElementById("openConnectionsButton")
    .addEventListener("click", () => showView("connectionsView"));

  document
    .getElementById("refreshDashboardButton")
    .addEventListener("click", () => loadDashboard());

  document
    .getElementById("refreshIntervalSelector")
    .addEventListener("change", (event) => {
      state.refreshIntervalMs = Number(event.target.value || 0);
      startAutoRefresh();
    });

  document
    .getElementById("databaseSelector")
    .addEventListener("change", async (event) => {
      state.selectedDatabase = event.target.value;
      renderConnectionHeader();
      renderScopeHint();
      await loadDashboard();
    });

  document
    .getElementById("connectionForm")
    .addEventListener("submit", saveConnection);

  document
    .getElementById("resetFormButton")
    .addEventListener("click", resetForm);

  document
    .getElementById("testConnectionButton")
    .addEventListener("click", testConnection);

  document
    .getElementById("authType")
    .addEventListener("change", updateAuthFields);

  document
    .getElementById("closeQueryModalButton")
    .addEventListener("click", () => document.getElementById("queryModal").close());

  document
    .getElementById("closeWaitModalButton")
    .addEventListener("click", () => document.getElementById("waitModal").close());

  document.getElementById("longRunningBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='open-query-text']");
    if (!button) {
      return;
    }

    await openQueryModal(button.dataset.sqlId);
  });

  document.getElementById("topWaitsBody").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='open-wait-type']");
    if (!button) {
      return;
    }

    openWaitModal(button.dataset.waitType);
  });

  document.getElementById("activeWaitsBody").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='open-wait-type']");
    if (!button) {
      return;
    }

    openWaitModal(button.dataset.waitType);
  });

  document.getElementById("connectionList").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const { action, id } = button.dataset;
    const connection = state.connections.find((item) => item.id === id);
    if (!connection) {
      return;
    }

    if (action === "select") {
      await selectConnection(id);
      return;
    }

    if (action === "edit" && !connection.isReadonly) {
      fillForm(connection);
      showView("connectionsView");
      return;
    }

    if (action === "delete" && !connection.isReadonly) {
      const confirmed = window.confirm(`Delete connection "${connection.name}"?`);
      if (confirmed) {
        await deleteConnection(id);
      }
    }
  });
}

async function init() {
  bindEvents();
  document.getElementById("refreshIntervalSelector").value = String(
    state.refreshIntervalMs
  );
  resetForm();
  clearDashboard();

  try {
    await loadConnections();
    await loadDatabases();
  } catch (error) {
    setNotice(error.message);
  }

  await loadDashboard();
  startAutoRefresh();
}

init();
