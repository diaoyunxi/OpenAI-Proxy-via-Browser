# -*- coding: utf-8 -*-
"""生成扩展图标（纯标准库实现，无需第三方依赖）。

图标设计：蓝色圆形底 + 白色对话气泡，对应「通过浏览器对话对外提供代理」的语义。

用法：
    python tools/make_icons.py
"""

from __future__ import annotations

import os
import struct
import zlib

#: 图标尺寸列表（Chrome 扩展常见规格）
SIZES = (16, 32, 48, 128)

#: 背景色（蓝）与前景色（白），均为 RGBA
BG_COLOR = (37, 99, 235, 255)
FG_COLOR = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def _in_circle(x: float, y: float, size: int) -> bool:
    """判断坐标是否落在圆形区域内。

    :param x: 像素横坐标
    :param y: 像素纵坐标
    :param size: 图标边长
    :return: 在圆内返回 True
    """
    radius = size / 2.0
    dx = x - radius + 0.5
    dy = y - radius + 0.5
    return dx * dx + dy * dy <= radius * radius


def _in_bubble(x: float, y: float, size: int) -> bool:
    """判断坐标是否落在对话气泡（圆角矩形 + 小尾巴）区域内。

    :param x: 像素横坐标
    :param y: 像素纵坐标
    :param size: 图标边长
    :return: 在气泡内返回 True
    """
    left = size * 0.24
    right = size * 0.76
    top = size * 0.24
    bottom = size * 0.66
    corner = size * 0.14

    # 圆角矩形主体
    if left <= x <= right and top <= y <= bottom:
        # 四个圆角裁剪
        if x < left + corner and y < top + corner:
            return (x - (left + corner)) ** 2 + (y - (top + corner)) ** 2 <= corner**2
        if x > right - corner and y < top + corner:
            return (x - (right - corner)) ** 2 + (y - (top + corner)) ** 2 <= corner**2
        if x < left + corner and y > bottom - corner:
            return (x - (left + corner)) ** 2 + (y - (bottom - corner)) ** 2 <= corner**2
        if x > right - corner and y > bottom - corner:
            return (x - (right - corner)) ** 2 + (y - (bottom - corner)) ** 2 <= corner**2
        return True

    # 气泡尾巴（等腰三角形）
    tail_top = bottom - size * 0.02
    tail_bottom = size * 0.80
    tail_center = size * 0.40
    if tail_top <= y <= tail_bottom:
        half = (y - tail_top) / max(tail_bottom - tail_top, 1e-6) * size * 0.09
        tail_left = size * 0.30 - (y - tail_top) * 0.35
        if tail_left <= x <= tail_left + half * 2:
            return abs(x - tail_center) <= half
    return False


def pixel_at(x: int, y: int, size: int) -> tuple[int, int, int, int]:
    """计算单个像素的颜色。

    :param x: 像素横坐标
    :param y: 像素纵坐标
    :param size: 图标边长
    :return: RGBA 四元组
    """
    if not _in_circle(x, y, size):
        return TRANSPARENT
    if _in_bubble(x, y, size):
        return FG_COLOR
    return BG_COLOR


def _chunk(tag: bytes, data: bytes) -> bytes:
    """构造一个 PNG 数据块。

    :param tag: 块类型标识
    :param data: 块数据
    :return: 完整的块字节序列
    """
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, size: int) -> None:
    """写出一张指定尺寸的 PNG 图标。

    :param path: 输出文件路径
    :param size: 图标边长
    """
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # 每行起始的过滤器类型：0 表示不过滤
        for x in range(size):
            raw.extend(pixel_at(x, y, size))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8 位 RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(png)


def main() -> None:
    """生成全部尺寸的图标文件。"""
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icon_dir = os.path.join(base_dir, "extension", "icons")
    for size in SIZES:
        target = os.path.join(icon_dir, f"icon{size}.png")
        write_png(target, size)
        print(f"已生成：{target}")


if __name__ == "__main__":
    main()
