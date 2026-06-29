function requireJiraEnv(env) {
  if (!env.JIRA_BASE_URL) throw new Error("Missing required env: JIRA_BASE_URL");
  if (!env.JIRA_TOKEN) throw new Error("Missing required env: JIRA_TOKEN");
}

function jiraApiBase(env) {
  requireJiraEnv(env);
  return `${env.JIRA_BASE_URL.replace(/\/$/, "")}/rest/api/2`;
}

function jiraHeaders(env) {
  return {
    Authorization: `Bearer ${env.JIRA_TOKEN}`,
    Accept: "application/json",
  };
}

export async function jiraSearch(env, jql, options = {}) {
  const apiUrl = new URL(`${jiraApiBase(env)}/search`);
  apiUrl.searchParams.set("jql", jql);
  apiUrl.searchParams.set("startAt", String(options.startAt || 0));
  apiUrl.searchParams.set("maxResults", String(options.maxResults || 100));
  apiUrl.searchParams.set("fields", options.fields || "project,issuetype,customfield_12200,updated");
  const response = await fetch(apiUrl, { headers: jiraHeaders(env) });
  if (!response.ok) {
    throw new Error(`Jira search failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export async function jiraSearchAll(env, jql, options = {}) {
  const pageSize = Number(options.pageSize || 100);
  let startAt = 0;
  const issues = [];
  while (issues.length < Number(options.max || 1000)) {
    const page = await jiraSearch(env, jql, { ...options, startAt, maxResults: pageSize });
    const pageIssues = page.issues || [];
    issues.push(...pageIssues);
    if (pageIssues.length === 0 || startAt + pageIssues.length >= (page.total || 0)) break;
    startAt += pageIssues.length;
  }
  return issues;
}

export async function checkJiraReachable(env, { enabled = true, timeoutMs = 5000 } = {}) {
  const startedAt = new Date();
  if (!enabled) {
    return {
      ok: true,
      skipped: true,
      checked_at: startedAt.toISOString(),
      reason: "reachability check disabled",
    };
  }
  const url = `${jiraApiBase(env)}/myself`;
  try {
    const response = await fetch(url, {
      headers: jiraHeaders(env),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = response.headers.get("content-type")?.includes("json")
      ? await response.json().catch(() => ({}))
      : {};
    return {
      ok: response.ok,
      status: response.status,
      authenticated_user: body.name || body.key || body.displayName || "",
      checked_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      timeout_ms: timeoutMs,
    };
  } catch (error) {
    return {
      ok: false,
      checked_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      timeout_ms: timeoutMs,
      error: error.message,
    };
  }
}
