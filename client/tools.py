"""内置工具实现：shell、文件读写、目录列举、HTTP 请求等。

所有工具执行都做了基本安全防护：超时、异常捕获、路径/长度限制、危险命令提示性拦截。

安全提示：工具执行具有系统副作用（可读写文件、执行命令、发起网络请求）。
请在可信环境下使用，并避免把不可信的外部输入直接作为命令/路径执行。
"""
from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List

# 危险命令关键词（仅做提示性拦截，并非绝对安全保证）
_DANGEROUS = ("rm -rf", "rm -r ", "mkfs", "dd if=", ":(){", "> /dev/sd",
              "shutdown", "reboot", "chmod -R", "chown -R")


def _tool(name: str, description: str, parameters: Dict[str, Any]):
    """工具装饰器：把元数据挂到函数上，便于统一注册与说明生成。"""
    def deco(func: Callable) -> Callable:
        func._tool_name = name
        func._tool_description = description
        func._tool_parameters = parameters
        return func
    return deco


@_tool("shell", "在本地执行一条 shell 命令，返回标准输出与标准错误。", {
    "type": "object",
    "properties": {
        "command": {"type": "string", "description": "要执行的 shell 命令"},
        "cwd": {"type": "string", "description": "工作目录，默认当前目录"},
        "timeout": {"type": "integer", "description": "超时秒数，默认 30"}
    },
    "required": ["command"]
})
def shell(command: str, cwd: str = None, timeout: int = 30) -> str:
    if any(d in command for d in _DANGEROUS):
        return "⚠️ 出于安全考虑，疑似危险命令已被阻止执行：" + command
    try:
        proc = subprocess.run(command, shell=True, cwd=cwd or os.getcwd(),
                              capture_output=True, text=True, timeout=timeout)
        out = (proc.stdout or "") + (proc.stderr or "")
        return out[:8000] or "(无输出)"
    except subprocess.TimeoutExpired:
        return f"⚠️ 命令执行超时（>{timeout}s）"
    except Exception as e:  # noqa: BLE001
        return f"执行出错：{e}"


@_tool("read_file", "读取一个文本文件的全部内容。", {
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "文件绝对路径或相对路径"},
        "max_bytes": {"type": "integer", "description": "最多读取字节数，默认 200000"}
    },
    "required": ["path"]
})
def read_file(path: str, max_bytes: int = 200000) -> str:
    try:
        if not os.path.isfile(path):
            return f"文件不存在：{path}"
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = f.read(max_bytes)
        return data or "(空文件)"
    except Exception as e:  # noqa: BLE001
        return f"读取失败：{e}"


@_tool("write_file", "把内容写入指定文件（覆盖写入）。", {
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "目标文件路径"},
        "content": {"type": "string", "description": "要写入的文本"}
    },
    "required": ["path", "content"]
})
def write_file(path: str, content: str) -> str:
    try:
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"已写入 {len(content)} 字符到 {path}"
    except Exception as e:  # noqa: BLE001
        return f"写入失败：{e}"


@_tool("list_dir", "列举目录下的文件与子目录。", {
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "目录路径，默认当前目录"},
        "limit": {"type": "integer", "description": "最多列出条目数，默认 100"}
    },
    "required": []
})
def list_dir(path: str = ".", limit: int = 100) -> str:
    try:
        entries = sorted(os.listdir(path or "."))
        return "\n".join(entries[:limit]) or "(空目录)"
    except Exception as e:  # noqa: BLE001
        return f"列举失败：{e}"


@_tool("http_request", "发送一个 HTTP 请求并返回响应体（支持 GET/POST）。", {
    "type": "object",
    "properties": {
        "url": {"type": "string", "description": "目标 URL"},
        "method": {"type": "string", "description": "HTTP 方法，默认 GET"},
        "body": {"type": "string", "description": "POST 请求体（可选）"}
    },
    "required": ["url"]
})
def http_request(url: str, method: str = "GET", body: str = None) -> str:
    try:
        data = body.encode("utf-8") if body else None
        req = urllib.request.Request(url, data=data, method=method.upper())
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read(8000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return f"HTTP 错误 {e.code}: {e.reason}"
    except Exception as e:  # noqa: BLE001
        return f"请求失败：{e}"


# 内置工具注册表：工具名 -> 可执行函数
BUILTIN_TOOLS: Dict[str, Callable] = {
    shell._tool_name: shell,
    read_file._tool_name: read_file,
    write_file._tool_name: write_file,
    list_dir._tool_name: list_dir,
    http_request._tool_name: http_request,
}


def get_tool_spec(tool_func: Callable) -> Dict[str, Any]:
    """把被 @_tool 装饰的函数转为工具说明（用于注入系统提示词）。"""
    return {
        "name": tool_func._tool_name,
        "description": tool_func._tool_description,
        "parameters": tool_func._tool_parameters,
    }


def list_tool_specs() -> List[Dict[str, Any]]:
    """返回所有内置工具说明列表。"""
    return [get_tool_spec(f) for f in BUILTIN_TOOLS.values()]
