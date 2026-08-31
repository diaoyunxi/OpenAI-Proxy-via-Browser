# OpenAI-Proxy Agents 客户端（零依赖）

本项目网关（`server/`）是「纯文本透传」的 OpenAI 兼容 API，**本身不做 agent、不实现工具执行**。
本目录提供一个**自研、零第三方依赖**的 agents 客户端：它消费网关接口，实现多轮对话 +
工具调用循环（agent loop）。工具定义由客户端注入系统提示词，模型按约定返回 JSON，
客户端解析并执行（整体流程类 OpenAI function calling，但细节上靠提示词 + 文本透传实现）。

## 1. 环境要求

- Python 3.8+（仅标准库，无需 `pip install`）
- 本地已启动网关：`python server/main.py`（监听 `127.0.0.1:8080`）
- 浏览器已加载本项目的 Chrome 扩展，并打开已登录的目标 AI 网站标签页

## 2. 快速开始（命令行 demo）

```bash
# 进入仓库根目录
cd OpenAI-Proxy-via-Browser

# 基本用法：指定目标站点
python -m client.cli --host chat.openai.com

# 显示工具调用过程
python -m client.cli --host chat.openai.com --verbose

# 自定义网关地址 / 系统提示 / 最大迭代次数
python -m client.cli --base-url http://127.0.0.1:8081 --host chat.openai.com \
                      --system "你是一个严谨的运维助手" --max-iterations 12
```

交互命令：
- 直接输入问题即可对话；
- `exit` / `quit` 退出；
- `/reset` 清空对话上下文。

## 3. 作为库使用

```python
from client import OAPClient, Agent, BUILTIN_TOOLS, list_tool_specs

client = OAPClient(base_url="http://127.0.0.1:8080", default_host="chat.openai.com")
print(client.health())                 # 健康检查
print(list_tool_specs())               # 查看内置工具说明

agent = Agent(
    client,
    BUILTIN_TOOLS,                     # 内置工具注册表（shell/read_file/write_file/list_dir/http_request）
    system_prompt="你是一个有用的助手",
    model="browser-proxy",
    host="chat.openai.com",
    max_iterations=8,
)

answer = agent.run("列出当前目录下的文件，并读取 README.md 的第一行")
print(answer)
```

## 4. 数据流（与 OpenAI 的区别）

```
用户问题
  │
  ▼
Agent.run()
  │  ① 把「工具说明 + 调用约定」渲染进 system 提示词
  │  ② POST /v1/chat/completions（messages 含 system/user/assistant/user…）
  ▼
网关 → 扩展 → 目标 AI 网页（纯文本透传，不解析工具格式）
  │
  ▼
模型返回文本（可能是自然语言，也可能是 JSON 工具调用）
  │
  ▼
Agent.parse_tool_calls()  ← 关键：在客户端侧解析
  ├─ 无工具调用 → 作为最终回答返回
  └─ 有工具调用 → 执行工具（shell/read_file/…）→ 结果回灌上下文 → 回到 ①
```

**与 OpenAI 原生 function calling 的主要区别**：
- 网关没有原生 `tool_calls` 字段；工具调用是模型在**普通文本**里返回的 JSON。
- 客户端负责把工具说明写进提示词，并解析模型返回的 JSON（支持裸 JSON、` ```json ` 围栏、含思考前缀时取最后一个 JSON 块）。
- 约定的 JSON 格式：`{"tool": "<工具名>", "args": {<参数字典>}}`；多个工具用数组：
  `[{"tool":"...","args":{...}}, {"tool":"...","args":{...}}]`。

## 5. 内置工具

| 工具名 | 说明 | 主要参数 |
| :--- | :--- | :--- |
| `shell` | 本地执行 shell 命令 | `command`、`cwd`、`timeout` |
| `read_file` | 读取文本文件 | `path`、`max_bytes` |
| `write_file` | 写入文本文件（覆盖） | `path`、`content` |
| `list_dir` | 列举目录 | `path`、`limit` |
| `http_request` | 发送 HTTP 请求 | `url`、`method`、`body` |

## 6. 扩展自定义工具

在 `client/tools.py` 里用 `@_tool` 装饰器注册即可，自动进入提示词与执行注册表：

```python
from client.tools import _tool

@_tool("now", "返回当前时间", {
    "type": "object",
    "properties": {},
    "required": []
})
def now():
    import datetime
    return datetime.datetime.now().isoformat()
```

然后把它并入传给 `Agent` 的工具字典：`Agent(client, {**BUILTIN_TOOLS, "now": now}, ...)`。

## 7. 安全提示

工具执行具有系统副作用（读写文件、执行命令、发起网络请求）。客户端已对 `shell` 做
危险命令**提示性拦截**，但这**不是**绝对安全保证。请仅在可信环境使用，且不要把不可信
外部输入直接作为命令/路径执行。建议生产场景改为「工具执行前需用户确认」或沙箱方案。
