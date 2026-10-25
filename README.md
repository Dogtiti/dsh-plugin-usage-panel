# dsh-plugin-usage-panel

给 DeepSeek Harness 加一个**供应商套餐用量面板**：在模型选择器右侧显示一枚小图标，悬停（或点击）展开当前套餐的窗口明细。

已接入两家：

| 套餐 | 面板列 |
| --- | --- |
| **GLM Coding Plan**（智谱 / Z.ai） | 5 小时 · 每周 · 工具调用 |
| **OpenCode Zen（Go）** | 滚动窗口 · 每周 · 每月 |

- **按会话实际使用的供应商显示**：面板问 Host「这个会话在跑哪家」，Host 从会话自己的 `model/selection` 事件读 provider id，所以 `newapi` 之类的网关不会误显示
- **平时不发任何请求**：只有悬停/点击时才查一次（`?refresh=1` 绕过缓存），移开即关闭
- API key 只在 Host 进程内使用，不下发到浏览器；上游结果按 `refreshSeconds` 缓存

## 安装

```bash
dsh plugin install dsh-plugin-usage-panel
```

或在 Plugins 页安装后重启。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `source` | `auto` | `auto` / `glm` / `opencode`；`auto` 按当前 provider 判断 |
| `apiKeyEnv` | `ZAI_CODING_CN_API_KEY` | 智谱 key 的凭据名 |
| `baseUrl` | `https://api.z.ai` | 智谱接口域名；BigModel 用 `https://open.bigmodel.cn` |
| `opencodeApiKeyEnv` | `OPENCODE_GO_API_KEY` | OpenCode key 的凭据名 |
| `opencodeBaseUrl` | `https://opencode.ai/zen/go/v1` | OpenCode 接口域名 |
| `refreshSeconds` | `20` | 缓存时间（下限 10 秒） |

两个 key 都只在 Host 进程内使用，不会下发到浏览器。只配一家也能用，另一家会显示「未配置 API Key」。

## 数据来源

与各家客户端自己用的接口一致：

```
# GLM Coding Plan
GET <base>/api/monitor/usage/quota/limit
authorization: <api key>

# OpenCode Zen (Go)
GET <opencodeBaseUrl>/usage
authorization: Bearer <api key>
```

OpenCode 返回的是三个窗口的使用百分比：

```json
{"usage":{"rolling":{"percent":1,"resetsAt":"..."},"weekly":{"percent":0,...},"monthly":{"percent":0,...}}}
```

## 位置与可见性

- 挂在 `conversation.input.activity`：**输入框工具行里、模型选择器右侧紧邻**。
  （布局没有"模型左侧"的插槽：`conversation.input.left` 是最左边那一簇，而模型选择器本身是 single 槽，不能被扩展。）
- 渲染前先问 Host 一次 `?probe=1`（纯本地、不打上游），Host 用会话的 `model/selection` 事件得出 provider：
  - `zai` / `zai-coding-cn` 这类 → `glm`
  - `opencode-go` 这类 → `opencode`
  - 其他（含 `newapi` 网关）→ 隐藏图标

  为什么不能只看模型名：`deepseek-v4.1-flash` 这类模型同时挂在多个供应商下，名字分不出归属。

## 显示内容

- 触发图标：一个柱状小图标，不显示数字
- 弹层：套餐徽标（GLM Coding Plan / OpenCode Go）+ 各窗口一列（名称、剩余百分比、重置日期、进度条）
- 底部：本次读数时间

## 接口字段对照

| 面板 | GLM | OpenCode |
| --- | --- | --- |
| 5 小时 / 滚动 | `TOKENS_LIMIT` + `unit: 3` | `usage.rolling.percent` |
| 每周 | `TOKENS_LIMIT` + `unit: 6` | `usage.weekly.percent` |
| 每月 | — | `usage.monthly.percent` |
| 工具调用 | `TIME_LIMIT`（`usage` 总额、`currentValue` 已用） | — |
| 套餐 | `data.level` | — |

两家返回的都是**已用百分比**，面板统一按 `剩余 = 100 - 已用` 显示。

## 相关插件

| 插件 | 说明 |
| --- | --- |
| [dsh-plugin-composer-predict](https://github.com/Dogtiti/dsh-plugin-composer-predict) | 预测下一条指令并显示为占位文字，`Tab` 采纳 |
| [dsh-plugin-composer-history](https://github.com/Dogtiti/dsh-plugin-composer-history) | 输入框中按 `↑` / `↓` 回填历史消息 |
| [dsh-plugin-subagent-bridge](https://github.com/Dogtiti/dsh-plugin-subagent-bridge) | 让 Codex 通过本机 MCP 把 DSH 当 subagent 用（spawn / wait / followup），反向也能把任务派给 Codex |
| **dsh-plugin-usage-panel**（本仓库） | 在模型选择器旁显示供应商套餐额度余量（GLM Coding Plan / OpenCode Go），点开是明细浮层 |
| [dsh-plugin-provider-icons](https://github.com/Dogtiti/dsh-plugin-provider-icons) | 在模型名旁显示供应商品牌 logo（24 个厂商，支持前缀匹配） |
