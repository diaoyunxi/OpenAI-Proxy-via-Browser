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
from prompt_files import ensure_prompt_files, load_system_prompt, render_prompt_template
from protocol import (
    ERR_INVALID_REQUEST,
    PROTOCOL_VERSION,
    error_type_for,
    http_status_for,
)
from schemas import ChatCompletionRequest

logging.basicConfig(
    level=logging.DEBUG,
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
    """应用生命周期管理：启动时补齐提示词文件并拉起桥接层，关闭时回收资源。"""
    CONFIG.validate()
    ensure_prompt_files()
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

    文本的最终结构由仓库根目录的 ``prompt_template.txt`` 决定（支持
    ``{system}`` / ``{user}`` 占位符与 ``{{#system}}`` / ``{{#user}}`` 条件块），
    修改该文件后下一次请求即生效，无需重启网关；文件缺失或为空时回退到内置的
    等价模板（XML 标签包裹，避免裸前缀如 ``[用户]`` 被模型当成内容）。

    取值规则：
      - 所有 ``role: system`` 消息合并为 ``{system}``；
      - 用户与助手消息按 ``prompt_mode`` 合并为 ``{user}``；
      - 请求未携带任何 system 消息时，自动注入 ``system_prompt.txt`` 的内容
        （该文件留空则表示不注入）。

    :param request: 客户端请求体
    :return: 拼接后的提示词；无有效内容时返回空串
    """
    if not request.messages:
        return ""

    system_parts: list[str] = []
    user_parts: list[str] = []
    for message in request.messages:
        content = message.content_text()
        if not content:
            continue
        if message.role == "system":
            system_parts.append(content)
        else:
            user_parts.append(content)

    if CONFIG.prompt_mode == "last_user":
        # 只取最后一条用户消息作为 <user> 内容
        last_user = ""
        for message in reversed(request.messages):
            if message.role == "user":
                last_user = message.content_text()
                break
        user_parts = [last_user] if last_user else []

    if not any(part.strip() for part in user_parts):
        # 没有任何用户/助手内容，本次请求无实际内容可发送
        return ""

    if not system_parts:
        # 请求未指定系统提示词时，注入默认提示词（文件为空则不注入）
        default_system = load_system_prompt()
        if default_system:
            system_parts.append(default_system)

    return render_prompt_template("\n\n".join(system_parts), "\n\n".join(user_parts))


def resolve_target_host(request: ChatCompletionRequest, headers: Any) -> str:
    """解析目标站点域名。

    模型由后台网页决定，不再从 ``model`` 字段解析 ``site:`` 前缀。
    仅支持请求头 ``X-OAP-Host`` 显式指定；未指定时返回空串，由扩展自行
    按已知 AI 站点选择标签页。

    :param request: 客户端请求体（未使用，保留签名以便后续扩展）
    :param headers: 请求头对象
    :return: 目标域名，可能为空串
    """
    header_host = (headers.get(HEADER_TARGET_HOST) or "").strip()
    if header_host:
        return header_host
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
    """返回可用模型列表。

    模型由后台网页决定，网关只暴露一个固定的浏览器代理别名（可被
    ``OAP_MODELS`` 扩展），不随客户端请求动态路由。
    """
    created = now_seconds()
    return {
        "object": "list",
        "data": [
            {
                "id": mid,
                "object": "model",
                "created": created,
                "owned_by": "openai-proxy-via-browser",
            }
            for mid in CONFIG.models
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

    # 模型由后台网页决定，忽略客户端传入的 model 字段，统一回显默认别名。
    # 保留 chat_request.model 的解析仅为满足 OpenAI 请求体校验，不参与路由。
    model = CONFIG.default_model

    host = resolve_target_host(chat_request, request.headers)
    # host 为空时交由扩展按已知 AI 站点自行选择标签页（见 background.findTargetTab），
    # 此处不回填活动标签 host，避免把前台无关页面误当成目标。
    profile = build_profile(host)
    timeout = resolve_timeout(request.headers)
    prompt_tokens = estimate_tokens(prompt)
    completion_id = make_id()
    created = now_seconds()

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
        # 记录任务结果详情
        logger.info("任务完成: request_id=%s text_length=%d finish_reason=%s", handle.request_id, len(handle.text) if handle.text else 0, handle.finish_reason)
        if handle.tool_calls:
            logger.info("任务包含工具调用: %d 个", len(handle.tool_calls))
            logger.debug("工具调用详情: %r", handle.tool_calls)
        response_data = completion_payload(
            model=model,
            completion_id=completion_id,
            created=created,
            content=handle.text,
            finish_reason=handle.finish_reason if not handle.tool_calls else "tool_calls",
            prompt_tokens=prompt_tokens,
            tool_calls=handle.tool_calls,
        )
        logger.info("返回给客户端: model=%s finish_reason=%s tool_calls_count=%d content_length=%d", model, response_data["choices"][0]["finish_reason"], len(response_data.get("choices", [{}])[0].get("message", {}).get("tool_calls") or []), len(response_data["choices"][0]["message"].get("content") or ""))
        return JSONResponse(content=response_data)
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
                # CRX 已改为攒完整结果后一次性回传，正常不会收到增量块；
                # 若仍有增量（防御性），逐块透传。
                yield sse_frame(chunk_payload(model=model, completion_id=completion_id, created=created, content=item))

            # 任务失败（超时 / 断连 / 浏览器报错）时在此抛出，由下方转换成流内错误帧
            await waiter

            # CRX 不在过程中回传增量，此处把完整结果作为单个 delta 一次性发出。
            # 若命中工具调用，则按 OpenAI 规范发出 tool_calls（content 为 null）。
            if handle.tool_calls:
                yield sse_frame(
                    chunk_payload(
                        model=model,
                        completion_id=completion_id,
                        created=created,
                        with_role=True,
                    )
                )
                yield sse_frame(
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"tool_calls": handle.tool_calls},
                                "logprobs": None,
                                "finish_reason": "tool_calls",
                            }
                        ],
                        "system_fingerprint": "fp_browser_proxy",
                    }
                )
            elif handle.text:
                yield sse_frame(
                    chunk_payload(
                        model=model,
                        completion_id=completion_id,
                        created=created,
                        content=handle.text,
                    )
                )

            yield sse_frame(
                chunk_payload(
                    model=model,
                    completion_id=completion_id,
                    created=created,
                    finish_reason=handle.finish_reason if not handle.tool_calls else "tool_calls",
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
