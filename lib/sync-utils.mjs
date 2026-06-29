export function extractJiraKey(value) {
  if (!value) return "";
  if (typeof value === "string") {
    return value.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] || "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const key = extractJiraKey(item);
      if (key) return key;
    }
    return "";
  }
  if (typeof value === "object") {
    return extractJiraKey(value.text || value.link || value.url || value.value || JSON.stringify(value));
  }
  return "";
}

export function jiraBrowseUrl(jiraBaseUrl, jiraKey) {
  const base = String(jiraBaseUrl || "").replace(/\/$/, "");
  return `${base}/browse/${jiraKey}`;
}

export function jiraLinkCell(jiraKey, jiraBaseUrl) {
  return {
    text: jiraKey,
    link: jiraBrowseUrl(jiraBaseUrl, jiraKey),
  };
}

export function jiraMarkdownLink(jiraKey, jiraBaseUrl) {
  return `[${jiraKey}](${jiraBrowseUrl(jiraBaseUrl, jiraKey)})`;
}

export function sprintRank(value) {
  const text = String(value || "");
  const match = text.match(/Sprint\s+(\d+)D/i);
  return match ? Number(match[1]) : -1;
}

export function latestSprintName(sprints) {
  const names = [];
  for (const sprint of Array.isArray(sprints) ? sprints : [sprints]) {
    if (!sprint) continue;
    if (typeof sprint === "string") {
      names.push(sprint.match(/name=([^,\]]+)/)?.[1] || sprint);
    }
  }
  const dNames = names.filter((name) => /^Sprint [0-9]+D /.test(name));
  return (dNames.length > 0 ? dNames : names).sort((a, b) => sprintRank(a) - sprintRank(b)).at(-1) || "";
}

export function parseJiraDate(value) {
  if (!value) return "";
  return String(value)
    .replace("T", " ")
    .replace(/\.[0-9]{3}[+-][0-9]{4}$/, "")
    .replace(/^([0-9]{4}-[0-9]{2}-[0-9]{2})$/, "$1 00:00:00");
}

export function delayStatusValue(originalAcceptanceTime, latestAcceptanceTime) {
  if (!originalAcceptanceTime || !latestAcceptanceTime) return "无提交验收时间";
  return latestAcceptanceTime > originalAcceptanceTime ? "已延期" : "未延期";
}
