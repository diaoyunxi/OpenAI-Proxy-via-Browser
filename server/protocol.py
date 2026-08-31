# -*- coding: utf-8 -*-
"""网关（Python）与 Chrome 扩展之间的 WebSocket 消息协议定义。

协议版本：1
传输方式：JSON 文本帧，每条消息必须携带 ``v`` 与 ``type`` 字段。

消息方向约定：
    - ``C2G_*``：扩展（Client）发往网关（Gateway）
    - ``G2C_*``：网关（Gateway）发往扩展（Client）
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger("oap.protocol")

PROTOCOL_VERSION = 1

# ------------------------------ 扩展 -> 网关 ------------------------------
C2G_HELLO = "hello"            # 连接握手，携带客户端信息
C2G_HEARTBEAT = "heartbeat"    # 心跳回应
C2G_ACCEPTED = "accepted"      # 任务已被页面接受
C2G_CHUNK = "chunk"            # 增量文本
C2G_DONE = "done"              # 任务完成，携带完整文本
C2G_ERROR = "error"            # 任务失败，携带错误码与描述
C2G_LOG = "log"                # 调试日志（仅记录，不影响任务状态）

# ------------------------------ 网关 -> 扩展 ------------------------------
G2C_WELCOME = "welcome"        # 握手应答
G2C_PING = "ping"              # 心跳探测
G2C_EXECUTE = "execute"        # 派发一次对话任务
G2C_CANCEL = "cancel"          # 取消任务

# ------------------------------ 扩展上报错误码 ------------------------------
ERR_TAB_NOT_FOUND = "tab_not_found"
ERR_SELECTOR_MISSING = "selector_missing"
ERR_ELEMENT_TIMEOUT = "element_timeout"
ERR_INJECTION_FAILED = "injection_failed"
ERR_BUSY = "browser_busy"
ERR_INTERNAL = "internal_error"
ERR_INVALID_REQUEST = "invalid_request"

# ------------------------------ 网关侧错误码 ------------------------------
GW_ERR_NO_BROWSER = "browser_not_connected"
GW_ERR_TIMEOUT = "browser_timeout"
GW_ERR_BUSY = "browser_busy"
GW_ERR_CLIENT_GONE = "client_disconnected"
GW_ERR_INTERNAL = "internal_error"
GW_ERR_BAD_REQUEST = "invalid_request"

#: 错误码到 HTTP 状态码的映射；未列出的按 500 处理
_ERROR_STATUS: dict[str, int] = {
    GW_ERR_NO_BROWSER: 503,
    GW_ERR_TIMEOUT: 504,
    GW_ERR_BUSY: 429,
    GW_ERR_CLIENT_GONE: 499,
    GW_ERR_INTERNAL: 500,
    GW_ERR_BAD_REQUEST: 400,
    ERR_TAB_NOT_FOUND: 503,
    ERR_SELECTOR_MISSING: 422,
    ERR_ELEMENT_TIMEOUT: 504,
    ERR_INJECTION_FAILED: 500,
    ERR_INVALID_REQUEST: 400,
}

#: 错误码到 OpenAI 错误类型字段的映射
_ERROR_TYPE: dict[str, str] = {
    GW_ERR_NO_BROWSER: "server_error",
    GW_ERR_TIMEOUT: "server_error",
    GW_ERR_BUSY: "rate_limit_error",
    GW_ERR_CLIENT_GONE: "server_error",
    GW_ERR_INTERNAL: "server_error",
    GW_ERR_BAD_REQUEST: "invalid_request_error",
    ERR_TAB_NOT_FOUND: "server_error",
    ERR_SELECTOR_MISSING: "invalid_request_error",
    ERR_ELEMENT_TIMEOUT: "server_error",
    ERR_INJECTION_FAILED: "server_error",
    ERR_INVALID_REQUEST: "invalid_request_error",
}


def parse_message(raw: str) -> dict[str, Any] | None:
    """解析扩展发来的 JSON 消息。

    :param raw: 原始文本帧
    :return: 解析成功且为 dict 时返回消息对象，否则返回 None
    """
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        logger.warning("收到无法解析的 WebSocket 消息：%r", raw[:200])
        return None
    if not isinstance(data, dict):
        logger.warning("收到非对象类型的 WebSocket 消息：%r", type(data).__name__)
        return None
    return data


def http_status_for(code: str | None) -> int:
    """根据错误码返回对应的 HTTP 状态码。

    :param code: 错误码，未知或为空时返回 500
    :return: HTTP 状态码
    """
    if not code:
        return 500
    return _ERROR_STATUS.get(code, 500)


def error_type_for(code: str | None) -> str:
    """根据错误码返回 OpenAI 错误体中的 type 字段。

    :param code: 错误码，未知或为空时返回 server_error
    :return: 错误类型字符串
    """
    if not code:
        return "server_error"
    return _ERROR_TYPE.get(code, "server_error")
