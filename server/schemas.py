# -*- coding: utf-8 -*-
"""OpenAI Chat Completions 接口的请求体数据模型。

采用宽松校验策略：未知字段一律放行，避免不同客户端的扩展参数导致 422。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ContentPart(BaseModel):
    """多模态消息中的一个内容片段，MVP 阶段仅解析文本片段。"""

    model_config = ConfigDict(extra="allow")

    type: str = "text"
    text: str | None = None


class ChatMessage(BaseModel):
    """单条对话消息。"""

    model_config = ConfigDict(extra="allow")

    role: str = "user"
    content: str | list[ContentPart | dict[str, Any]] | None = None
    name: str | None = None

    def content_text(self) -> str:
        """提取消息的纯文本内容。

        多模态内容（列表形式）只保留其中的文本片段，图片等非文本内容直接忽略。

        :return: 拼接后的文本；无内容时返回空字符串
        """
        if self.content is None:
            return ""
        if isinstance(self.content, str):
            return self.content
        parts: list[str] = []
        for part in self.content:
            if isinstance(part, ContentPart):
                if part.text:
                    parts.append(part.text)
            elif isinstance(part, dict):
                text = part.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)


class ChatCompletionRequest(BaseModel):
    """``POST /v1/chat/completions`` 的请求体。"""

    model_config = ConfigDict(extra="allow")

    model: str = "browser-proxy"
    messages: list[ChatMessage] = Field(default_factory=list)
    stream: bool = False
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None
    stop: str | list[str] | None = None
    user: str | None = None
