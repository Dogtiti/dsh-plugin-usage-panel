# dsh-plugin-usage-panel

给 DeepSeek Harness 加一个**供应商套餐用量面板**：在模型选择器右侧显示一枚小徽标，点开是与 ZCode 客户端同款的三列明细（5 小时窗口 / 每周 / 工具调用）。目前接入了 **GLM Coding Plan**，后续可以在同一插件里接其他供应商。

- 只在模型选择器显示 **GLM** 时出现（读模型控件的 aria-label，读不到就隐藏）
- **平时不发任何请求**：徽标只写「额度」两个字，不显示百分比；悬停时现查一次（`?refresh=1` 绕过缓存），移开即关闭
- API key 只在 Host 进程内使用，不下发到浏览器；上游结果缓存 20 秒

数据来自 ZCode 客户端使用的同一个接口：

```
GET <base>/api/monitor/usage/quota/limit
authorization: <api key>
```

## 安装

```bash
dsh plugin install dsh-plugin-usage-panel
```

或在 Plugins 页安装后重启。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `ZAI_CODING_CN_API_KEY` | 通过 Host 凭据服务解析的 key 名 |
| `baseUrl` | `https://api.z.ai` | 接口域名；BigModel 用 `https://open.bigmodel.cn` |
| `refreshSeconds` | `60` | 缓存与轮询间隔（下限 10 秒） |

API key 只在 Host 进程内使用，不会下发到浏览器。

## 位置与可见性

- 挂在 `conversation.input.activity`：**输入框工具行里、模型选择器右侧紧邻**。
  （布局没有"模型左侧"的插槽：`conversation.input.left` 是最左边那一簇，而模型选择器本身是 single 槽，不能被扩展。）
- **只有模型选择器是 GLM 时才出现**：读模型控件的无障碍名称（`aria-label` 形如「选择模型，当前: GLM-5.3-Flash，推理…」），从中取出当前模型名，命中 `/glm/i` 才渲染；读不到就隐藏（宁可不显示）。

  为什么不用接口：harness **没有向插件暴露当前模型**——`agentDefaultModel.currentSelection()` 在插件里是 `undefined`，会话快照与 projection 都没有模型字段，模型控件的 slot props 只有 `{locked}`。会话日志里的 `model/selection` 事件是模型菜单浏览时写入的预览，不代表已提交的选择，所以不能拿它判断。

## 显示内容

- 触发徽标：`GLM <最紧的窗口百分比>`，颜色随余量变化（>30% 绿、>10% 橙、≤10% 红）
- 弹层：套餐等级 + 三列（5 小时 / 每周 / 工具调用），每列是标签、剩余百分比、重置日期、进度条
- 底部：本次读数时间

## 接口字段对照

| 面板 | 接口 |
| --- | --- |
| 5 小时 | `TOKENS_LIMIT` + `unit: 3` |
| 每周 | `TOKENS_LIMIT` + `unit: 6` |
| 工具调用 | `TIME_LIMIT`（`usage` 总额、`currentValue` 已用） |
| 套餐 | `data.level` |

剩余百分比 = `100 - percentage`。

## 相关插件

| 插件 | 说明 |
| --- | --- |
| [dsh-plugin-composer-predict](https://github.com/Dogtiti/dsh-plugin-composer-predict) | 预测下一条指令并显示为占位文字，`Tab` 采纳 |
| [dsh-plugin-composer-history](https://github.com/Dogtiti/dsh-plugin-composer-history) | 输入框中按 `↑` / `↓` 回填历史消息 |
| [dsh-plugin-subagent-bridge](https://github.com/Dogtiti/dsh-plugin-subagent-bridge) | 让 Codex 通过本机 MCP 把 DSH 当 subagent 用（spawn / wait / followup），反向也能把任务派给 Codex |
| **dsh-plugin-usage-panel**（本仓库） | 在模型选择器旁显示供应商套餐额度余量（目前 GLM Coding Plan），点开是明细浮层 |
| [dsh-plugin-provider-icons](https://github.com/Dogtiti/dsh-plugin-provider-icons) | 在模型名旁显示供应商品牌 logo（24 个厂商，支持前缀匹配） |
