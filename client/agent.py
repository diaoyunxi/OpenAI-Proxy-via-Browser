"""Agents 客户端核心：多轮对话 + 工具调用循环（agent loop）。

由于网关是纯文本透传，没有原生 function calling，本模块实现：
  1. 把工具说明注入系统提示词（由 prompts.render_system 完成）；
  2. 调用网关获取模型回复；
  3. 解析模型返回的 JSON 工具调用；
  4. 执行工具并把结果回灌上下文；
  5. 循环直到模型给出普通自然语言回答，或达到最大迭代次数。

整体流程与 OpenAI function calling 类似，但细节上依靠「提示词约定 + 文本透传」实现。
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from .oap_client import OAPClient, OAPError
from .prompts import render_system
from .tools import get_tool_spec

# 工具调用返回结构：[(工具名, 参数字典), ...]
ToolCall = Tuple[str, Dict[str, Any]]

_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)
# 思考类标签（<think>/<thinking>/<reasoning> 及其闭合变体），解析前剥离以减少干扰
_THINK_TAG_RE = re.compile(
    r"<(think|thinking|reasoning)>\s*[\s\S]*?</\1>", re.IGNORECASE)
# 锚定「工具调用对象」开头：以 {"tool": 起始，用于在复述提示词等杂乱文本中精准定位
_TOOL_ANCHOR_RE = re.compile(r'\{\s*"tool"\s*:', re.IGNORECASE)


class Agent:
    """基于网关的 agent 客户端，负责多轮对话与工具调用循环。"""

    def __init__(self, client: OAPClient, tools: Dict[str, Callable],
                 system_prompt: str = "", model: str = "browser-proxy",
                 host: Optional[str] = None, timeout: int = 180,
                 max_iterations: int = 8):
        self.client = client
        self.tools = dict(tools)
        self.system_prompt = system_prompt
        self.model = model
        self.host = host
        self.timeout = timeout
        self.max_iterations = max_iterations
        self.tool_specs = [get_tool_spec(f) for f in self.tools.values()]
        # 对话历史（不含系统提示，系统提示在每次请求时动态生成）
        self.history: List[Dict[str, str]] = []

    # ---- 对外 API ----
    def run(self, user_input: str, verbose: bool = False) -> str:
        """执行一轮 agent 对话，返回最终自然语言回答。"""
        self._format_retried = False  # 工具调用格式纠正重试标志，每次对话重置
        self.history.append({"role": "user", "content": user_input})
        for step in range(1, self.max_iterations + 1):
            messages = self._build_messages()
            try:
                resp = self.client.chat(messages, model=self.model, stream=False,
                                        host=self.host, timeout=self.timeout)
            except OAPError as e:
                return f"⚠️ 网关调用失败：{e}"

            content = self._extract_content(resp)
            # 优先检查是否有原生 tool_calls（来自浏览器扩展）
            native_tool_calls = self._extract_tool_calls(resp)
            if native_tool_calls:
                # 转换为自定义格式 {(name, args)}
                calls = [(tc["tool"], tc.get("args", {})) for tc in native_tool_calls]
            else:
                # 兼容旧格式：从 content 文本中解析
                calls = parse_tool_calls(content)

            # 记录模型原始输出（可能是工具调用 JSON，也可能是自然语言）
            self.history.append({"role": "assistant", "content": content})

            if not calls:
                if _looks_like_tool_call(content):
                    if self._format_retried:
                        # 已纠正重试一次仍无法解析，给出友好提示，
                        # 不再把含系统提示词的原始回复原样回显给用户
                        return ("⚠️ 模型返回了疑似工具调用，但无法按约定格式解析执行。"
                                "请确认工具调用为：{\"tool\": \"<工具名>\", \"args\": {<参数字典>}}"
                                "（可放在 ```json 围栏内，且不要复述系统提示词）。")
                    # 首次疑似格式不符：回灌纠正提示，最多重试一次
                    self._format_retried = True
                    self.history.append({
                        "role": "user",
                        "content": "你返回的内容疑似工具调用，但不符合约定格式，无法解析执行。"
                                   "请严格只输出如下 JSON（可放在 ```json 围栏内），"
                                   "不要输出额外解释文字、也不要复述系统提示词：\n"
                                   '{"tool": "<工具名>", "args": {<参数字典>}}'
                    })
                    continue
                # 确属普通自然语言回答 → 直接返回
                return content

            if verbose:
                print(f"  [步骤{step}] 工具调用：{[c[0] for c in calls]}")
            results: List[str] = []
            for name, args in calls:
                result = self._execute_tool(name, args)
                results.append(f"[工具 {name} 执行结果]\n{result}")
                if verbose:
                    print(f"    → {name}: {result[:200]}")
            self.history.append({
                "role": "user",
                "content": "以下是上一步工具调用的执行结果，请据此继续：\n\n"
                           + "\n\n".join(results)
            })
        return f"⚠️ 已达到最大迭代次数（{self.max_iterations}），任务可能未完成。"

    def reset(self) -> None:
        """清空对话历史。"""
        self.history.clear()

    # ---- 内部实现 ----
    def _build_messages(self) -> List[Dict[str, str]]:
        system = render_system(self.system_prompt, self.tool_specs)
        return [{"role": "system", "content": system}] + list(self.history)

    @staticmethod
    def _extract_content(resp: Dict[str, Any]) -> str:
        """从网关响应中提取内容，优先使用 tool_calls（如有），否则返回 content。

        注意：当存在工具调用时，content 通常为 null，工具调用信息通过 tool_calls 字段传递。
        此处返回纯文本内容，供历史记录使用；实际的工具调用由 _extract_tool_calls 处理。
        """
        try:
            return resp["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as e:
            raise OAPError(
                f"网关响应缺少 choices[0].message.content："
                f"{json.dumps(resp, ensure_ascii=False)[:200]}"
            ) from e

    @staticmethod
    def _extract_tool_calls(resp: Dict[str, Any]) -> Optional[List]:
        """从网关响应中提取工具调用列表。

        支持 OpenAI 格式的 tool_calls（{id, type, function}）和本项目自定义格式（{tool, args}）。
        """
        try:
            message = resp["choices"][0]["message"]
            tool_calls = message.get("tool_calls")
            if not tool_calls:
                return None
            # 转换为统一的 {tool, args} 格式
            normalized = []
            for tc in tool_calls:
                if isinstance(tc, dict):
                    if "tool" in tc:
                        # 已经是自定义格式
                        normalized.append(tc)
                    elif "function" in tc:
                        # OpenAI 标准格式
                        func = tc["function"]
                        args_str = func.get("arguments", "{}")
                        try:
                            args = json.loads(args_str) if isinstance(args_str, str) else args_str
                        except (ValueError, TypeError):
                            args = {"raw": args_str}
                        normalized.append({"tool": func.get("name", ""), "args": args})
                    elif "id" in tc and "type" in tc:
                        # OpenAI 新格式
                        func = tc.get("function", {})
                        args_str = func.get("arguments", "{}")
                        try:
                            args = json.loads(args_str) if isinstance(args_str, str) else args_str
                        except (ValueError, TypeError):
                            args = {"raw": args_str}
                        normalized.append({"tool": func.get("name", ""), "args": args})
            return normalized if normalized else None
        except (KeyError, IndexError, TypeError):
            return None

    def _execute_tool(self, name: str, args: Dict[str, Any]) -> str:
        func = self.tools.get(name)
        if func is None:
            return f"⚠️ 未知工具：{name}"
        try:
            return str(func(**args))
        except TypeError as e:
            return f"⚠️ 工具参数错误（{name}）：{e}"
        except Exception as e:  # noqa: BLE001
            return f"⚠️ 工具执行异常（{name}）：{e}"


# ------------------------- 工具调用解析（客户端侧） -------------------------

def _extract_balanced(text: str) -> List[str]:
    """提取文本中所有括号配对的 JSON 块（最外层 {} 或 []）。"""
    out: List[str] = []
    stack: List[str] = []
    start = -1
    for i, ch in enumerate(text):
        if ch in "{[":
            if not stack:
                start = i
            stack.append(ch)
        elif ch in "}]":
            if not stack:
                continue
            open_ch = stack.pop()
            if (open_ch == "{" and ch == "}") or (open_ch == "[" and ch == "]"):
                if not stack and start >= 0:
                    out.append(text[start:i + 1])
            else:
                stack.clear()
                start = -1
    return out


def _extract_tool_objects(text: str) -> List[str]:
    """从文本中锚定 ``"tool"`` 键，精准提取工具调用 JSON 对象。

    应对模型复述系统提示词（含大量工具说明 JSON）时，全局括号配对会跨块、
    导致提取失败的问题：本函数只从 ``{"tool":`` 起始处做括号配对，忽略前置噪声。
    """
    out: List[str] = []
    for m in _TOOL_ANCHOR_RE.finditer(text):
        start = m.start()          # 即左花括号位置
        depth = 0
        in_str = False
        esc = False
        end = -1
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch in "{[":
                depth += 1
            elif ch in "}]":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end > start:
            out.append(text[start:end + 1])
    return out


def _looks_like_tool_call(text: str) -> bool:
    """判断文本是否疑似包含工具调用（用于解析失败时的友好兜底/重试）。"""
    return bool(_TOOL_ANCHOR_RE.search(text))


def _safe_json(s: str):
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return None


def parse_tool_calls(text: str) -> List[ToolCall]:
    """把模型输出解析为工具调用列表 [(name, args_dict), ...]。

    支持：裸 JSON 对象/数组、```json 围栏包裹、含思考前缀时取最后一个 JSON 块。
    若无法解析为合法工具调用，返回空列表（视为普通自然语言回答）。
    """
    text = (text or "").strip()
    if not text:
        return []

    # 解析前先剥离思考类标签，避免思考文字里的括号干扰括号配对
    cleaned = _THINK_TAG_RE.sub("", text).strip()

    candidates: List[str] = []
    for m in _FENCE_RE.finditer(cleaned):
        candidates.append(m.group(1).strip())
    # 锚定 "tool" 键精准提取（优先级高，能绕过复述的提示词噪声）
    candidates.extend(_extract_tool_objects(cleaned))
    candidates.extend(_extract_balanced(cleaned))
    candidates.append(cleaned)  # 整段兜底

    # 去重并保持顺序
    seen: set = set()
    uniq: List[str] = []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            uniq.append(c)

    # 从后往前试，命中即返回（兼容思考前缀场景）
    for raw in reversed(uniq):
        parsed = _safe_json(raw)
        if parsed is None:
            continue
        items = parsed if isinstance(parsed, list) else [parsed]
        if not isinstance(items, list):
            continue
        calls: List[ToolCall] = []
        ok = True
        for it in items:
            if not isinstance(it, dict) or "tool" not in it or not isinstance(it.get("tool"), str):
                ok = False
                break
            # 优先取 "args" 字段；若模型直接把参数平铺，则取除 tool 外的全部字段
            if "args" in it and isinstance(it["args"], dict):
                args = dict(it["args"])
            else:
                args = {k: v for k, v in it.items() if k != "tool"}
            calls.append((it["tool"], args))
        if ok and calls:
            return calls
    return []
