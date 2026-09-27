"""把工具定义渲染为系统提示词，并约定模型返回工具调用的 JSON 格式。

由于网关是「纯文本透传」，没有原生 function calling，因此由客户端把工具说明
注入系统提示词；模型按约定返回 JSON，再由客户端解析并执行（整体流程类 OpenAI，
但细节上靠提示词约定 + 文本透传实现）。

其中「工具调用格式约定」来自仓库根目录的 ``tool_call_format.txt``，改完即生效；
文件缺失或为空时回退到本模块内置的等价内容。
"""
from __future__ import annotations

import json
from typing import Any, Dict, List

from .prompt_files import load_tool_call_format


def tool_call_instruction() -> str:
    """返回当前生效的工具调用格式约定。

    每次调用都会检查 ``tool_call_format.txt`` 是否变化，因此支持热更新。

    :return: 工具调用约定文本
    """
    return load_tool_call_format()


def render_system(system_prompt: str, tool_specs: List[Dict[str, Any]]) -> str:
    """构造最终发给模型的系统提示词。

    拼接顺序：用户自定义系统说明 -> 工具清单 -> 工具调用格式约定。

    :param system_prompt: 用户自定义的系统说明（可为空）。
    :param tool_specs: 工具说明列表（含 name/description/parameters）。
    :return: 拼接后的系统提示词；两者皆为空时返回空串
    """
    parts: List[str] = []
    if system_prompt:
        parts.append(system_prompt.strip())
    if tool_specs:
        parts.append("你拥有以下工具，可在需要时调用：")
        for spec in tool_specs:
            parts.append(json.dumps(spec, ensure_ascii=False, indent=2))
        parts.append(tool_call_instruction())
    return "\n\n".join(parts)
