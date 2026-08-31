# -*- coding: utf-8 -*-
"""OpenAI-Proxy-via-Browser 网关服务入口。

启动方式：
    uvicorn main:app --host 0.0.0.0 --port 8080
或：
    python main.py
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from bridge import (
    BrowserBridge,
    BrowserUnavailableError,
    ClientDisconnectedError,
    TaskFailedError,
    TaskTimeoutError,
)
from config import CONFIG
from openai_compat import (
    SSE_DONE,
    SSE_PING,
    build_error,
    chunk_payload,
    completion_payload,
    estimate_tokens,
    make_id,
    now_seconds,
    sse_error_frame,
    sse_frame,
)
from protocol import (
    ERR_INVALID_REQUEST,
    PROTOCOL_VERSION,
    error_type_for,
    http_status_for,
)
from schemas import ChatCompletionRequest

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
logger = logging.getLogger("oap.gateway")

#: 请求头：用于指定目标站点（优先于 model 字段中的 site: 前缀）
HEADER_TARGET_HOST = "x-oap-host"
#: 请求头：用于覆盖默认超时（秒）
HEADER_TIMEOUT = "x-oap-timeout"

bridge = BrowserBridge(CONFIG)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """应用生命周期管理：启动时拉起桥接层，关闭时回收资源。"""
    CONFIG.validate()
    await bridge.start()
    logger.info("网关已启动：http://%s:%s", CONFIG.host, CONFIG.port)
    try:
        yield
    finally:
        await bridge.stop()
        logger.info("网关已停止")


app = FastAPI(
    title="OpenAI-Proxy-via-Browser",
    version="0.1.0",
    description="通过 Chrome 扩展驱动浏览器网页，对外提供 OpenAI 兼容的 Chat Completions 接口。",
    lifespan=lifespan,
)

if CONFIG.allow_cors_any:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )


def build_prompt(request: ChatCompletionRequest) -> str:
    """把 messages 数组拼成一段可直接粘贴进网页输入框的文本。

    :param request: 客户端请求体
    :return: 拼接后的提示词；无有效内容时返回空串
    """
    if not request.messages:
        return ""
    if CONFIG.prompt_mode == "last_user":
        for message in reversed(request.messages):
            if message.role == "user":
                return message.content_text()
        return ""

    blocks: list[str] = []
    for message in request.messages:
        content = message.content_text()
        if not content:
            continue
        if message.role == "system":
            blocks.append(f"[系统指令]\n{content}")
        elif message.role == "assistant":
            blocks.append(f"[历史回复]\n{content}")
        else:
            blocks.append(f"[用户]\n{content}")
    return "\n\n".join(blocks)


def resolve_target_host(request: ChatCompletionRequest, headers: Any) -> str:
    """解析目标站点域名。

    优先级：请求头 ``X-OAP-Host`` > ``model`` 字段中的 ``site:<host>`` 前缀 > 空串（由扩展自行选择标签页）。

    :param request: 客户端请求体
    :param headers: 请求头对象
    :return: 目标域名，可能为空串
    """
    header_host = (headers.get(HEADER_TARGET_HOST) or "").strip()
    if header_host:
        return header_host
    model = (request.model or "").strip()
    if model.lower().startswith("site:"):
        return model[5:].strip()
    return ""


def resolve_timeout(headers: Any) -> float:
    """解析本次请求的超时时间。

    :param headers: 请求头对象
    :return: 超时秒数，非法值回退到全局配置
    """
    raw = (headers.get(HEADER_TIMEOUT) or "").strip()
    if not raw:
        return CONFIG.request_timeout
    try:
        value = float(raw)
    except ValueError:
        return CONFIG.request_timeout
    return min(max(value, 5.0), 3600.0)


def build_profile(host: str) -> dict[str, Any]:
    """构造下发给扩展的站点配置。

    MVP 阶段选择器完全由扩展本地存储提供，网关只负责指定目标站点。

    :param host: 目标域名，可为空
    :return: 站点配置字典
    """
    return {"host": host}


def error_response(code: str | None, message: str) -> JSONResponse:
    """构造 OpenAI 风格的错误响应。

    :param code: 错误码
    :param message: 错误描述
    :return: 带正确状态码的 JSON 响应
    """
    return JSONResponse(
        status_code=http_status_for(code),
        content=build_error(message=message, error_type=error_type_for(code), code=code),
    )


@app.get("/health")
async def health() -> dict[str, Any]:
    """健康检查与运行状态查询。"""
    status = bridge.status()
    status["status"] = "ok" if status["browser_connected"] else "waiting_browser"
    status["protocol_version"] = PROTOCOL_VERSION
    status["version"] = app.version
    return status


@app.get("/v1/models")
async def list_models() -> dict[str, Any]:
    """返回可用模型列表（MVP 仅提供一个浏览器代理别名）。"""
    created = now_seconds()
    return {
        "object": "list",
        "data": [
            {
                "id": CONFIG.default_model,
                "object": "model",
                "created": created,
                "owned_by": "openai-proxy-via-browser",
            }
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Any:
    """OpenAI 兼容的对话补全端点，支持流式与非流式两种模式。"""
    try:
        payload = await request.json()
    except Exception:
        return error_response(ERR_INVALID_REQUEST, "请求体不是合法的 JSON")

    if not isinstance(payload, dict):
        return error_response(ERR_INVALID_REQUEST, "请求体必须是一个 JSON 对象")

    try:
        chat_request = ChatCompletionRequest.model_validate(payload)
    except Exception as exc:
        return error_response(ERR_INVALID_REQUEST, f"请求参数校验失败：{exc}")

    prompt = build_prompt(chat_request)
    if not prompt.strip():
        return error_response(ERR_INVALID_REQUEST, "messages 中没有可发送的文本内容")

    host = resolve_target_host(chat_request, request.headers)
    profile = build_profile(host)
    timeout = resolve_timeout(request.headers)
    prompt_tokens = estimate_tokens(prompt)
    completion_id = make_id()
    created = now_seconds()
    model = chat_request.model or CONFIG.default_model

    def disconnect_checker() -> Any:
        return request.is_disconnected()

    try:
        if chat_request.stream:
            return StreamingResponse(
                stream_response(
                    profile=profile,
                    prompt=prompt,
                    model=model,
                    timeout=timeout,
                    completion_id=completion_id,
                    created=created,
                    disconnect_checker=disconnect_checker,
                ),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

        handle = await bridge.submit(
            profile=profile,
            prompt=prompt,
            model=model,
            timeout=timeout,
            disconnect_checker=disconnect_checker,
        )
        return JSONResponse(
            content=completion_payload(
                model=model,
                completion_id=completion_id,
                created=created,
                content=handle.text,
                finish_reason=handle.finish_reason,
                prompt_tokens=prompt_tokens,
            )
        )
    except ClientDisconnectedError:
        logger.info("客户端在等待期间断开：%s", completion_id)
        return JSONResponse(status_code=499, content=build_error(message="客户端已断开连接", code="client_disconnected"))
    except BrowserUnavailableError as exc:
        return error_response(getattr(exc, "code", None), str(exc))
    except TaskTimeoutError as exc:
        return error_response(getattr(exc, "code", None), str(exc))
    except TaskFailedError as exc:
        return error_response(exc.code, exc.message)
    except Exception as exc:  # 兜底：避免把原始异常抛给调用方
        logger.exception("处理请求时发生未预期异常：%s", exc)
        return error_response(None, "网关内部错误，请查看服务端日志")


async def stream_response(
    *,
    profile: dict[str, Any],
    prompt: str,
    model: str,
    timeout: float,
    completion_id: str,
    created: int,
    disconnect_checker: Any,
) -> AsyncIterator[str]:
    """流式响应生成器：把浏览器增量实时包装成 SSE 帧。

    注意：一旦开始产出，HTTP 状态码已锁定为 200，此后发生的错误只能在流内
    以错误帧的形式表达。

    :param profile: 站点配置
    :param prompt: 待发送文本
    :param model: 回显模型名
    :param timeout: 总超时（秒）
    :param completion_id: 本次对话 id
    :param created: 创建时间戳
    :param disconnect_checker: 客户端断开检测函数
    :return: SSE 文本片段迭代器
    """
    try:
        async with bridge.task_session(
            profile=profile,
            prompt=prompt,
            model=model,
            timeout=timeout,
            disconnect_checker=disconnect_checker,
        ) as (handle, waiter):
            # 首块必须携带 role，否则部分 OpenAI SDK 无法正确初始化消息角色
            yield sse_frame(
                chunk_payload(
                    model=model,
                    completion_id=completion_id,
                    created=created,
                    content="",
                    with_role=True,
                )
            )

            while True:
                try:
                    item = await asyncio.wait_for(handle.queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    if waiter.done():
                        break  # 任务已结束且队列已空
                    if await _check_disconnected(disconnect_checker):
                        logger.info("流式响应期间客户端断开：%s", completion_id)
                        return
                    yield SSE_PING
                    continue

                if item is None:  # 结束哨兵
                    break
                yield sse_frame(chunk_payload(model=model, completion_id=completion_id, created=created, content=item))

            # 任务失败（超时 / 断连 / 浏览器报错）时在此抛出，由下方转换成流内错误帧
            await waiter

            yield sse_frame(
                chunk_payload(
                    model=model,
                    completion_id=completion_id,
                    created=created,
                    finish_reason=handle.finish_reason,
                )
            )
            yield SSE_DONE
    except ClientDisconnectedError:
        return
    except (TaskTimeoutError, BrowserUnavailableError, TaskFailedError) as exc:
        code = getattr(exc, "code", None)
        yield sse_error_frame(str(exc), error_type_for(code), code)
        yield SSE_DONE
    except Exception as exc:  # 兜底：保证流一定以 [DONE] 收尾，避免客户端挂死
        logger.exception("流式响应异常：%s", exc)
        yield sse_error_frame("网关内部错误，请查看服务端日志")
        yield SSE_DONE


async def _check_disconnected(checker: Any) -> bool:
    """检测客户端是否已断开。"""
    try:
        result = checker()
        if asyncio.iscoroutine(result):
            result = await result
        return bool(result)
    except Exception:
        return False


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """与 Chrome 扩展通信的 WebSocket 端点。"""
    await websocket.accept()
    session_id = await bridge.register(websocket)
    if session_id is None:
        try:
            await websocket.close(code=4000, reason="handshake failed")
        except RuntimeError:
            pass
        return

    try:
        while True:
            raw = await websocket.receive_text()
            await bridge.handle_message(session_id, raw)
    except WebSocketDisconnect:
        logger.info("扩展断开连接：%s", session_id)
    except Exception as exc:
        logger.exception("WebSocket 处理异常（session=%s）：%s", session_id, exc)
    finally:
        await bridge.unregister(session_id)


@app.post("/v1/cancel/{request_id}")
async def cancel_request(request_id: str) -> dict[str, Any]:
    """请求取消在途任务（尽力而为，浏览器侧可能已经完成）。

    :param request_id: 任务 id
    :return: 操作结果
    """
    sent = await bridge.request_cancel(request_id)
    return {"ok": sent, "request_id": request_id}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=CONFIG.host, port=CONFIG.port, log_level="info")
