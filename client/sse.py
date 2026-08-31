"""零依赖的 SSE（Server-Sent Events）解析工具。

仅使用标准库，把 HTTP 响应体逐行解析为事件负载（dict）。
网关在流式响应中以 ``data: {json}`` 帧发送，结束帧为 ``data: [DONE]``。
"""
from __future__ import annotations

import json
from typing import Any, Dict, Iterator

SSE_DONE = "[DONE]"


def parse_sse_lines(stream) -> Iterator[str]:
    """从可读流（如 urllib 响应对象）逐行读取，产出每个 ``data:`` 之后的负载文本。

    自动跳过注释行（``:`` 开头）与空行，并处理跨分块的半行缓冲。
    """
    buffer = ""
    for raw in stream:
        if isinstance(raw, (bytes, bytearray)):
            raw = bytes(raw).decode("utf-8", errors="replace")
        buffer += raw
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.rstrip("\r")
            if not line or line.startswith(":"):
                continue
            if line.startswith("data:"):
                yield line[len("data:"):].lstrip()
    # 处理残留的最后一段（可能无结尾换行）
    if buffer.strip():
        line = buffer.rstrip("\r")
        if line.startswith("data:"):
            yield line[len("data:"):].lstrip()


def iter_sse_events(stream) -> Iterator[Dict[str, Any]]:
    """把 SSE 数据流解析为事件字典生成器，遇到 ``[DONE]`` 终止。"""
    for payload in parse_sse_lines(stream):
        if payload == SSE_DONE:
            return
        try:
            yield json.loads(payload)
        except json.JSONDecodeError:
            # 跳过无法解析的心跳/异常帧，不中断主流程
            continue
