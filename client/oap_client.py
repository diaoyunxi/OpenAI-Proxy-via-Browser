"""零依赖的 OpenAI-Proxy 网关客户端。

使用标准库 ``urllib`` 直接调用网关的 OpenAI 兼容接口：
  - ``GET  /health``
  - ``GET  /v1/models``
  - ``POST /v1/chat/completions`` （支持 stream / 自定义头）
  - ``POST /v1/cancel/{request_id}``

设计原则：零第三方依赖（不依赖 ``requests`` / ``openai``），便于在受限环境直接使用。
"""
from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any, Dict, Iterator, List, Optional

from .sse import iter_sse_events

DEFAULT_BASE_URL = "http://127.0.0.1:8080"
DEFAULT_MODEL = "browser-proxy"
DEFAULT_TIMEOUT = 180


class OAPError(RuntimeError):
    """网关返回错误或网络异常时抛出。"""


class OAPClient:
    """OpenAI-Proxy 网关的轻量客户端。"""

    def __init__(self, base_url: str = DEFAULT_BASE_URL, timeout: int = DEFAULT_TIMEOUT,
                 default_host: Optional[str] = None, default_model: str = DEFAULT_MODEL):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.default_host = default_host
        self.default_model = default_model

    # ---- 底层请求 ----
    def _post(self, path: str, payload: Dict[str, Any],
              extra_headers: Optional[Dict[str, str]] = None, stream: bool = False):
        url = self.base_url + path
        data = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if stream else "application/json",
        }
        if extra_headers:
            headers.update(extra_headers)
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            return urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            raise OAPError(f"网关返回 HTTP {e.code}: {body[:300]}") from e
        except urllib.error.URLError as e:
            raise OAPError(f"无法连接网关 {url}: {e.reason}") from e
        except (TimeoutError, socket.timeout) as e:
            raise OAPError(
                f"网关请求超时（超过 {self.timeout} 秒未返回完整响应）。"
                "请确认目标浏览器扩展已就绪并正被正常调用，"
                "或适当调大 --timeout 后重试。"
            ) from e

    # ---- 高层接口 ----
    def health(self) -> Dict[str, Any]:
        """查询网关健康状态。"""
        req = urllib.request.Request(self.base_url + "/health", method="GET")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 - 统一转换为 OAPError
            raise OAPError(f"健康检查失败: {e}") from e

    def models(self) -> Dict[str, Any]:
        """获取模型列表。"""
        req = urllib.request.Request(self.base_url + "/v1/models", method="GET")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            raise OAPError(f"获取模型列表失败: {e}") from e

    def chat(self, messages: List[Dict[str, str]], *,
             model: Optional[str] = None, stream: bool = False,
             timeout: Optional[int] = None, host: Optional[str] = None,
             extra_headers: Optional[Dict[str, str]] = None) -> Any:
        """发起一次对话补全。

        ``stream=False`` 时返回完整响应 dict；``stream=True`` 时返回事件 dict 的生成器。
        """
        payload: Dict[str, Any] = {
            "model": model or self.default_model,
            "messages": messages,
            "stream": stream,
        }
        headers: Dict[str, str] = dict(extra_headers or {})
        eff_host = host or self.default_host
        if eff_host:
            headers["X-OAP-Host"] = eff_host
        if timeout is not None:
            headers["X-OAP-Timeout"] = str(timeout)
        resp = self._post("/v1/chat/completions", payload, extra_headers=headers, stream=stream)
        if stream:
            return iter_sse_events(resp)
        try:
            body = resp.read().decode("utf-8")
        except (TimeoutError, socket.timeout) as e:
            raise OAPError(
                f"网关响应读取超时（超过 {self.timeout} 秒）。"
                "请确认目标浏览器扩展已就绪并正被正常调用，"
                "或适当调大 --timeout 后重试。"
            ) from e
        try:
            return json.loads(body)
        except json.JSONDecodeError as e:
            raise OAPError(f"响应不是合法 JSON: {body[:200]}") from e

    def cancel(self, request_id: str) -> Dict[str, Any]:
        """取消一个正在进行的请求。"""
        url = f"{self.base_url}/v1/cancel/{request_id}"
        req = urllib.request.Request(url, method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            raise OAPError(f"取消请求失败: {e}") from e
