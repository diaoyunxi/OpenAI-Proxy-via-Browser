# -*- coding: utf-8 -*-
"""提示词外部文件加载器（热加载）。

把「发给 AI 的提示词」从代码中剥离到仓库根目录的 .txt 文件，改动后无需重启
网关，下一次请求即生效。

加载规则
--------
1. 每次调用只对文件做一次 ``stat``，用 ``(mtime_ns, size)`` 判断是否变化，
   未变化则直接复用缓存内容，开销可忽略；
2. 文件缺失、无法读取或编码错误时，回退到本模块内置的默认值，并只告警一次，
   避免每个请求重复刷日志；
3. 模板文件额外支持两种语法：以 ``#`` 开头的注释行，以及
   ``{{#name}} ... {{/name}}`` 条件块（值为空时整块丢弃）。

受管文件（均位于仓库根目录）
----------------------------
- ``system_prompt.txt``   ：服务端默认系统提示词，请求未携带 system 消息时注入；
                            内容留空表示不注入任何默认系统提示词。
- ``prompt_template.txt`` ：消息包装模板，决定最终粘贴到网页输入框的文本结构。

作者：OpenAI-Proxy-via-Browser
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Dict, Match, Set, Tuple

logger = logging.getLogger("oap.prompts")

# 仓库根目录：server/prompt_files.py -> server/ -> <repo>
REPO_ROOT = Path(__file__).resolve().parent.parent

FILE_SYSTEM_PROMPT = "system_prompt.txt"
FILE_PROMPT_TEMPLATE = "prompt_template.txt"

# 内置兜底值：外部文件缺失、为空或读取失败时使用
DEFAULT_SYSTEM_PROMPT = ""
DEFAULT_PROMPT_TEMPLATE = (
    "{{#system}}\n"
    "<system>\n{system}\n</system>\n"
    "{{/system}}\n"
    "{{#user}}\n"
    "<user>\n{user}\n</user>\n"
    "{{/user}}\n"
)

# 首次运行时写入文件的完整示例内容（模板带注释说明，方便用户直接改）
SAMPLE_SYSTEM_PROMPT = (
    "你是一个有用的智能助手。请准确、简洁地回答用户的问题，并使用与用户相同的语言。\n"
)
SAMPLE_PROMPT_TEMPLATE = """\
# ==========================================================================
# 消息包装模板（由服务端 server/main.py 使用）
# --------------------------------------------------------------------------
# 作用：把请求里的 messages 拼成一段文本，再粘贴进网页的输入框发给 AI。
#
# 可用占位符：
#   {system}  —— 所有 role=system 消息合并后的内容（用空行分隔）
#   {user}    —— 所有 role=user / assistant 消息合并后的内容（用空行分隔）
#
# 条件块（起止标签必须各占一行，渲染时标签行会被整行移除）：
#   {{#system}} ... {{/system}}  —— 仅当 {system} 非空时保留块内内容
#   {{#user}}   ... {{/user}}    —— 仅当 {user} 非空时保留块内内容
#   条件块不支持嵌套。
#
# 其它规则：
#   - 以 # 开头的行是注释，不会发送给模型；
#   - 连续 3 个以上换行会被压缩成 2 个；
#   - 本文件改动后无需重启服务，下一次请求即生效；
#   - 本文件被删除或内容为空时，自动回退到代码内置的等价模板。
#
# 注意：若把下面的 <system>/<user> 标签改成别的写法，请同步检查扩展侧
#       extension/content.js 中 cleanReplyText() 的清理正则，避免包装标签
#       被当成回答内容回传。
# ==========================================================================
{{#system}}
<system>
{system}
</system>
{{/system}}
{{#user}}
<user>
{user}
</user>
{{/user}}
"""

# 自动生成的（文件名, 内容）清单
_SAMPLES: Tuple[Tuple[str, str], ...] = (
    (FILE_SYSTEM_PROMPT, SAMPLE_SYSTEM_PROMPT),
    (FILE_PROMPT_TEMPLATE, SAMPLE_PROMPT_TEMPLATE),
)

# 缓存：文件名 -> (mtime_ns, size, 内容)
_CACHE: Dict[str, Tuple[int, int, str]] = {}
# 已告警过的文件名，防止每个请求刷一条日志
_WARNED: Set[str] = set()

# 注释行：行首（允许前导空白）为 # 的整行
_COMMENT_LINE_RE = re.compile(r"^[ \t]*#.*$", re.MULTILINE)
# 条件块：开始/结束标签必须独占一行，块内容非贪婪匹配，不支持嵌套
_BLOCK_RE = re.compile(
    r"^[ \t]*\{\{#(\w+)\}\}[ \t]*\r?\n?"      # {{#name}}
    r"([\s\S]*?)"                               # 块内容
    r"^[ \t]*\{\{/\1\}\}[ \t]*\r?\n?",          # {{/name}}
    re.MULTILINE,
)
# 连续 3 个以上换行压缩为 2 个，避免条件块被删除后留下大片空白
_BLANK_RE = re.compile(r"\n{3,}")


def prompt_file_path(filename: str) -> Path:
    """返回提示词文件在仓库根目录下的绝对路径。

    :param filename: 文件名，如 ``system_prompt.txt``
    :return: 绝对路径
    """
    return REPO_ROOT / filename


def _warn_once(filename: str, reason: str) -> None:
    """对同一个文件只告警一次，避免高频请求刷屏。

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
        _warn_once(filename, f"读取失败（{exc}），已回退到内置默认提示词")
        _CACHE.pop(filename, None)
        return default

    _CACHE[filename] = (stat.st_mtime_ns, stat.st_size, text)
    _WARNED.discard(filename)
    return text


def load_system_prompt() -> str:
    """读取服务端默认系统提示词。

    与模板文件不同，本文件是「纯内容」，不支持注释行，内容会原样注入。
    文件缺失或内容为空时返回空串，表示不注入任何默认系统提示词。

    :return: 系统提示词文本，可能为空串
    """
    text = load_text(FILE_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT)
    stripped = text.strip()
    if not stripped:
        _warn_once(FILE_SYSTEM_PROMPT, "内容为空，本次不注入默认系统提示词")
        return ""
    return stripped


def _render(template: str, system: str, user: str) -> str:
    """执行模板渲染的四个步骤。

    顺序：剥离注释行 -> 处理条件块 -> 替换占位符 -> 压缩多余空行。

    :param template: 模板原文
    :param system: 所有 system 消息合并后的内容，无则为空串
    :param user: 所有 user / assistant 消息合并后的内容，无则为空串
    :return: 渲染后的文本
    """
    values = {"system": system, "user": user}

    def _replace_block(match: Match) -> str:
        """条件块替换：对应值非空时保留块内容，否则整块丢弃。"""
        return match.group(2) if values.get(match.group(1), "").strip() else ""

    text = _COMMENT_LINE_RE.sub("", template)
    text = _BLOCK_RE.sub(_replace_block, text)
    for key, value in values.items():
        text = text.replace("{" + key + "}", value)
    text = _BLANK_RE.sub("\n\n", text)
    return text.strip()


def render_prompt_template(system: str, user: str) -> str:
    """按外部模板文件渲染最终粘贴到网页输入框的文本。

    外部模板为空、只剩注释或占位符被误删，导致有内容却渲染不出东西时，
    自动回退到内置模板，避免所有请求变成空提示词。

    :param system: 所有 system 消息合并后的内容，无则为空串
    :param user: 所有 user / assistant 消息合并后的内容，无则为空串
    :return: 渲染后的文本；模板与内容均为空时返回空串
    """
    text = _render(load_text(FILE_PROMPT_TEMPLATE, DEFAULT_PROMPT_TEMPLATE), system, user)
    if text or not (system.strip() or user.strip()):
        return text

    _warn_once(FILE_PROMPT_TEMPLATE, "渲染结果为空，已回退到内置默认模板")
    return _render(DEFAULT_PROMPT_TEMPLATE, system, user)


def ensure_prompt_files() -> list[Path]:
    """确保本端所需的提示词文件存在，缺失时按内置示例内容自动创建。

    仅补齐缺失的文件，已存在的文件一律不动，避免覆盖用户的自定义内容。

    :return: 本次新建的文件路径列表（原本就存在的不包含在内）
    """
    created: list[Path] = []
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
    return created


def clear_cache() -> None:
    """清空文件缓存（主要用于测试或强制重新读取）。"""
    _CACHE.clear()
    _WARNED.clear()
