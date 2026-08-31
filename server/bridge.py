# -*- coding: utf-8 -*-
"""浏览器桥接层：管理 WebSocket 连接池、任务派发、流式回传与超时控制。

设计要点：
    1. 一个扩展实例对应一条 WebSocket 连接，MVP 阶段同一时刻只允许一个
       浏览器任务在执行，因此用 asyncio.Lock 串行化（天然实现排队）。
    2. 每个外部请求对应一个 TaskHandle，扩展回传的增量文本写入队列，
       由 HTTP 端点按需消费（流式逐块转发 / 非流式拼接后返回）。
    3. 所有异常都转换为带错误码的异常对象，交给上层映射成 OpenAI 错误体。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable

from fastapi import WebSocket, WebSocketDisconnect
from fastapi.websockets import WebSocketState

from config import GatewayConfig
from protocol import (
    C2G_ACCEPTED,
    C2G_CHUNK,
    C2G_DONE,
    C2G_ERROR,
    C2G_HEARTBEAT,
    C2G_HELLO,
    C2G_LOG,
    ERR_INTERNAL,
    G2C_CANCEL,
    G2C_EXECUTE,
    G2C_PING,
    G2C_WELCOME,
    GW_ERR_CLIENT_GONE,
    GW_ERR_NO_BROWSER,
    GW_ERR_TIMEOUT,
    PROTOCOL_VERSION,
    parse_message,
)

logger = logging.getLogger("oap.bridge")

#: 等待浏览器首个字节的额外宽限（在总超时之上不再叠加，仅用于日志提示）
_HEARTBEAT_CHECK_INTERVAL = 1.0


class BrowserUnavailableError(Exception):
    """浏览器扩展未连接或已断开。"""

    code = GW_ERR_NO_BROWSER


class TaskTimeoutError(Exception):
    """浏览器在规定时间内未完成任务。"""

    code = GW_ERR_TIMEOUT

    def __init__(self, message: str = "浏览器未在超时时间内返回结果") -> None:
        super().__init__(message)


class TaskFailedError(Exception):
    """浏览器侧主动报告任务失败。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ClientDisconnectedError(Exception):
    """调用方在等待过程中主动断开。"""

    code = GW_ERR_CLIENT_GONE

    def __init__(self, message: str = "客户端已断开连接") -> None:
        super().__init__(message)


@dataclass
class TaskHandle:
    """一次对话任务的内部句柄，承载流式增量与完成状态。"""

    request_id: str
    model: str
    created: int
    queue: asyncio.Queue[str | None] = field(default_factory=asyncio.Queue)
    event: asyncio.Event = field(default_factory=asyncio.Event)
    chunks: list[str] = field(default_factory=list)
    text: str = ""
    finish_reason: str = "stop"
    tool_calls: list[dict[str, Any]] | None = None
    error_code: str | None = None
    error_message: str | None = None
    accepted: bool = False

    def feed(self, text: str) -> None:
        """写入一段增量文本。

        :param text: 增量内容，空串会被忽略
        """
        if not text:
            return
        self.chunks.append(text)
        self.queue.put_nowait(text)

    def finish(self, text: str | None = None, finish_reason: str = "stop") -> None:
        """标记任务完成。

        :param text: 浏览器回传的完整文本；为 None 时用已收到的增量拼接
        :param finish_reason: 结束原因
        """
        if text is not None:
            self.text = text
        else:
            self.text = "".join(self.chunks)
        self.finish_reason = finish_reason
        self._settle()

    def fail(self, code: str, message: str) -> None:
        """标记任务失败。

        :param code: 错误码
        :param message: 错误描述
        """
        self.error_code = code
        self.error_message = message
        self.text = "".join(self.chunks)
        self._settle()

    def _settle(self) -> None:
        """统一唤醒等待方：放入结束哨兵并设置事件。"""
        self.queue.put_nowait(None)
        self.event.set()

    @property
    def ok(self) -> bool:
        """任务是否成功完成。"""
        return self.error_code is None


@dataclass
class ClientConn:
    """一条已建立的扩展连接。"""

    session_id: str
    websocket: WebSocket
    client_id: str = ""
    tab_url: str = ""
    tab_title: str = ""
    connected_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)

    async def send_json(self, payload: dict[str, Any]) -> bool:
        """向扩展发送一条 JSON 消息。

        :param payload: 待发送消息
        :return: 发送成功返回 True，连接已关闭返回 False
        """
        if self.websocket.client_state != WebSocketState.CONNECTED:
            return False
        try:
            await self.websocket.send_json(payload)
            return True
        except (WebSocketDisconnect, RuntimeError) as exc:
            logger.warning("向扩展 %s 发送消息失败：%s", self.session_id, exc)
            return False


class BrowserBridge:
    """浏览器连接池与任务调度中心。"""

    def __init__(self, config: GatewayConfig) -> None:
        """初始化桥接层。

        :param config: 网关配置
        """
        self._config = config
        self._conns: dict[str, ClientConn] = {}
        self._tasks: dict[str, TaskHandle] = {}
        self._active: ClientConn | None = None
        self._lock = asyncio.Lock()
        self._heartbeat_task: asyncio.Task | None = None

    # ------------------------------------------------------------------ 生命周期

    async def start(self) -> None:
        """启动后台心跳任务。"""
        if self._heartbeat_task is None or self._heartbeat_task.done():
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(), name="oap-heartbeat")

    async def stop(self) -> None:
        """停止后台任务并清理全部在途任务。"""
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
        self._heartbeat_task = None
        for request_id in list(self._tasks):
            self._tasks[request_id].fail(GW_ERR_NO_BROWSER, "网关正在关闭")
        self._conns.clear()
        self._active = None

    async def _heartbeat_loop(self) -> None:
        """周期性向所有连接发送 ping，并清理长时间无响应的连接。"""
        interval = self._config.heartbeat_interval
        while True:
            try:
                await asyncio.sleep(interval)
                stale: list[str] = []
                for session_id, conn in list(self._conns.items()):
                    idle = time.time() - conn.last_seen
                    if idle > interval * 3:
                        stale.append(session_id)
                        continue
                    await conn.send_json({"v": PROTOCOL_VERSION, "type": G2C_PING, "ts": int(time.time() * 1000)})
                for session_id in stale:
                    logger.warning("扩展 %s 长时间无响应，主动清理", session_id)
                    await self.unregister(session_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # 防御：心跳异常不应导致服务中断
                logger.exception("心跳循环异常：%s", exc)

    # ------------------------------------------------------------------ 连接管理

    async def register(self, websocket: WebSocket) -> str | None:
        """完成与扩展的握手并登记连接。

        :param websocket: 已 accept 的 WebSocket 连接
        :return: 成功返回 session_id；握手超时或协议不符返回 None
        """
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=self._config.hello_timeout)
        except (asyncio.TimeoutError, WebSocketDisconnect):
            logger.warning("扩展握手超时或连接已断开")
            return None

        message = parse_message(raw)
        if not message or message.get("type") != C2G_HELLO:
            logger.warning("扩展握手消息不合法：%r", (raw or "")[:200])
            return None

        session_id = uuid.uuid4().hex
        tab = message.get("tab") if isinstance(message.get("tab"), dict) else {}
        conn = ClientConn(
            session_id=session_id,
            websocket=websocket,
            client_id=str(message.get("client_id") or ""),
            tab_url=str(tab.get("url") or ""),
            tab_title=str(tab.get("title") or ""),
        )
        self._conns[session_id] = conn
        self._active = conn  # MVP：后建立的连接接管为活动连接
        logger.info("扩展已连接：session=%s tab=%s", session_id, conn.tab_url or "<未知>")

        await conn.send_json(
            {
                "v": PROTOCOL_VERSION,
                "type": G2C_WELCOME,
                "session_id": session_id,
                "heartbeat_ms": int(self._config.heartbeat_interval * 1000),
                "request_timeout_ms": int(self._config.request_timeout * 1000),
            }
        )
        return session_id

    async def unregister(self, session_id: str) -> None:
        """移除连接并把其在途任务置为失败。

        :param session_id: 需要移除的连接 id
        """
        conn = self._conns.pop(session_id, None)
        if conn is None:
            return
        logger.info("扩展已断开：session=%s", session_id)
        for handle in list(self._tasks.values()):
            if not handle.event.is_set():
                handle.fail(GW_ERR_NO_BROWSER, "浏览器扩展已断开连接")
        if self._active is conn:
            self._active = next(iter(self._conns.values()), None)

    @property
    def connected(self) -> bool:
        """是否存在可用的扩展连接。"""
        return self._active is not None

    def active_tab_host(self) -> str:
        """返回活动连接所在标签页的域名（host）。

        当客户端未显式指定目标站点时，用扩展握手上报的活动标签页域名作为
        默认目标，避免把前台无关页面（如视频站）误当成任务目标。

        :return: 目标域名，无连接或无法解析时返回空串
        """
        if not self._active:
            return ""
        try:
            from urllib.parse import urlparse

            return urlparse(self._active.tab_url).hostname or ""
        except Exception:
            return ""

    def status(self) -> dict[str, Any]:
        """返回桥接层运行状态，供 /health 使用。"""
        conn = self._active
        return {
            "browser_connected": conn is not None,
            "connections": len(self._conns),
            "pending_tasks": len(self._tasks),
            "client_id": conn.client_id if conn else None,
            "tab_url": conn.tab_url if conn else None,
            "tab_title": conn.tab_title if conn else None,
            "connected_at": conn.connected_at if conn else None,
            "last_seen": conn.last_seen if conn else None,
        }

    # ------------------------------------------------------------------ 消息处理

    async def handle_message(self, session_id: str, raw: str) -> None:
        """处理扩展发来的一条消息。

        :param session_id: 来源连接 id
        :param raw: 原始文本帧
        """
        conn = self._conns.get(session_id)
        if conn is not None:
            conn.last_seen = time.time()

        message = parse_message(raw)
        if not message:
            return

        msg_type = message.get("type")
        request_id = str(message.get("request_id") or "")
        handle = self._tasks.get(request_id)

        if msg_type in (C2G_HEARTBEAT, C2G_HELLO):
            return
        if msg_type == C2G_LOG:
            logger.info("[扩展] %s", message.get("message"))
            return
        if msg_type == C2G_ACCEPTED:
            if handle:
                handle.accepted = True
            return

        if handle is None:
            logger.warning("收到未知 request_id 的消息：type=%s id=%s", msg_type, request_id or "<空>")
            return

        if msg_type == C2G_CHUNK:
            text = message.get("text")
            if isinstance(text, str):
                handle.feed(text)
            return
        if msg_type == C2G_DONE:
            text = message.get("text")
            reason = str(message.get("finish_reason") or "stop")
            tool_calls = message.get("tool_calls")
            if isinstance(tool_calls, list):
                handle.tool_calls = tool_calls
            handle.finish(text if isinstance(text, str) else None, reason)
            return
        if msg_type == C2G_ERROR:
            handle.fail(
                str(message.get("code") or ERR_INTERNAL),
                str(message.get("message") or "浏览器侧任务失败"),
            )
            return

        logger.warning("收到未处理的消息类型：%s", msg_type)

    # ------------------------------------------------------------------ 任务派发

    @asynccontextmanager
    async def task_session(
        self,
        *,
        profile: dict[str, Any],
        prompt: str,
        model: str,
        timeout: float,
        disconnect_checker: Callable[[], Any] | None = None,
    ) -> AsyncIterator[tuple[TaskHandle, asyncio.Task[None]]]:
        """开启一次对话任务会话：派发任务并返回句柄与等待协程。

        以异步上下文管理器形式提供，确保无论调用方正常结束还是异常退出，
        执行锁、在途任务登记与后台等待协程都能被可靠回收。

        :param profile: 站点配置（host、各类选择器）
        :param prompt: 需要填入网页输入框的文本
        :param model: 回显用的模型名
        :param timeout: 总超时（秒）
        :param disconnect_checker: 用于检测调用方是否已断开的可调用对象（同步或协程）
        :return: 产出 ``(任务句柄, 等待协程)`` 的异步迭代器
        :raises BrowserUnavailableError: 扩展未连接或连接丢失
        :raises TaskFailedError: 排队等待超时
        """
        if not self.connected:
            raise BrowserUnavailableError("浏览器扩展未连接，请先在 Chrome 中加载扩展并打开目标站点")

        try:
            await asyncio.wait_for(self._lock.acquire(), timeout=self._config.queue_wait)
        except asyncio.TimeoutError as exc:
            raise TaskFailedError(GW_ERR_NO_BROWSER, "浏览器正忙，排队等待超时") from exc

        handle: TaskHandle | None = None
        waiter: asyncio.Task[None] | None = None
        try:
            conn = self._active
            if conn is None:
                raise BrowserUnavailableError("浏览器扩展连接已丢失")

            request_id = f"req-{uuid.uuid4().hex}"
            handle = TaskHandle(request_id=request_id, model=model, created=int(time.time()))
            self._tasks[request_id] = handle

            sent = await conn.send_json(
                {
                    "v": PROTOCOL_VERSION,
                    "type": G2C_EXECUTE,
                    "request_id": request_id,
                    "prompt": prompt,
                    "profile": profile,
                    "timeout_ms": int(timeout * 1000),
                }
            )
            if not sent:
                raise BrowserUnavailableError("浏览器扩展连接已丢失，任务未能下发")

            logger.info("任务已派发：%s host=%s", request_id, profile.get("host") or "<默认>")
            waiter = asyncio.create_task(
                self._await_finish(handle, timeout, disconnect_checker),
                name=f"oap-wait-{request_id}",
            )
            yield handle, waiter
        finally:
            if waiter is not None:
                if not waiter.done():
                    waiter.cancel()
                # 吸收等待协程的异常，避免 asyncio 报告“异常从未被取回”
                try:
                    await waiter
                except (asyncio.CancelledError, Exception):
                    pass
            if handle is not None:
                self._tasks.pop(handle.request_id, None)
            self._lock.release()

    async def submit(
        self,
        *,
        profile: dict[str, Any],
        prompt: str,
        model: str,
        timeout: float,
        disconnect_checker: Callable[[], Any] | None = None,
    ) -> TaskHandle:
        """派发一次对话任务并阻塞等待其完成（非流式场景使用）。

        :param profile: 站点配置（host、各类选择器）
        :param prompt: 需要填入网页输入框的文本
        :param model: 回显用的模型名
        :param timeout: 总超时（秒）
        :param disconnect_checker: 用于检测调用方是否已断开的可调用对象
        :return: 已完成的任务句柄
        :raises BrowserUnavailableError: 扩展未连接
        :raises TaskTimeoutError: 等待超时
        :raises TaskFailedError: 浏览器侧报错
        :raises ClientDisconnectedError: 调用方断开
        """
        async with self.task_session(
            profile=profile,
            prompt=prompt,
            model=model,
            timeout=timeout,
            disconnect_checker=disconnect_checker,
        ) as (handle, waiter):
            await waiter
            return handle

    async def request_cancel(self, request_id: str) -> bool:
        """向扩展下发取消指令（尽力而为）。

        :param request_id: 任务 id
        :return: 指令是否成功送达
        """
        conn = self._active
        if conn is None:
            return False
        return await conn.send_json({"v": PROTOCOL_VERSION, "type": G2C_CANCEL, "request_id": request_id})

    async def _await_finish(
        self,
        handle: TaskHandle,
        timeout: float,
        disconnect_checker: Callable[[], Any] | None,
    ) -> None:
        """等待任务完成，期间周期性检查超时与调用方断开。

        :param handle: 任务句柄
        :param timeout: 总超时（秒）
        :param disconnect_checker: 调用方断开检测函数
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout

        while not handle.event.is_set():
            remaining = deadline - loop.time()
            if remaining <= 0:
                handle.fail(GW_ERR_TIMEOUT, "浏览器响应超时")
                break
            try:
                await asyncio.wait_for(handle.event.wait(), timeout=min(remaining, _HEARTBEAT_CHECK_INTERVAL))
            except asyncio.TimeoutError:
                pass
            if disconnect_checker is not None and await self._is_disconnected(disconnect_checker):
                raise ClientDisconnectedError()

        if handle.error_code == GW_ERR_TIMEOUT:
            raise TaskTimeoutError(handle.error_message or "浏览器未在超时时间内返回结果")
        if handle.error_code == GW_ERR_NO_BROWSER:
            raise BrowserUnavailableError(handle.error_message or "浏览器扩展已断开连接")
        if handle.error_code:
            raise TaskFailedError(handle.error_code, handle.error_message or "浏览器侧任务失败")

    @staticmethod
    async def _is_disconnected(checker: Callable[[], Any]) -> bool:
        """统一处理同步/异步两种断开检测函数。

        :param checker: 检测函数
        :return: 已断开返回 True；检测本身异常时按未断开处理
        """
        try:
            result = checker()
            if asyncio.iscoroutine(result):
                result = await result
            return bool(result)
        except Exception:  # 检测失败不应中断任务
            return False
