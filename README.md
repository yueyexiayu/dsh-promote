<div align="center">
  <img src="docs/assets/hero.svg" width="100%" alt="示意：主对话写出执行契约后，次模型只读审核，再回到主模型改稿。不是产品截图。" />
  <h1>Promote</h1>
  <p><strong>当前对话写执行契约，次模型只读挑错，通过之前不要把初稿当成终稿。</strong></p>
  <p>DeepSeek Harness 桌面插件，外加编译契约的 <code>prompt</code> / promote skill。</p>
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
  <p><a href="LICENSE">MIT</a> · 版本 0.1.10</p>
  <p><a href="#核心能力">核心能力</a> · <a href="#工作方式">工作方式</a> · <a href="#快速开始">快速开始</a> · <a href="#配置">配置</a> · <a href="#验证">验证</a> · <a href="#常见问题">常见问题</a></p>
</div>

---

写作端始终是当前主对话。插件在可见正文出现未引用的 `[END OF EXECUTION PROMPT]` 时标「审核中」，并在 **`turn-stopping` 钩子内等待次模型审完**（不依赖主模型去调 `promote`）。通过才标终稿；不通过或超时再唤醒主模型改稿/重试。仓库里的 `skills/prompt` 只负责**编译**契约，不执行任务。

## 核心能力

<table>
<tr>
<td><strong>自动审核</strong><br/>未引用的结束标记触发；写作轮在钩子内等审完才结束，不依赖主模型调用 <code>promote</code>。</td>
<td><strong>次模型 A / B</strong><br/>先 A；A 撞当前会话主模型则用 B。可分别选择推理强度，并写入真实 <code>agentOptions</code>。</td>
</tr>
<tr>
<td><strong>只读子代理</strong><br/>切到 <code>read-only</code> 沙箱，并禁止 edit/write/bash。必须打开工作区源码；空 <code>pathsRead</code> 不能过。</td>
<td><strong>七条审核规则</strong><br/>现场、调用链、事实分层、范围、验收、本机规则、可执行且够短。侧栏与审核端同源。</td>
</tr>
<tr>
<td><strong>循环有上限</strong><br/>默认最多 3 轮（1–5）。未见终稿/未通过标记前，初稿不算合格。</td>
<td><strong>prompt skill</strong><br/>把已确认目标编成可复制到新会话的执行契约。安装到 <code>~/.dsh/skills/prompt</code>。</td>
</tr>
</table>

## 工作方式

![主对话写契约，插件标审核中，次模型只读查仓，意见回主对话改稿，通过或用尽后才结束](docs/assets/workflow.zh-CN.svg)

1. 当前对话（或 prompt skill）写出契约，正文含 `[END OF EXECUTION PROMPT]`。
2. 插件注入「审核中」，并在 `turn-stopping` 里等待次模型返回；写作轮此时不标完成。
3. 通过则标终稿；不通过则唤醒主模型改稿；超时/失败可再调 `promote` 重试（120s）。
4. 显式 `promote` 仍可等待或接入进行中的同一哈希审核。

## 快速开始

### 1. 前置条件

- 本机 DeepSeek Harness 桌面端
- 已登录可用于次模型的账号（例如 Grok / GPT / 其它已配置路由）
- 完全退出再打开（⌘Q）后插件才会加载新代码

### 2. 安装插件

复制本仓库到 `$DSH_HOME/plugins/promote`（macOS 默认 `~/.dsh/plugins/promote`）。在 `$DSH_HOME/profiles/desktop/package.json` 加入 link 依赖和 bundle：

```json
{
  "dependencies": {
    "promote": "link:/Users/YOU/.dsh/plugins/promote"
  },
  "dsh": {
    "profile": {
      "bundles": ["promote"]
    }
  }
}
```

在该 desktop 目录安装 link，使包可解析：

```bash
cd "$DSH_HOME/profiles/desktop"
pnpm install
```

包内 `cordis.patch.yml` 会插入 `id: promote`。不要清空已有的 `profiles/desktop/cordis.patch.yml`。

### 3. 安装 prompt / promote skill

```bash
mkdir -p "$DSH_HOME/skills"
cp -R skills/prompt "$DSH_HOME/skills/prompt"
```

在对话里说「生成 prompt」「生成 promote」或使用 `/prompt`。Skill 只编译契约，不改项目。

### 4. 配置并验证

完全退出 DeepSeek Harness（⌘Q）再打开。右侧栏打开 **Promote**：

- 配置次模型 A、B 和各自推理强度（A、B 不能相同）
- 保存设置（写入 `$DSH_HOME/storages/promote/settings.json`，权限 0600）
- 当前会话主模型若等于 A，本轮审核改用 B

## 配置

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 次模型 A / B | 未配置 | `provider/model`，可带 `reasoningEffort` |
| 最大修改次数 | 3 | 范围 1–5 |
| 自动审核 | 开 | 关闭后可用显式工具 `promote` |
| 审核超时 | 120s | Host 常量，不上侧栏 |

未配齐 A/B、A=B、或两者都等于当前会话主模型时，本轮不审，对话和侧栏可见失败，禁止主模型自审。

<details>
<summary><strong>进阶：API、数据位置与审核规则</strong></summary>

- API：`/api/promote`（GET/POST）
- 设置：`$DSH_HOME/storages/promote/settings.json`
- 右侧栏 `kind` 为独有的 `promote`
- 审核规则与约束见侧栏，并写进审核子代理 prompt：现场对得上、调用链、事实分层、范围闭合、可验收、不与 AGENTS.md/skill 冲突、可执行且够短；read-only 沙箱、禁止 edit/write/multi_edit/bash、`pathsRead` 为空不得通过

</details>

## 验证

在插件目录、本机 Node（`/usr/local/bin/node`）上：

```bash
/usr/local/bin/node --check lib/index.js
/usr/local/bin/node --check lib/client.js
/usr/local/bin/node --test
```

0.1.10 prompt skill 编译契约前必须用 lsp 核对调用链，禁止输出未追引用的第一版终稿。单测不能代替 ⌘Q 后的桌面可见性。

## 常见问题

**改完代码页面没变？** 必须 ⌘Q 完全退出，热重载不够。

**侧栏提示未配置？** 下拉框有值也要点「保存设置」。

**刚选的模型又变回旧的？** 侧栏每 4 秒只刷新审核状态，不会覆盖未保存的 A/B。改完模型仍须点「保存设置」。要更新模型列表点「刷新」。

**A 选了当前对话同一个模型？** 会改用 B，这是设计，避免自审。

**skill 和插件什么关系？** skill 生成契约；插件审核当前对话里已经写出来的契约。可以只用其中一个。

**写了契约但没有「审核中」？** 引用行（`>`）和行内代码里的结束标记不审。prompt skill 那种围栏契约会审。改完插件须 ⌘Q。

**主对话为什么像结束了？** 0.1.5 起在 `turn-stopping` 钩子内等审完（Host 若等待异步钩子，写作轮不会先标完成）。失败或超时再唤醒主模型。这仍不是官方 subagent 的 pending 工具心跳。

## 社区与许可

公开仓库 Topic 为 `dsh-plugin`。许可见 [LICENSE](LICENSE)（MIT）。不包含用户设置、凭据或会话记录。

<div align="center"><sub>初稿先审再当终稿 · <a href="README.en.md">Read in English →</a></sub></div>
