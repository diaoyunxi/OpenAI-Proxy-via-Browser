"""OpenAI-Proxy 自研 agents 客户端（零依赖）。

提供：网关客户端 OAPClient、agent 循环 Agent、内置工具 BUILTIN_TOOLS。
"""
from .agent import Agent
from .oap_client import OAPClient, OAPError
from .tools import BUILTIN_TOOLS, list_tool_specs

__all__ = ["OAPClient", "OAPError", "Agent", "BUILTIN_TOOLS", "list_tool_specs"]

__version__ = "0.1.1"
