import { MARKER } from "./constants.js";
import { formatRoute } from "./extract.js";

export const REVIEW_CRITERIA = [
  "现场对得上：核查任务根及相关材料、路径和事实；不得只凭契约正文或模型自报判合格",
  "代码类契约必须打开相关源码，并用 lsp 的 goToDefinition / findReferences / goToImplementation 核对从触发到落地的调用链；禁止以 grep 替代；非源码任务则核查其实际材料，不凭空要求源码调用链",
  "事实分层：已验证事实、已接受决策、假设、待核验分开；失败过的路径写进事实；不把建议升级成任务或验收",
  "范围闭合：一个用户可见结果；包含/排除/保护落到具体路径或行为；用户禁止项与停止点仍在；没有扩权或拆错边界",
  "任务可验收：原子任务有结果和独有验收，不是实现步骤；依赖真实；运行态写明如何证明已生效；完成即停",
  "与本机规则不冲突：服从 AGENTS.md 与点名的 skill；不编造环境字段；不复述默认 Git/清理流程；否定约束没被压缩丢掉",
  "可执行且够短：执行会话不必再猜会改变路径的未知值；重复和分析过程已删；优化只压缩与纠错，不追加新范围",
];

export const REVIEW_CONSTRAINTS = [
  "只读审核，不是写作端",
  "禁止 edit / write / multi_edit / bash / str_replace_editor，禁止改配置、提交、写文件",
  "审核子代理激活前必须已受可验证的只读限制；无法保证时明确失败",
  "使用只读工具核查任务相关材料；代码类任务须用 lsp 追调用链",
  "必须实际核查相关材料；代码类任务必须实际阅读源码与核验调用链",
  "只接受可验证的成功工具结果作为证据；代码类任务未验证相关源码读取和 lsp 定义/引用查询不得通过",
];

export const REVIEW_RULES = {
  criteria: REVIEW_CRITERIA,
  constraints: REVIEW_CONSTRAINTS,
};

const READONLY_BAN = [
  "你是只读审核子代理，不是写作端。",
  "禁止调用 edit、write、multi_edit、bash、str_replace_editor，禁止改配置、禁止提交、禁止写入任何文件。",
  "只有 Host 已在激活前确认只读限制时才可开始审核，不要尝试绕过。",
  "只读工具用于核查相关材料；代码类任务必须阅读源码，并用 lsp 的 goToDefinition / findReferences / goToImplementation 核对调用链。",
  "不得只凭契约正文、模型自报或 grep 命中判合格；代码类任务的关键符号必须用 lsp 核对调用链。",
  "代码类任务中 hover 不能代替 findReferences；缺少可验证的成功读取与 lsp 调用链证据不得 passed: true。",
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
    `审核完成后必须调用 structured_output，字段为 passed、issues、suggestions、pathsRead、reviewChain。`,
    "pathsRead 必须填入实际读过的相关路径；模型自报本身不能作为读取证据。",
    "代码类审核的 reviewChain 按触发到落地顺序列出每个节点的 path、一基 line 和一基 UTF-16 character，坐标须落在对应符号内；每个节点必须实际 read。多跳链的每个中间函数节点必须增加 callSite:{line,character}，指明同一文件函数体内调用下一函数的独立位置；末节点不得带 callSite。每条相邻边须从前一节点（若有 callSite 则从该调用点）的精确坐标查询 goToDefinition 或 goToImplementation 并命中下一节点，Host 必须证明该查询位置是实际调用；引用查询仅作佐证，整条链至少要有关联的 goToDefinition 和 findReferences。调用点属于该中间函数必须有 Host 可信证据，不能凭模型断言。非代码材料审核用空数组。",
    `不要在回复里复述 ${MARKER} 到父对话。`,
  ].join("\n");
}
