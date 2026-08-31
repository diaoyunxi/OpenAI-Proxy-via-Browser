# -*- coding: utf-8 -*-
"""OpenAI Chat Completions 响应格式的构造工具。

负责把浏览器侧拿到的纯文本，包装成 OpenAI 官方兼容的 JSON 或 SSE 帧。
"""

from __future__ import annotations

import json
import time
import unicodedata
import uuid
from typing import Any, Iterator

SSE_DONE = "data: [DONE]\n\n"
SSE_PING = ": ping\n\n"


def make_id(prefix: str = "chatcmpl") -> str:
    """生成一次对话的唯一标识。

    :param prefix: id 前缀，与 OpenAI 风格保持一致
    :return: 形如 ``chatcmpl-<hex>`` 的字符串
    """
    return f"{prefix}-{uuid.uuid4().hex[:24]}"


def now_seconds() -> int:
    """返回当前 Unix 时间戳（秒）。

    :return: 整数秒级时间戳
    """
    return int(time.time())


def is_cjk(ch: str) -> bool:
    """判断单个字符是否为中日韩表意文字。

    :param ch: 单个字符
    :return: 是 CJK 字符返回 True
    """
    try:
        name = unicodedata.name(ch)
    except ValueError:
        return False
    return "CJK UNIFIED IDEOGRAPH" in name or "HIRAGANA" in name or "KATAKANA" in name or "HANGUL" in name


def estimate_tokens(text: str | None) -> int:
    """粗略估算文本的 token 数量。

    浏览器侧拿不到真实 token 统计，这里用启发式规则：
    CJK 字符按每字约 0.7 token，其余字符按每 4 字符约 1 token。

    :param text: 待估算文本，允许为 None 或空串
    :return: 估算的 token 数量，最小为 0
    """
    if not text:
        return 0
    cjk = sum(1 for ch in text if is_cjk(ch))
    other = max(len(text) - cjk, 0)
    return max(int(cjk * 0.7 + other / 4.0), 0)


def completion_payload(
    *,
    model: str,
    completion_id: str,
    created: int,
    content: str,
    finish_reason: str = "stop",
    prompt_tokens: int = 0,
    completion_tokens: int | None = None,
) -> dict[str, Any]:
    """构造非流式响应体（object = chat.completion）。

    :param model: 回显给客户端的模型名
    :param completion_id: 本次对话 id
    :param created: 创建时间戳（秒）
    :param content: 助手完整回复文本
    :param finish_reason: 结束原因，如 stop / length
    :param prompt_tokens: 输入 token 估算值
    :param completion_tokens: 输出 token 估算值，为 None 时按 content 估算
    :return: OpenAI 兼容的响应字典
    """
    used_completion = estimate_tokens(content) if completion_tokens is None else completion_tokens
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "logprobs": None,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": used_completion,
            "total_tokens": prompt_tokens + used_completion,
        },
        "system_fingerprint": "fp_browser_proxy",
    }


def chunk_payload(
    *,
    model: str,
    completion_id: str,
    created: int,
    content: str | None = None,
    with_role: bool = False,
    finish_reason: str | None = None,
) -> dict[str, Any]:
    """构造流式响应中的单个 chunk（object = chat.completion.chunk）。

    :param model: 回显给客户端的模型名
    :param completion_id: 本次对话 id
    :param created: 创建时间戳（秒）
    :param content: 增量文本；为 None 时不包含 content 字段
    :param with_role: 是否在 delta 中携带 role（首块必须为 True）
    :param finish_reason: 结束原因，仅最后一块非 None
    :return: OpenAI 兼容的 chunk 字典
    """
    delta: dict[str, Any] = {}
    if with_role:
        delta["role"] = "assistant"
    if content is not None:
        delta["content"] = content
    return {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "logprobs": None,
                "finish_reason": finish_reason,
            }
        ],
        "system_fingerprint": "fp_browser_proxy",
    }


def sse_frame(payload: dict[str, Any]) -> str:
    """把响应对象序列化为一个 SSE 数据帧。

    :param payload: 待发送的对象
    :return: 形如 ``data: {...}\\n\\n`` 的字符串
    """
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_error_frame(message: str, error_type: str = "server_error", code: str | None = None) -> str:
    """构造流式场景下的错误帧（流已开始后无法再改状态码，只能在流内报错）。

    :param message: 错误描述
    :param error_type: OpenAI 错误类型
    :param code: 内部错误码
    :return: SSE 数据帧
    """
    return sse_frame(build_error(message=message, error_type=error_type, code=code))


def build_error(
    *,
    message: str,
    error_type: str = "server_error",
    code: str | None = None,
    param: str | None = None,
) -> dict[str, Any]:
    """构造 OpenAI 风格的错误响应体。

    :param message: 错误描述
    :param error_type: OpenAI 错误类型
    :param code: 内部错误码，便于排查
    :param param: 出错的参数名，无则为空
    :return: 错误响应字典
    """
    return {
        "error": {
            "message": message,
            "type": error_type,
            "param": param,
            "code": code,
        }
    }


def iter_text_chunks(text: str, size: int = 64) -> Iterator[str]:
    """把整段文本切成小片，用于非流式内容缺失时的模拟流式输出。

    :param text: 待切分文本
    :param size: 每片字符数，必须大于 0
    :return: 文本片段迭代器
    """
    if size <= 0:
        raise ValueError("size 必须大于 0")
    for start in range(0, len(text), size):
        yield text[start : start + size]
