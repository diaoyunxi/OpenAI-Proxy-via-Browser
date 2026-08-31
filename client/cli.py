"""命令行交互式 agents 客户端 demo。

用法示例：
    python -m client.cli --host chat.openai.com
    python -m client.cli --base-url http://127.0.0.1:8080 --verbose
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from typing import List

from .agent import Agent
from .oap_client import OAPClient, OAPError
from .tools import BUILTIN_TOOLS, list_tool_specs


# ------------------------- 彩色终端输出（零依赖，自动适配） -------------------------
def _supports_color() -> bool:
    """判断当前 stdout 是否支持 ANSI 颜色（被管道/重定向到文件时关闭）。

    遵循社区约定：``NO_COLOR`` 存在则强制关闭；``FORCE_COLOR`` 存在则强制开启。
    """
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("FORCE_COLOR"):
        return True
    return sys.stdout.isatty()


# 模块级开关：先判定再决定是否开启 Windows 虚拟终端
_COLOR = _supports_color()


def _enable_windows_vt() -> None:
    """Windows 旧版控制台默认不解析 ANSI 转义序列，需开启虚拟终端处理。

    仅在使用标准库 ctypes 的前提下启用，不引入任何第三方依赖。
    """
    if os.name != "nt" or not _COLOR:
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        STD_OUTPUT_HANDLE = -11
        ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
        handle = kernel32.GetStdHandle(STD_OUTPUT_HANDLE)
        mode = ctypes.c_uint32()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel32.SetConsoleMode(handle, mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING)
    except Exception:  # noqa: BLE001
        # 开启失败则退回纯文本，不影响功能
        pass


_enable_windows_vt()


def _paint(code: str, text: str) -> str:
    """用 ANSI 转义码包裹文本；不支持颜色时原样返回（零依赖、管道安全）。"""
    if not _COLOR:
        return text
    return f"\033[{code}m{text}\033[0m"


# 语义化颜色码：32=绿（说话人）、31=红（错误）、36=青（系统信息）、90=浅灰（思考）
C_GREEN, C_RED, C_CYAN, C_GRAY = "32", "31", "36", "90"

# 思考类标签（<think>/<thinking>/<reasoning>），匹配内部内容并上色
_THINK_RE = re.compile(r"<(think|thinking|reasoning)>([\s\S]*?)</\1>", re.IGNORECASE)


def _paint_think(text: str) -> str:
    """把思考类标签内部内容渲染为浅灰色，标签本身保持默认色。"""
    return _THINK_RE.sub(
        lambda m: f"<{m.group(1)}>{_paint(C_GRAY, m.group(2))}</{m.group(1)}>", text
    )


def main(argv: List[str] = None) -> int:
    parser = argparse.ArgumentParser(description="OpenAI-Proxy 自研 agents 客户端（零依赖）")
    parser.add_argument("--base-url", default="http://127.0.0.1:8080", help="网关地址")
    parser.add_argument("--host", default=None, help="目标站点主机，如 chat.openai.com")
    parser.add_argument("--model", default="browser-proxy")
    parser.add_argument("--system", default="你是一个有用的智能助手，善于使用工具完成任务。")
    parser.add_argument("--max-iterations", type=int, default=8, help="单轮对话最大工具循环次数")
    parser.add_argument("--timeout", type=int, default=180, help="单次网关请求超时（秒）")
    parser.add_argument("--verbose", action="store_true", help="显示工具调用过程")
    args = parser.parse_args(argv)

    client = OAPClient(base_url=args.base_url, timeout=args.timeout,
                       default_host=args.host, default_model=args.model)
    try:
        health = client.health()
        print(_paint(C_CYAN, "[网关]") + f" 已连接：{health}")
    except OAPError as e:
        print(_paint(C_RED, "[错误]") + f" 无法连接网关：{e}")
        return 1

    specs = list_tool_specs()
    print(_paint(C_CYAN, "[工具]") +
          f" 已加载 {len(specs)} 个内置工具：{', '.join(s['name'] for s in specs)}")
    agent = Agent(client, BUILTIN_TOOLS, system_prompt=args.system,
                  model=args.model, host=args.host, timeout=args.timeout,
                  max_iterations=args.max_iterations)

    print("\n输入你的问题（输入 exit 或 quit 退出，输入 /reset 清空上下文）：")
    while True:
        try:
            user_input = input(_paint(C_GREEN, "\n你> ")).strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见。")
            return 0
        if not user_input:
            continue
        low = user_input.lower()
        if low in ("exit", "quit"):
            print("再见。")
            return 0
        if low in ("/reset", "/clear"):
            agent.reset()
            print(_paint(C_CYAN, "[上下文已清空]"))
            continue
        try:
            answer = agent.run(user_input, verbose=args.verbose)
        except OAPError as e:
            print(_paint(C_RED, "[错误]") + f" {e}")
            continue
        print(f"\n{_paint(C_GREEN, '助手>')} {_paint_think(answer)}")


if __name__ == "__main__":
    sys.exit(main())
