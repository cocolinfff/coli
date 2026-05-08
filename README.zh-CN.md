# Coli — pi 定时任务监督器

Coli 是一个 pi-coding-agent 扩展，实现**定时触发 + 不同模型监督**的多轮任务完成机制。

## 核心思路

```
用户 / LLM → 安排任务(延时 + 监督模型) → Timer 触发
                                              ↓
            ┌──────────────────────────────────────┐
            │  工作 Agent (当前会话 model)            │
            │  执行任务... 调用工具...                │
            └──────────┬───────────────────────────┘
                       │ agent_end 事件
                       ▼
            ┌──────────────────────────────────────┐
            │  监督 Agent (不同 model，只评估不做工)   │
            │  评估输出 → done / continue / fail     │
            └──────────┬───────────────────────────┘
                       │ continue + 指令
                       ▼
            ┌──────────────────────────────────────┐
            │  工作 Agent (下一轮)                   │
            │  ...直到完成或达到最大轮次               │
            └──────────────────────────────────────┘
```

- **工作 Agent** 使用当前 pi 会话的模型，拥有完整的 context 和工具权限
- **监督 Agent** 使用**不同模型**（通过 `/coli setup` 配置，或自动发现带 `[coli]` 前缀的模型），通过 SDK `complete()` 直接调用，**不进入会话上下文**
- **监督模型严格受限**：它的 system prompt 明确禁止读取文件、执行命令，纯评估角色
- **Token 节约**：工作输出截断至末尾 3000 字符，历史轮次压缩为单行摘要
- 监督最多进行 N 轮（默认 5 轮，可通过 setup 调整），硬性防止无限循环
- 任务与当前 pi 会话窗口**强绑定**，关闭即终止

## 安装

```bash
pi install git:github.com/cocolinfff/coli
```

安装后 `/reload` 或重启 pi。

## 配置（必需第一步）

首次使用前，运行 `/coli setup model` 自动发现监督模型：

```
/coli setup model
```

这会扫描所有可用模型，优先选择名称中带 `[coli]` 前缀的模型（如 `[coli] claude-haiku-4-5`），找不到则用第一个可用模型。

### 如何标记监督模型为 `[coli]`

在 `~/.pi/agent/models.json` 中为模型添加 `[coli]` 前缀的名称：

```json
{
  "models": [
    {
      "provider": "anthropic",
      "id": "claude-haiku-4-5",
      "name": "[coli] claude-haiku-4-5"
    }
  ]
}
```

推荐使用便宜快速的模型（如 `claude-haiku-4-5`、`gpt-4o-mini`）作为监督模型，因为监督只做评估不执行工具。

### 完整配置命令

| 命令 | 说明 |
|------|------|
| `/coli setup` | 查看当前配置 |
| `/coli setup model` | 自动发现监督模型（优先 `[coli]` 前缀） |
| `/coli setup model anthropic/claude-haiku-4-5` | 指定监督模型 |
| `/coli setup rounds 3` | 设置默认最大轮次 (1-20) |
| `/coli setup reset` | 恢复默认 |

## 快速开始

配置完成后即可安排任务：

```
/coli schedule in 2 minutes 检查 src/ 下的类型错误并修复
```

输出：
```
✓ Coli 任务已创建 [a1b2c3d4]
触发: 14:32:00  (1m 58s)
描述: 检查 src/ 下的类型错误并修复
监督: anthropic/claude-haiku-4-5 ([coli] claude-haiku-4-5)  (最多 5 轮)
```

2 分钟后工作 Agent 自动收到任务，每轮结束后监督模型评估进度。

## 典型使用案例

### 案例 1：延时代码审查

> 你正在重构认证模块，改完代码后想让另一个模型在 5 分钟后审查质量。

```
/coli schedule in 5 minutes 审查 src/auth/ 下本次重构涉及的所有文件，
检查是否有安全漏洞、逻辑错误或不一致的命名，并修复发现的问题
```

工作 Agent 在 5 分钟后开始审查，监督模型（如 haiku）每轮评估：是否所有文件
都已检查？发现的问题是否都已修复？若还有遗漏，给出下一轮的具体指令。

> **交互实录示意：**
>
> `[14:05]` 工作 Agent: 读取 src/auth/login.ts, src/auth/session.ts …
> `[14:05]` 工作 Agent: 发现 login.ts:42 缺少输入校验，session.ts:88 token 过期逻辑未处理
> `[14:06]` 工作 Agent: 已修复两处问题
> `[14:06]` **监督 Agent (haiku):** `{"status":"continue","instruction":"再检查 auth/middleware.ts 是否有 CSRF 保护缺失"}`
> `[14:07]` 工作 Agent: 检查 middleware.ts，发现 CSRF token 未校验 referer header，已添加
> `[14:07]` **监督 Agent (haiku):** `{"status":"done","instruction":""}` → ✓ 完成

### 案例 2：定时批量测试 + 自我修复

> 下班前安排 Coli 在凌晨 2 点跑全量测试，失败则自动修到通过为止。

```
/coli schedule at 02:00 运行 npm test，如有失败，分析错误原因并修复代码，
然后重新运行测试，循环直到全部通过
```

工作 Agent 运行测试 → 失败 → 监督模型判断"继续，还有 3 个用例失败，
错误是 xxx" → 工作 Agent 修复 → 再运行测试 → 监督模型判断全部通过 → done。
整个过程无需人工介入。

### 案例 3：LLM 自我调度子任务

> 你让工作 Agent 重构一个大型模块，它决定先完成核心重构，然后安排 2 分钟
> 后自查遗漏。工作 Agent 主动调用 `coli_schedule` 工具。

你只需对 pi 说：

```
重构 src/services/order.ts，拆分为 order/create.ts、order/query.ts、
order/cancel.ts，保持所有现有测试通过，完成后自查是否有遗漏
```

工作 Agent 完成重构后，自行调用：

```json
coli_schedule({
  "delay_seconds": 120,
  "task_description": "检查 order 模块重构：确认所有 import 路径已更新、没有循环依赖、旧文件已删除、所有测试仍通过",
  "max_rounds": 3
})
```

2 分钟后 Coli 触发自查任务，监督模型确保没有遗漏。

### 案例 4：弱模型工作 + 强模型监督

> 日常编码用便宜模型（如 haiku），关键任务完成后用强模型（如 sonnet）
> 做质量把关。节省日常 token 成本，关键节点不降低质量。

```bash
# 1. 日常用 haiku 编码
pi --model anthropic/claude-haiku-4-5

# 2. 在 pi 内配置监督模型
/coli setup model anthropic/claude-sonnet-4-5
/coli setup rounds 3

# 3. 完成当前工作后安排 sonnet 审查
/coli schedule in 1 minute 全面审查本轮所有代码变更：
架构合理性、性能瓶颈、安全隐患、边界条件处理
```

haiku（工作 Agent）执行编码 → 完成后 sonnet（监督 Agent）做最终审查，
发现问题则 haiku 修复 → sonnet 再次审查 → 通过或达到最大轮次。

### 案例 5：连续多轮迭代直到收敛

> 生成一份复杂的 SQL 迁移脚本，包含多个表、索引和外键。让监督模型
> 反复检查直到没有语法错误和逻辑问题。

```
/coli schedule in 30 seconds 在 db/migrations/ 下生成 v2.0 迁移脚本：
- 新增 users_audit、sessions、api_keys 三张表
- 外键约束正确引用
- 索引覆盖常用查询字段
- 向下迁移脚本可逆
```

监督模型每轮检查：
- 第 1 轮："外键 users_audit.user_id 引用 users.id 但类型不匹配"
- 第 2 轮："sessions 表缺少 expires_at 索引"
- 第 3 轮："向下迁移顺序错误，应先删 api_keys 再删 users_audit"
- 第 4 轮："done"

> 这体现了监督模型的核心价值：工作 Agent 可能忽略了细节，
> 但不同的模型从不同角度审查，能发现遗漏的问题。

### 案例 6：定时巡检

> 每 30 分钟自动检查一次日志是否有异常，有则分析并告警。

```
/coli schedule in 30 minutes 检查 logs/app.log 最近 30 分钟的错误日志，
如有 ERROR 或 FATAL，分析可能原因并汇总到 SUMMARY.md，
同时检查是否有重复的 WARN 超过 10 条
```

可结合 cron / systemd timer 在 pi 启动时自动注入调度命令，实现持续巡检。

### 案例 7：跨会话接力

> 在会话 A 中编写代码，安排 1 小时后在同一个会话中触发测试任务。
> 你可以在 1 小时内继续其他工作或离开，Coli 准时触发。

```
/coli schedule in 1 hour 运行 e2e 测试套件，分析失败用例的根因并修复，
然后重新运行验证
```

1 小时后 Coli 自动注入任务，无需手动记住或切回会话。
注意：pi 必须保持运行（不要关闭窗口），否则任务丢失。

---

## 命令参考

| 命令 | 说明 |
|------|------|
| `/coli help` | 帮助 |
| `/coli setup` | 配置默认监督模型和轮次 |
| `/coli setup model` | 自动发现监督模型 |
| `/coli setup model <pv>/<id>` | 指定监督模型 |
| `/coli setup rounds <n>` | 设置最大轮次 (1-20) |
| `/coli schedule <when> <task>` | 安排定时任务 |
| `/coli list` | 查看所有任务 |
| `/coli cancel <id>` | 取消任务 |

### 时间表达式

| 格式 | 示例 |
|------|------|
| `in X minutes` | `in 10 minutes` |
| `in X hours` | `in 2 hours` |
| `in X seconds` | `in 30 seconds` |
| `at HH:MM` | `at 15:30` |
| 毫秒数 | `300000` |

## Tool：`coli_schedule`

LLM 可调用此工具自行安排子任务。

### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `delay_seconds` | number | 延迟秒数 |
| `task_description` | string | 任务描述 |
| `max_rounds` | number (可选) | 最大轮次，默认使用配置值 |
| `supervisor_model` | string (可选) | `"provider/modelId"`，默认使用配置值 |

### 示例

```
"完成重构后帮我安排 5 分钟后跑测试并修复失败用例"
→ coli_schedule({ delay_seconds: 300, task_description: "npm test 并修复所有失败" })
```

## 架构细节

### 文件结构

```
coli/
├── index.ts          # 入口：命令、工具、事件、配置管理
├── scheduler.ts      # 定时器：setTimeout + 30s 轮询兜底
├── supervisor.ts     # 监督调用：complete() + prompt + 决策解析
├── types.ts          # 类型 + ColiConfig + 监督 system prompt
└── README.md
```

### 配置持久化

配置通过 `pi.appendEntry("coli-config", ...)` 写入会话 JSONL，`session_start` 时自动恢复。

### 监督模型发现

优先级：
1. `/coli setup model <pv>/<id>` 显式配置
2. 扫描 `modelRegistry.getAvailable()`，匹配 `name` 含 `[coli]` 前缀的模型
3. 第一个可用模型
4. 当前 pi 会话模型（最后兜底）

### 监督模型限制

监督模型的 system prompt 明确规定：
- **不能读取文件**、不能执行命令、不做任何实际工作
- **纯评估者**：仅判断 done / continue / fail
- 回复保持极短（1-3 句），纯 JSON 格式

### Token 节约策略

| 策略 | 值 |
|------|-----|
| System prompt | ~200 tokens（最小化指令） |
| 工作输出截断 | 末尾 3000 字符 |
| 历史轮次压缩 | 每轮 1 行摘要 |
| 错误信息截断 | 200 字符 |

### 安全机制

| 机制 | 说明 |
|------|------|
| `maxRounds` 硬上限 | 默认 5，范围 1-20，绝对防无限循环 |
| 防重入锁 `supervisionActive` | 单线程执行监督 |
| 会话强绑定 | `session_shutdown` 清理所有 timer |
| 监督模型隔离 | 不入会话 context，无工具权限 |
| 监督 prompt 约束 | 禁止监督模型自己动手做任务 |

## 限制

- 定时器精度约秒级，不保证毫秒准时
- pi 关闭后任务丢失（内存 timer 清理），重启后仅恢复 pending 任务
- 监督调用是一次性 HTTP 请求，支持所有 pi 模型提供商的模型

## 许可

MIT
