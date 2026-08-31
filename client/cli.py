"""命令行交互式 agents 客户端 demo。

用法示例：
    python -m client.cli --host chat.openai.com
    python -m client.cli --base-url http://127.0.0.1:8080 --verbose
"""
from __future__ import annotations

import argparse
import sys
from typing import List

from .agent import Agent
from .oap_client import OAPClient, OAPError
from .tools import BUILTIN_TOOLS, list_tool_specs


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
        print(f"[网关] 已连接：{health}")
    except OAPError as e:
        print(f"[错误] 无法连接网关：{e}")
        return 1

    specs = list_tool_specs()
    print(f"[工具] 已加载 {len(specs)} 个内置工具：{', '.join(s['name'] for s in specs)}")
    agent = Agent(client, BUILTIN_TOOLS, system_prompt=args.system,
                  model=args.model, host=args.host, timeout=args.timeout,
                  max_iterations=args.max_iterations)

    print("\n输入你的问题（输入 exit 或 quit 退出，输入 /reset 清空上下文）：")
    while True:
        try:
            user_input = input("\n你> ").strip()
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
            print("[上下文已清空]")
            continue
        try:
            answer = agent.run(user_input, verbose=args.verbose)
        except OAPError as e:
            print(f"[错误] {e}")
            continue
        print(f"\n助手> {answer}")


if __name__ == "__main__":
    sys.exit(main())
