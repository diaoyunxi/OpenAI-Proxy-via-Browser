# -*- coding: utf-8 -*-
"""网关服务的运行时配置。

所有配置项均支持通过环境变量覆盖，便于在不同机器上直接部署而无需修改代码。

作者：OpenAI-Proxy-via-Browser
协议版本：1
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _read_str(name: str, default: str) -> str:
    """读取字符串型配置。

    :param name: 环境变量名
    :param default: 未设置或为空时使用的默认值
    :return: 生效的配置值
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = raw.strip()
    return value if value else default


def _read_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """读取整数型配置，并夹取到合法区间，防止非法值导致运行异常。

    :param name: 环境变量名
    :param default: 未设置或解析失败时使用的默认值
    :param minimum: 允许的最小值
    :param maximum: 允许的最大值
    :return: 生效的配置值
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def _read_float(name: str, default: float, minimum: float, maximum: float) -> float:
    """读取浮点型配置，并夹取到合法区间。

    :param name: 环境变量名
    :param default: 未设置或解析失败时使用的默认值
    :param minimum: 允许的最小值
    :param maximum: 允许的最大值
    :return: 生效的配置值
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw.strip())
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def _read_bool(name: str, default: bool) -> bool:
    """读取布尔型配置，接受 1/true/yes/on/y 等常见写法。

    :param name: 环境变量名
    :param default: 未设置时使用的默认值
    :return: 生效的配置值
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on", "y"}


@dataclass(frozen=True)
class GatewayConfig:
    """网关服务的不可变配置集合。"""

    host: str
    port: int
    heartbeat_interval: float
    hello_timeout: float
    request_timeout: float
    queue_wait: float
    prompt_mode: str
    default_model: str
    allow_cors_any: bool

    @classmethod
    def from_env(cls) -> "GatewayConfig":
        """从环境变量构建配置对象。

        :return: 配置实例
        """
        return cls(
            host=_read_str("OAP_HOST", "0.0.0.0"),
            port=_read_int("OAP_PORT", 8080, 1, 65535),
            heartbeat_interval=_read_float("OAP_HEARTBEAT_SEC", 15.0, 5.0, 120.0),
            hello_timeout=_read_float("OAP_HELLO_TIMEOUT_SEC", 10.0, 3.0, 60.0),
            request_timeout=_read_float("OAP_REQUEST_TIMEOUT_SEC", 180.0, 10.0, 3600.0),
            queue_wait=_read_float("OAP_QUEUE_WAIT_SEC", 120.0, 1.0, 3600.0),
            prompt_mode=_read_str("OAP_PROMPT_MODE", "all").lower(),
            default_model=_read_str("OAP_DEFAULT_MODEL", "browser-proxy"),
            allow_cors_any=_read_bool("OAP_ALLOW_CORS_ANY", True),
        )

    def validate(self) -> None:
        """校验配置项取值是否合法，非法时抛出 ValueError。"""
        if self.prompt_mode not in {"all", "last_user"}:
            raise ValueError(f"OAP_PROMPT_MODE 仅支持 all / last_user，当前为 {self.prompt_mode!r}")
        if not 1 <= self.port <= 65535:
            raise ValueError(f"OAP_PORT 超出合法端口范围：{self.port}")


CONFIG = GatewayConfig.from_env()
