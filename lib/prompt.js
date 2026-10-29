import { MARKER } from "./constants.js";
import { formatRoute } from "./extract.js";

export const REVIEW_CRITERIA = [
  "现场对得上：任务根、关键路径、包名、入口在当前工作区真实存在；必须打开相关源码，不得只凭契约正文判合格",
  "调用链清楚：从触发到落地（谁调用、写哪些文件、桌面如何加载）已按仓库核对，没有把插件目录当会话 cwd、没有漏掉必踩约束",
  "事实分层：已验证事实、已接受决策、假设、待核验分开；失败过的路径写进事实；不把建议升级成任务或验收",
  "范围闭合：一个用户可见结果；包含/排除/保护落到具体路径或行为；用户禁止项与停止点仍在；没有扩权或拆错边界",
  "任务可验收：原子任务有结果和独有验收，不是实现步骤；依赖真实；运行态写明如何证明已生效；完成即停",
  "与本机规则不冲突：服从 AGENTS.md 与点名的 skill；不编造环境字段；不复述默认 Git/清理流程；否定约束没被压缩丢掉",
  "可执行且够短：执行会话不必再猜会改变路径的未知值；重复和分析过程已删；优化只压缩与纠错，不追加新范围",
];

export const REVIEW_CONSTRAINTS = [
  "只读审核，不是写作端",
  "禁止 edit / write / multi_edit / bash / str_replace_editor，禁止改配置、提交、写文件",
  "审核子代理切到 read-only 沙箱，写文件会被拒绝",
  "只用 read、grep、glob、read_image 打开当前会话工作区源码",
  "必须实际阅读项目源码与调用链，不得只凭契约正文判合格",
  "pathsRead 为空不得判通过；以实际工具调用为准",
];

export const REVIEW_RULES = {
  criteria: REVIEW_CRITERIA,
  constraints: REVIEW_CONSTRAINTS,
};

const READONLY_BAN = [
  "你是只读审核子代理，不是写作端。",
  "禁止调用 edit、write、multi_edit、bash、str_replace_editor，禁止改配置、禁止提交、禁止写入任何文件。",
  "子代理已切到 read-only 沙箱：写文件会被拒绝，不要改去用 bash 绕过。",
  "只使用只读工具（read、grep、glob、read_image）打开当前会话工作区里的相关源码。",
  "不得只凭契约正文判合格；必须实际阅读项目源码与调用链后再给结论。",
  "禁止再发起审核、禁止 spawn/fork/写作子代理、禁止 prepareCall。",
].join("\n");

const CRITERIA = ["审核标准：", ...REVIEW_CRITERIA.map((item, index) => `${index + 1}. ${item}；`)].join("\n");

export function buildReviewPrompt({
  contract,
  provider,
  cwd,
  userText,
  tools,
  reviewer,
}) {
  const spawnExtra = provider === "spawn"
    ? [
      "",
      "本次用 spawn 启动，不继承父对话历史，避免父模型的 request/header 覆盖次模型。下列上下文不是契约正文的替代：",
      `任务根（会话工作区）：${cwd || "(未知)"}`,
      "用户原话：",
      userText?.trim() ? userText.trim() : "(无)",
      "本轮工具摘要：",
      tools || "(无)",
    ].join("\n")
    : "";
  return [
    READONLY_BAN,
    "",
    `你的模型路由是 ${formatRoute(reviewer) || "(未知)"}。工作目录必须是当前会话工作区，不是插件目录。`,
    CRITERIA,
    "任一条不满足即不得 passed: true。优化只压缩重复、纠错、补遗漏，不等于加需求或扩大验证。",
    "issues.summary 必须能让写作端改这一版契约；suggestions 写改哪里。",
    "",
    "下面是这一版契约全文。fork 若继承了已完成回合，也不得把继承历史当作这份初稿的唯一来源；必须以本段契约为准。",
    "",
    "----- BEGIN CONTRACT -----",
    contract,
    "----- END CONTRACT -----",
    spawnExtra,
    "",
    `审核完成后必须调用 structured_output，字段为 passed、issues、suggestions、pathsRead。`,
    "pathsRead 必须填入你实际读过的工作区路径；若为空，视为未调查，不得判通过。",
    `不要在回复里复述 ${MARKER} 到父对话。`,
  ].join("\n");
}
