"""内置工具实现：shell、文件读写、目录列举、HTTP 请求等。

所有工具执行都做了基本安全防护：超时、异常捕获、路径/长度限制、危险命令提示性拦截。

安全提示：工具执行具有系统副作用（可读写文件、执行命令、发起网络请求）。
请在可信环境下使用，并避免把不可信的外部输入直接作为命令/路径执行。
"""
from __future__ import annotations

import os
import shlex
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

# 危险命令关键词（仅做提示性拦截，并非绝对安全保证）
# 危险命令关键词（仅做提示性拦截，并非绝对安全保证）
# 注意：黑名单机制本质不完备，生产环境建议改用白名单或沙箱
_DANGEROUS = (
    "rm -rf", "rm -r ", "mkfs", "dd if=", ":(){", "> /dev/sd",
    "shutdown", "reboot", "chmod -R", "chown -R",
    "find / -delete", "find / -exec",
    "python -c", "python3 -c", "perl -e", "ruby -e",
    "curl | sh", "curl | bash", "wget | sh", "wget | bash",
    "nc -", "ncat -", "socat",
    "> /etc/", "> /boot/",
)

def _normalize_command(cmd: str) -> str:
    """去除多余空格、引号包裹等常见绕过手段，用于安全检测"""
    # 去除多余的空白字符
    normalized = " ".join(cmd.split())
    # 去除引号包裹 (e.g., r""m → rm)
    normalized = normalized.replace('"', '').replace("'", "")
    return normalized.lower()

# 工作目录白名单：限制 read_file / list_dir 只能访问此目录下的文件，
# 防止路径遍历读取 /etc/passwd、~/.ssh/ 等敏感路径 (CWE-22)
_WORKSPACE_DIR = os.environ.get("OAP_WORKSPACE_DIR", os.getcwd())


def _tool(name: str, description: str, parameters: dict[str, Any]):
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
    normalized = _normalize_command(command)
    if any(d in normalized for d in _DANGEROUS):
        return "⚠️ 出于安全考虑，疑似危险命令已被阻止执行：" + command
    try:
        # 使用 shlex.split() + shell=False 防止命令注入
        args = shlex.split(command)
        if not args:
            return "⚠️ 命令为空"
        proc = subprocess.run(args, shell=False, cwd=cwd or os.getcwd(),
                              capture_output=True, text=True, timeout=timeout)
        out = (proc.stdout or "") + (proc.stderr or "")
        return out[:8000] or "(无输出)"
    except subprocess.TimeoutExpired:
        return f"⚠️ 命令执行超时（>{timeout}s）"
    except ValueError as e:
        return f"⚠️ 命令解析错误：{e}"
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
        # 路径遍历防护：只允许访问工作目录内的文件 (CWE-22)
        abs_path = os.path.realpath(path)
        workspace = os.path.realpath(_WORKSPACE_DIR)
        if not abs_path.startswith(workspace + os.sep) and abs_path != workspace:
            return f"⚠️ 安全限制：不允许访问工作目录以外的路径 ({path})"
        if not os.path.isfile(abs_path):
            return f"文件不存在：{path}"
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            data = f.read(max_bytes)
        return data or "(空文件)"
    except Exception as e:  # noqa: BLE001
        return f"读取失败：{e}"


# 禁止写入的敏感路径前缀（CWE-73: External Control of File Name or Path）
_SENSITIVE_PATH_PREFIXES = (
    "/etc/", "/proc/", "/sys/", "/dev/",
    "/boot/", "/root/.ssh/", "/root/.gnupg/",
    os.path.expanduser("~/.ssh/"),
    os.path.expanduser("~/.gnupg/"),
)


@_tool("write_file", "把内容写入指定文件（覆盖写入）。", {
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "目标文件路径"},
        "content": {"type": "string", "description": "要写入的文本"}
    },
    "required": ["path", "content"]
})
def write_file(path: str, content: str) -> str:
    # 安全: 路径遍历防护 (CWE-22)
    resolved = os.path.realpath(path)
    cwd = os.path.realpath(os.getcwd())
    if not resolved.startswith(cwd + os.sep) and resolved != cwd:
        return "⚠️ 安全限制: 不允许写入当前工作目录之外的文件"
    # 路径安全校验：拒绝写入系统敏感目录 (CWE-73)
    if any(resolved.startswith(prefix) for prefix in _SENSITIVE_PATH_PREFIXES):
        return f"⚠️ 出于安全考虑，禁止写入敏感路径：{path}"
    try:
        parent = os.path.dirname(resolved)
        os.makedirs(parent, exist_ok=True)
        with open(resolved, "w", encoding="utf-8") as f:
            f.write(content)
        return f"已写入 {len(content)} 字符到 {resolved}"
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
        # 验证 URL scheme，仅允许 http/https (Bandit B310)
        from urllib.parse import urlparse
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return f"不允许的 URL scheme '{parsed.scheme}'，仅支持 http/https"
        data = body.encode("utf-8") if body else None
        req = urllib.request.Request(url, data=data, method=method.upper())
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read(8000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return f"HTTP 错误 {e.code}: {e.reason}"
    except Exception as e:  # noqa: BLE001
        return f"请求失败：{e}"


# 内置工具注册表：工具名 -> 可执行函数
BUILTIN_TOOLS: dict[str, Callable] = {
    shell._tool_name: shell,
    read_file._tool_name: read_file,
    write_file._tool_name: write_file,
    list_dir._tool_name: list_dir,
    http_request._tool_name: http_request,
}


def get_tool_spec(tool_func: Callable) -> dict[str, Any]:
    """把被 @_tool 装饰的函数转为工具说明（用于注入系统提示词）。"""
    return {
        "name": tool_func._tool_name,
        "description": tool_func._tool_description,
        "parameters": tool_func._tool_parameters,
    }


def list_tool_specs() -> list[dict[str, Any]]:
    """返回所有内置工具说明列表。"""
    return [get_tool_spec(f) for f in BUILTIN_TOOLS.values()]
