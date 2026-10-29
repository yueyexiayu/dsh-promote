import { formatReviewer, shortHash } from "./extract.js";

function routeLabel(route) {
  return formatReviewer(route) || "(未知次模型)";
}

function issueLines(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return ["（无结构化问题列表）"];
  return issues.map((issue, index) => {
    const summary = issue?.summary || "未命名问题";
    const detail = issue?.detail ? ` — ${issue.detail}` : "";
    const severity = issue?.severity ? `[${issue.severity}] ` : "";
    return `${index + 1}. ${severity}${summary}${detail}`;
  });
}

export function statusReviewing({ reviewer, round, maxRevisions, hash, provider }) {
  return [
    `[promote 审核中] 次模型 ${routeLabel(reviewer)} · 第 ${round}/${maxRevisions} 轮 · 版本 ${shortHash(hash)}`,
    provider ? `启动方式：${provider}` : "",
    "初稿尚未合格。未看到 [promote 终稿] 或 [promote 未通过] 前，不得把这一版称为已合格终稿。",
  ].filter(Boolean).join("\n");
}

export function statusFailed({ reason, reviewer, hash, round, maxRevisions, disableAuto, retryable }) {
  const lines = [
    `[promote 审核失败] ${reason}`,
  ];
  if (reviewer) lines.push(`次模型：${routeLabel(reviewer)}`);
  if (hash) lines.push(`版本 ${shortHash(hash)} · 第 ${round ?? "?"}/${maxRevisions ?? "?"} 轮`);
  if (disableAuto) lines.push("自动审核已禁用，直到次模型 A/B 配齐且与当前会话主模型不同。");
  if (retryable) lines.push("可再次调用 promote 重试本次审核。");
  lines.push("未看到 [promote 终稿] 或 [promote 未通过] 前，不得把初稿称为已合格终稿。");
  return lines.join("\n");
}

export function statusPassed({ reviewer, round, maxRevisions, hash, pathsRead }) {
  const paths = Array.isArray(pathsRead) && pathsRead.length ? pathsRead.join(", ") : "(未列出)";
  return [
    `[promote 终稿] 次模型 ${routeLabel(reviewer)} · 第 ${round}/${maxRevisions} 轮 · 版本 ${shortHash(hash)} · 已通过`,
    `已读路径：${paths}`,
  ].join("\n");
}

export function statusExhausted({ reviewer, round, maxRevisions, hash, issues }) {
  return [
    `[promote 未通过] 次模型 ${routeLabel(reviewer)} · 已用尽 ${round}/${maxRevisions} 轮 · 版本 ${shortHash(hash)}`,
    "保留最后一版，下列问题仍未通过：",
    ...issueLines(issues),
    "未看到 [promote 终稿] 前，不得把这一版称为已合格终稿。",
  ].join("\n");
}

export function revisionInstruction({ reviewer, round, maxRevisions, hash, issues, suggestions, pathsRead }) {
  const suggestionLines = Array.isArray(suggestions) && suggestions.length
    ? suggestions.map((item, index) => `${index + 1}. ${item}`)
    : ["（无额外建议）"];
  const paths = Array.isArray(pathsRead) && pathsRead.length ? pathsRead.join("\n- ") : "(审核报告未列出路径)";
  return [
    `[promote 审核意见 · 请改稿] 版本 ${shortHash(hash)} 未通过（第 ${round}/${maxRevisions} 轮，次模型 ${routeLabel(reviewer)}）。`,
    "请根据下列意见修改契约，改完后仍以可见正文中的 [END OF EXECUTION PROMPT] 收束。",
    "未看到 [promote 终稿] 或 [promote 未通过] 前，不得把初稿称为已合格终稿。",
    "",
    "问题：",
    ...issueLines(issues),
    "",
    "建议改哪里：",
    ...suggestionLines,
    "",
    "审核实际读过的路径：",
    `- ${paths}`,
  ].join("\n");
}
