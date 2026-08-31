"""把工具定义渲染为系统提示词，并约定模型返回工具调用的 JSON 格式。

由于网关是「纯文本透传」，没有原生 function calling，因此由客户端把工具说明
注入系统提示词；模型按约定返回 JSON，再由客户端解析并执行（整体流程类 OpenAI，
但细节上靠提示词约定 + 文本透传实现）。
"""
from __future__ import annotations

import json
from typing import Dict, List

FORMAT_INSTRUCTION = """\
# 工具调用约定
当你需要调用工具来完成任务时，请**只输出**如下 JSON（可放在 ```json 围栏内，
也可直接输出裸 JSON），不要输出额外解释文字：
{"tool": "<工具名>", "args": {<参数字典>}}
如需并行调用多个工具，输出 JSON 数组：
[{"tool": "...", "args": {...}}, {"tool": "...", "args": {...}}]
如果你可以直接回答用户，则正常用自然语言回复，不要输出 JSON。
"""


def render_system(system_prompt: str, tool_specs: List[Dict[str, Any]]) -> str:
    """构造最终发给模型的系统提示词。

    :param system_prompt: 用户自定义的系统说明（可为空）。
    :param tool_specs: 工具说明列表（含 name/description/parameters）。
    """
    parts: List[str] = []
    if system_prompt:
        parts.append(system_prompt.strip())
    if tool_specs:
        parts.append("你拥有以下工具，可在需要时调用：")
        for spec in tool_specs:
            parts.append(json.dumps(spec, ensure_ascii=False, indent=2))
        parts.append(FORMAT_INSTRUCTION)
    return "\n\n".join(parts)
