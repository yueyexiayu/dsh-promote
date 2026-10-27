<div align="center">
  <img src="docs/assets/hero.svg" width="100%" alt="Diagram: the current chat writes an execution contract, a secondary model reviews it read-only, then the main model revises. Not a product screenshot." />
  <h1>Promote</h1>
  <p><strong>Write an execution contract in the current chat. A secondary model reviews it read-only. Do not treat a draft as final until it passes.</strong></p>
  <p>A DeepSeek Harness desktop plugin, plus the <code>prompt</code> / promote skill that compiles contracts.</p>
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <p><a href="LICENSE">MIT</a> · version 0.1.0</p>
  <p><a href="#features">Features</a> · <a href="#how-it-works">How it works</a> · <a href="#quick-start">Quick start</a> · <a href="#configuration">Configuration</a> · <a href="#validation">Validation</a> · <a href="#faq">FAQ</a></p>
</div>

---

The writing side is always the current conversation. When unquoted `[END OF EXECUTION PROMPT]` appears in visible assistant text, the plugin marks the draft **in review**, starts a secondary-model `fork` (then `spawn` on failure) that inspects the workspace read-only, and steers structured notes back for revision. Pass marks a final draft; exhausting the round cap marks it unqualified. `skills/prompt` **compiles** contracts only and does not execute the task.

## Features

<table>
<tr>
<td><strong>Auto review</strong><br/>Triggers on an unquoted, unfenced end marker. Markers only in quotes or fences are ignored.</td>
<td><strong>Models A / B</strong><br/>Try A first; if A matches the current session model, use B. Reasoning effort is selectable and passed in real <code>agentOptions</code>.</td>
</tr>
<tr>
<td><strong>Read-only child</strong><br/>File edits fail the round. The child must open workspace sources; empty <code>pathsRead</code> cannot pass.</td>
<td><strong>Seven review rules</strong><br/>Evidence, call chain, fact layers, scope, acceptance, local rules, and brevity. Sidebar and reviewer share the same list.</td>
</tr>
<tr>
<td><strong>Bounded loop</strong><br/>Default 3 rounds (1–5). Until a final or unqualified mark appears, the draft is not qualified.</td>
<td><strong>prompt skill</strong><br/>Compiles confirmed goals into a contract for a new session. Install to <code>~/.dsh/skills/prompt</code>.</td>
</tr>
</table>

## How it works

![The main chat writes a contract, the plugin marks it in review, a secondary model inspects the repo read-only, notes return for revision, then pass or exhaust](docs/assets/workflow.en.svg)

1. The current chat (or the prompt skill) writes a contract whose body includes `[END OF EXECUTION PROMPT]`.
2. The plugin immediately injects an in-review status. That version is not final.
3. The secondary model inspects the session workspace read-only and returns pass/issues/suggestions/paths read.
4. Failures steer the main model to revise. Pass marks final; exhausting N rounds marks unqualified.

## Quick start

### 1. Prerequisites

- DeepSeek Harness desktop
- A logged-in account usable as the secondary model
- A full quit and reopen (Cmd+Q on macOS) after install

### 2. Install the plugin

Copy this repository to `$DSH_HOME/plugins/promote` (macOS default `~/.dsh/plugins/promote`). Add a link dependency and bundle in `$DSH_HOME/profiles/desktop/package.json`:

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

Install the link from that desktop profile so the package resolves:

```bash
cd "$DSH_HOME/profiles/desktop"
pnpm install
```

The package `cordis.patch.yml` inserts `id: promote`. Do not empty the existing `profiles/desktop/cordis.patch.yml`.

### 3. Install the prompt / promote skill

```bash
mkdir -p "$DSH_HOME/skills"
cp -R skills/prompt "$DSH_HOME/skills/prompt"
```

Say “生成 prompt”, “生成 promote”, or use `/prompt`. The skill only compiles; it does not edit the project.

### 4. Configure and verify

Quit DeepSeek Harness fully (Cmd+Q) and reopen. Open **Promote** in the right sidebar:

- Set secondary models A and B and each reasoning effort (A and B cannot be the same)
- Save (writes `$DSH_HOME/storages/promote/settings.json`, mode 0600)
- If the current session model equals A, this round uses B

## Configuration

| Item | Default | Notes |
| --- | --- | --- |
| Models A / B | unset | `provider/model`, optional `reasoningEffort` |
| Max revisions | 3 | Range 1–5 |
| Auto review | on | Use the `promote` tool when off |
| Review timeout | 120s | Host constant, not in the sidebar |

Missing A/B, A equals B, or both matching the current session model: no review this round, visible failure in chat and sidebar, no self-review.

<details>
<summary><strong>Advanced: API, data location, and rules</strong></summary>

- API: `/api/promote` (GET/POST)
- Settings: `$DSH_HOME/storages/promote/settings.json`
- Sidebar `kind` is the unique value `promote`
- Review rules match the sidebar and the child prompt: evidence, call chain, fact layers, closed scope, acceptance, no conflict with AGENTS.md/skills, short enough to execute; read-only, no edit/write/multi_edit, empty `pathsRead` cannot pass

</details>

## Validation

From the plugin directory, with local Node (`/usr/local/bin/node`):

```bash
/usr/local/bin/node --check lib/index.js
/usr/local/bin/node --check lib/client.js
/usr/local/bin/node --test
```

During 0.1.0 development, `node --test` reported 39 passing tests (model collision, missing config, no double review of the same hash, stale result discard, quoted markers ignored, injected messages do not loop, reasoning effort in `agentOptions`). Unit tests do not replace desktop visibility after Cmd+Q.

## FAQ

**I changed the files and the UI did not?** Quit fully with Cmd+Q. Reload is not enough.

**The sidebar says it is unconfigured?** Saving is required even if the dropdowns show values.

**A is the same model as this chat?** The round uses B. That is intentional.

**How do the skill and plugin relate?** The skill writes contracts; the plugin reviews a contract already written in the current chat. Either can be used alone.

## Community and license

The public repository topic is `dsh-plugin`. See [LICENSE](LICENSE) (MIT). User settings, credentials, and session logs are not in this tree.

<div align="center"><sub>Review the draft before calling it final · <a href="README.md">阅读中文版 →</a></sub></div>
