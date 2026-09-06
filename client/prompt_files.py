# -*- coding: utf-8 -*-
"""提示词外部文件加载器（零依赖、热加载）。

客户端侧同样把提示词放到仓库根目录的 .txt 文件，保持与服务端一致的体验：
改完即生效，文件缺失时回退内置默认值。本模块只依赖 Python 标准库。

受管文件（位于仓库根目录）
--------------------------
- ``agent_system_prompt.txt`` ：Agent 默认系统提示词，即 CLI ``--system`` 的默认值。
- ``tool_call_format.txt``    ：工具调用 JSON 格式约定，注入系统提示词末尾。

作者：OpenAI-Proxy-via-Browser
"""
from __future__ import annotations

import importlib.util
import logging
from pathlib import Path
from typing import Dict, List, Tuple

logger = logging.getLogger("oap.client.prompts")

# 仓库根目录：client/prompt_files.py -> client/ -> <repo>
REPO_ROOT = Path(__file__).resolve().parent.parent

FILE_AGENT_SYSTEM = "agent_system_prompt.txt"
FILE_TOOL_FORMAT = "tool_call_format.txt"

# 内置兜底值：外部文件缺失、为空或读取失败时使用
DEFAULT_AGENT_SYSTEM = "你是一个有用的智能助手，善于使用工具完成任务。"
DEFAULT_TOOL_FORMAT = """\
# 工具调用约定
当你需要调用工具来完成任务时，请**只输出**如下 JSON（不可放在 ```json 围栏内，
只可直接输出裸 JSON），调用工具时不要输出额外解释文字：
{"tool": "<工具名>", "args": {<参数字典>}}
如需并行调用多个工具，输出 JSON 数组（不支持换行）：
[{"tool": "...", "args": {...}}, {"tool": "...", "args": {...}}]
如果你可以直接回答用户，则正常用自然语言回复，不要输出 JSON。
"""

# 首次运行时写入文件的示例内容（与内置默认值一致）
_SAMPLES: Tuple[Tuple[str, str], ...] = (
    (FILE_AGENT_SYSTEM, DEFAULT_AGENT_SYSTEM + "\n"),
    (FILE_TOOL_FORMAT, DEFAULT_TOOL_FORMAT),
)

# 缓存：文件名 -> (mtime_ns, size, 内容)
_CACHE: Dict[str, Tuple[int, int, str]] = {}
# 已告警过的文件名，防止重复刷日志
_WARNED = set()


def prompt_file_path(filename: str) -> Path:
    """返回提示词文件在仓库根目录下的绝对路径。

    :param filename: 文件名，如 ``tool_call_format.txt``
    :return: 绝对路径
    """
    return REPO_ROOT / filename


def _warn_once(filename: str, reason: str) -> None:
    """对同一个文件只告警一次。

    :param filename: 文件名
    :param reason: 告警原因描述
    """
    if filename in _WARNED:
        return
    _WARNED.add(filename)
    logger.warning("提示词文件 %s %s（路径：%s）", filename, reason, prompt_file_path(filename))


def load_text(filename: str, default: str = "") -> str:
    """读取提示词文件的原始内容（带缓存的热加载）。

    :param filename: 仓库根目录下的文件名
    :param default: 文件缺失或读取失败时返回的兜底内容
    :return: 文件原文；未做任何裁剪
    """
    path = prompt_file_path(filename)
    try:
        stat = path.stat()
    except OSError:
        _warn_once(filename, "不存在或无法访问，已回退到内置默认提示词")
        _CACHE.pop(filename, None)
        return default

    cached = _CACHE.get(filename)
    if cached is not None and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
        return cached[2]

    try:
        # utf-8-sig：兼容 Windows 记事本保存时写入的 BOM
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        _warn_once(filename, "读取失败（%s），已回退到内置默认提示词" % exc)
        _CACHE.pop(filename, None)
        return default

    _CACHE[filename] = (stat.st_mtime_ns, stat.st_size, text)
    _WARNED.discard(filename)
    return text


def load_agent_system_prompt() -> str:
    """读取 Agent 默认系统提示词。

    文件缺失或内容为空时返回内置默认值，保证 CLI 始终可用。

    :return: 系统提示词文本
    """
    text = load_text(FILE_AGENT_SYSTEM, DEFAULT_AGENT_SYSTEM).strip()
    if not text:
        _warn_once(FILE_AGENT_SYSTEM, "内容为空，已回退到内置默认提示词")
        return DEFAULT_AGENT_SYSTEM
    return text


def load_tool_call_format() -> str:
    """读取工具调用格式约定。

    文件缺失或内容为空时返回内置默认值，保证工具调用循环始终可用。

    :return: 工具调用约定文本
    """
    text = load_text(FILE_TOOL_FORMAT, DEFAULT_TOOL_FORMAT).strip()
    if not text:
        _warn_once(FILE_TOOL_FORMAT, "内容为空，已回退到内置默认提示词")
        return DEFAULT_TOOL_FORMAT.strip()
    return text


def _ensure_server_prompt_files() -> List[Path]:
    """尝试补齐服务端（`server/prompt_files.py`）所需的提示词文件。

    按文件路径动态加载，避免客户端在运行时依赖服务端的包结构；
    服务端目录不存在或加载失败时静默跳过，服务端自身启动时也会再补一次。

    :return: 本次新建的文件路径列表
    """
    module_path = REPO_ROOT / "server" / "prompt_files.py"
    if not module_path.is_file():
        return []
    try:
        spec = importlib.util.spec_from_file_location("_oap_server_prompt_files", module_path)
        if spec is None or spec.loader is None:
            return []
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return list(module.ensure_prompt_files())
    except Exception as exc:  # noqa: BLE001 - 仅为可选增强，失败不影响客户端
        logger.debug("跳过服务端提示词文件生成：%s", exc)
        return []


def ensure_prompt_files(include_server: bool = True) -> List[Path]:
    """确保提示词文件存在，缺失时按内置示例内容自动创建。

    仅补齐缺失的文件，已存在的文件一律不动，避免覆盖用户的自定义内容。

    :param include_server: 是否一并补齐服务端（`server/`）所需的提示词文件
    :return: 本次新建的文件路径列表（原本就存在的不包含在内）
    """
    created: List[Path] = []
    for filename, content in _SAMPLES:
        path = prompt_file_path(filename)
        if path.exists():
            continue
        try:
            path.write_text(content, encoding="utf-8")
        except OSError as exc:
            logger.warning("自动创建提示词文件 %s 失败：%s", filename, exc)
            continue
        created.append(path)
        logger.info("已生成默认提示词文件：%s", path)
    if include_server:
        created.extend(_ensure_server_prompt_files())
    return created


def clear_cache() -> None:
    """清空文件缓存（主要用于测试或强制重新读取）。"""
    _CACHE.clear()
    _WARNED.clear()
