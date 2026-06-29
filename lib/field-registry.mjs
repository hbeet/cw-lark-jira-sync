export const DEFAULT_FIELD_MAPPING = {
  "jira号": "jira号",
  "概要": "概要",
  "迭代": "迭代",
  "状态": "状态",
  "优先级": "优先级",
  "需求方": "需求方",
  "开始时间": "开始时间",
  "提测时间": "提测时间",
  "提交验收时间": "提交验收时间",
  "原提交验收时间": "原提交验收时间",
  "最新提交验收时间": "最新提交验收时间",
  "关闭时间": "关闭时间",
  "延期原因": "延期原因",
  "产品负责人": "产品负责人",
  "项目经理": "项目经理",
  "开发预估工期": "开发预估工期",
  "延期状态": "延期状态",
};

export const CANONICAL_JIRA_FIELD_NAMES = [
  "jira号",
  "Jira号",
  "JIRA号",
  "Jira",
  "jira",
  "JIRA",
  "Jira Key",
  "Jira key",
  "jira key",
];

export function isStatusTimelineField(name) {
  return /^进入.+时间$/.test(name || "");
}

export function buildAutoFieldMapping(fields) {
  const byName = new Map(fields.filter((field) => field?.name && field?.id).map((field) => [field.name, field.id]));
  const mapping = {};
  for (const canonical of Object.keys(DEFAULT_FIELD_MAPPING)) {
    if (byName.has(canonical)) mapping[canonical] = byName.get(canonical);
  }
  for (const field of fields) {
    if (field?.name && isStatusTimelineField(field.name)) {
      mapping[field.name] = field.id;
    }
  }
  return mapping;
}

export function findJiraFieldName(fields) {
  const byName = new Set(fields.filter((field) => field?.name && field?.id).map((field) => field.name));
  return CANONICAL_JIRA_FIELD_NAMES.find((name) => byName.has(name)) || "";
}

export function mappingForEnv(fieldMapping = DEFAULT_FIELD_MAPPING) {
  return {
    LARK_FIELD_MAPPING_JSON: JSON.stringify(fieldMapping),
    LARK_FIELD_MAPPING_STRICT: "1",
  };
}
