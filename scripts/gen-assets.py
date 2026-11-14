#!/usr/bin/env python3
"""生成 assets/ 下的图片资产。

- icon-180.png：把 assets/icon.svg 栅格化成 180x180。
  优先 resvg-py（跨平台自带渲染器）；没有就退 cairosvg；都没有就退 Pillow 手绘同一套几何。
- flow.png：三帧静图（GIF 的替代方案），Pillow 绘制。
- icon-16.png / icon-32.png：小尺寸派生件，方便在 issue / 列表里用。

用法：python scripts/gen-assets.py
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
SVG = ASSETS / "icon.svg"

# ── 配色（与 icon.svg 保持一致）────────────────────────────────────────────
INK = "#16202E"      # 底板
PAPER = "#F7F9FC"    # 纸
ACCENT = "#3B7BFF"   # 强调（书签）
LINE = "#C3CEDD"     # 纸上的字迹

# 浅色 UI（给 flow.png 用）
BG = "#F4F6FA"
CARD = "#FFFFFF"
BORDER = "#DCE3ED"
MUTED = "#8B98AA"
TEXT = "#2B3648"
OK = "#22A06B"

FONT_DIRS = [
    Path(r"C:\Windows\Fonts"),
    Path("/System/Library/Fonts"),
    Path("/usr/share/fonts"),
]
CJK_FILES = ["msyhbd.ttc", "msyh.ttc", "PingFang.ttc", "NotoSansCJK-Bold.ttc",
             "NotoSansCJK-Regular.ttc", "simhei.ttf", "wqy-zenhei.ttc"]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    names = (["msyhbd.ttc", "msyh.ttc"] if bold else ["msyh.ttc", "msyhbd.ttc"]) + CJK_FILES
    for name in names:
        for d in FONT_DIRS:
            p = d / name
            if p.exists():
                try:
                    return ImageFont.truetype(str(p), size)
                except OSError:
                    continue
    for d in FONT_DIRS:
        if d.exists():
            for p in sorted(d.glob("*.tt[cf]")):
                try:
                    return ImageFont.truetype(str(p), size)
                except OSError:
                    continue
    raise SystemExit("找不到可用的中文字体，装一个（如 微软雅黑 / Noto Sans CJK）后重跑")


# ── 1. icon → png ────────────────────────────────────────────────────────────
def render_icon_png() -> None:
    svg = SVG.read_text(encoding="utf-8")

    def try_resvg() -> bool:
        try:
            import resvg_py
        except ImportError:
            return False
        for size in (180, 32, 16):
            data = resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size)
            (ASSETS / f"icon-{size}.png").write_bytes(bytes(data))
        return True

    def try_cairosvg() -> bool:
        try:
            import cairosvg
        except Exception:
            return False
        try:
            for size in (180, 32, 16):
                cairosvg.svg2png(bytestring=svg.encode("utf-8"),
                                 write_to=str(ASSETS / f"icon-{size}.png"),
                                 output_width=size, output_height=size)
        except Exception:
            return False
        return True

    if try_resvg() or try_cairosvg():
        print("[icon] 已生成 icon-180.png / icon-32.png / icon-16.png")
        return

    # 兜底：Pillow 手绘同一套几何（4x 超采样后缩小）
    s = 4
    im = Image.new("RGBA", (180 * s, 180 * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, 180 * s - 1, 180 * s - 1], radius=40 * s, fill=INK)
    d.rounded_rectangle([44 * s, 34 * s, 135 * s, 145 * s], radius=12 * s, fill=PAPER)
    d.polygon([(96 * s, 34 * s), (124 * s, 34 * s), (124 * s, 92 * s),
               (110 * s, 81 * s), (96 * s, 92 * s)], fill=ACCENT)
    d.rounded_rectangle([60 * s, 102 * s, 116 * s, 109 * s], radius=4 * s, fill=LINE)
    d.rounded_rectangle([60 * s, 118 * s, 96 * s, 125 * s], radius=4 * s, fill=LINE)
    for size in (180, 32, 16):
        im.resize((size, size), Image.LANCZOS).save(ASSETS / f"icon-{size}.png")
    print("[icon] 用 Pillow 兜底生成")


# ── 2. flow.png ─────────────────────────────────────────────────────────────
S = 2  # 超采样倍数
W, H = 1200, 430
PW, PH, PY = 320, 236, 104
PX = [40, 440, 840]


def px(v: float) -> int:
    return int(round(v * S))


def rr(d, x0, y0, x1, y1, r, fill=None, outline=None, width=1):
    d.rounded_rectangle([px(x0), px(y0), px(x1), px(y1)], radius=px(r),
                        fill=fill, outline=outline, width=int(width * S))


def txt(d, x, y, s, f, fill, anchor="lt"):
    d.text((px(x), px(y)), s, font=f, fill=fill, anchor=anchor)


def text_w(s, f) -> float:
    return f.getlength(s) / S


def draw_window(d, x0, y0, title):
    """画一个「对话面板」窗口框。"""
    rr(d, x0, y0, x0 + PW, y0 + PH, 14, CARD, BORDER, 1.2)
    # 标题条
    for i, c in enumerate(["#E4E9F1", "#E4E9F1", "#E4E9F1"]):
        d.ellipse([px(x0 + 16 + i * 14), px(y0 + 16), px(x0 + 23 + i * 14), px(y0 + 23)], fill=c)
    txt(d, x0 + PW / 2, y0 + 13, title, F_SMALL, MUTED, anchor="mt")
    d.line([px(x0), px(y0 + 36), px(x0 + PW), px(y0 + 36)], fill=BORDER, width=S)


def draw_input(d, x0, y0, w, h, lines, caret=True, ghost=False):
    """画输入框。lines 为若干行文本，caret 在最后一行末尾。"""
    fill = "#F7F9FC" if ghost else "#FBFCFE"
    rr(d, x0, y0, x0 + w, y0 + h, 10, fill, BORDER, 1.2)
    for i, s in enumerate(lines):
        txt(d, x0 + 16, y0 + 16 + i * 30, s, F_BODY, TEXT if not ghost else MUTED)
    if caret:
        last = lines[-1]
        cx = x0 + 16 + text_w(last, F_BODY) + 3
        cy = y0 + 16 + (len(lines) - 1) * 30
        d.rectangle([px(cx), px(cy - 1), px(cx + 2), px(cy + 20)], fill=ACCENT)


def draw_arrow(d, x0, x1, y):
    d.line([px(x0), px(y), px(x1 - 10), px(y)], fill=ACCENT, width=int(3.5 * S))
    d.polygon([(px(x1), px(y)), (px(x1 - 13), px(y - 8)), (px(x1 - 13), px(y + 8))], fill=ACCENT)


def build_flow() -> None:
    global F_SMALL, F_BODY, F_LABEL, F_CAP, F_TAG
    F_SMALL = font(14 * S)
    F_BODY = font(17 * S)
    F_LABEL = font(21 * S, bold=True)
    F_CAP = font(19 * S)
    F_TAG = font(15 * S, bold=True)

    im = Image.new("RGB", (W * S, H * S), BG)
    d = ImageDraw.Draw(im)

    # ── 帧 1：新建会话 · 打字
    x0 = PX[0]
    txt(d, x0 + PW / 2, 52, "① 新建会话 · 打字", F_LABEL, INK, anchor="mt")
    draw_window(d, x0, PY, "新会话")
    txt(d, x0 + PW / 2, PY + 78, "有什么可以帮你的？", F_BODY, "#C2CBD8", anchor="mt")
    draw_input(d, x0 + 22, PY + 150, PW - 44, 66, ["明天下午三点评审"])

    # ── 帧 2：切到插件页
    x0 = PX[1]
    txt(d, x0 + PW / 2, 52, "② 切到插件页", F_LABEL, INK, anchor="mt")
    draw_window(d, x0, PY, "设置")
    # tab 条
    tx = x0 + 22
    rr(d, tx, PY + 50, tx + 62, PY + 80, 8, "#EAEEF5")
    txt(d, tx + 31, PY + 65, "对话", F_SMALL, MUTED, anchor="mm")
    rr(d, tx + 70, PY + 50, tx + 148, PY + 80, 8, ACCENT)
    txt(d, tx + 109, PY + 65, "插件", F_SMALL, "#FFFFFF", anchor="mm")
    # 插件卡片
    rr(d, tx, PY + 94, x0 + PW - 22, PY + 150, 10, "#F7F9FC", BORDER, 1.2)
    txt(d, tx + 14, PY + 106, "dsh-composer-draft-keeper", F_SMALL, TEXT)
    txt(d, tx + 14, PY + 128, "已保存草稿 · 3 条", F_SMALL, MUTED)
    # 空输入框暗示"这里没有输入框"
    draw_input(d, tx, PY + 162, PW - 44, 54, ["（对话区已切换走）"], caret=False, ghost=True)

    # ── 帧 3：切回 · 字还在
    x0 = PX[2]
    txt(d, x0 + PW / 2, 52, "③ 切回 · 字还在", F_LABEL, INK, anchor="mt")
    draw_window(d, x0, PY, "新会话")
    txt(d, x0 + PW / 2, PY + 78, "有什么可以帮你的？", F_BODY, "#C2CBD8", anchor="mt")
    draw_input(d, x0 + 22, PY + 150, PW - 44, 66, ["明天下午三点评审"])
    # 绿勾徽标：压在输入框右上角，表示"这条草稿被保管成功了"
    bx, by = x0 + PW - 34, PY + 148
    d.ellipse([px(bx - 11), px(by - 11), px(bx + 11), px(by + 11)], fill=OK)
    d.line([px(bx - 5), px(by), px(bx - 1), px(by + 4)], fill="#FFFFFF", width=int(2.2 * S))
    d.line([px(bx - 1), px(by + 4), px(bx + 6), px(by - 4)], fill="#FFFFFF", width=int(2.2 * S))

    # ── 箭头
    draw_arrow(d, PX[0] + PW + 14, PX[1] - 16, PY + PH / 2)
    draw_arrow(d, PX[1] + PW + 14, PX[2] - 16, PY + PH / 2)

    # ── 底部一句话
    cap = "草稿跟会话走：切页、新建会话、强杀重启，回来都还在"
    txt(d, W / 2, 372, cap, F_CAP, "#5A6779", anchor="mt")

    im = im.resize((W, H), Image.LANCZOS)
    im.save(ASSETS / "flow.png", optimize=True)
    print("[flow] 已生成 flow.png")


if __name__ == "__main__":
    ASSETS.mkdir(parents=True, exist_ok=True)
    render_icon_png()
    build_flow()
    print("done ->", ASSETS)
