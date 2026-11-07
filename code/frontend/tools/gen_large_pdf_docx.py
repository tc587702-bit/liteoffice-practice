"""
生成大文件测试素材的 PDF 与 DOCX 部分（被 gen-large-fixtures.mjs 调用）

   python tools/gen_large_pdf_docx.py <输出目录>

产出：
  large-500p.pdf    500 页，末页含 LAST-PAGE-MARK-2D8E
  large-20mb.docx   50 张图片 + 2000 段，末尾含 END-OF-DOCX-MARK-6B2C

断言来自 scripts/check-large-file.mjs：
  pdf  : pageCount === 500 且文本含 LAST-PAGE-MARK-2D8E
  docx : images === 50 且 paragraphCount >= 2000 且 html 含 END-OF-DOCX-MARK-6B2C
"""
from __future__ import annotations

import io
import os
import sys

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "C:/deepseekharness/_fixtures")
os.makedirs(OUT, exist_ok=True)


def make_pdf() -> str:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    # 用系统 TrueType 字体：reportlab 会写入 ToUnicode CMap，
    # 这样 pdf.js 才能把字形映射回文字（CID 字体需要额外的 cMap 文件，产品没带）
    font_path = "C:/Windows/Fonts/simhei.ttf"
    pdfmetrics.registerFont(TTFont("CN", font_path))

    path = os.path.join(OUT, "large-500p.pdf")
    c = canvas.Canvas(path, pagesize=A4)
    width, height = A4
    for page in range(1, 501):
        c.setFont("CN", 12)
        c.drawString(60, height - 80, f"第 {page} 页 / 共 500 页")
        c.drawString(60, height - 110, "本页用于测试超长 PDF 的逐页渲染与文本提取。")
        if page == 500:
            c.drawString(60, height - 140, "LAST-PAGE-MARK-2D8E")
        c.showPage()
    c.save()
    return path


def _noisy_png(index: int) -> io.BytesIO:
    """带噪点的 PNG，避免被压得过小（目标每张 100 KB 量级）"""
    from PIL import Image

    img = Image.effect_noise((640, 480), 90).convert("RGB")
    # 叠一条蓝边，顺带验证图片内容不是纯噪声
    for x in range(0, 640, 4):
        img.putpixel((x, 0), (10, 132, 255))
        img.putpixel((x, 479), (10, 132, 255))
    for y in range(0, 480, 4):
        img.putpixel((0, y), (10, 132, 255))
        img.putpixel((639, y), (10, 132, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)
    buf.seek(0)
    return buf


def make_docx() -> str:
    from docx import Document
    from docx.shared import Inches

    doc = Document()

    PARAGRAPHS = 2000
    IMAGES = 50
    # 每 40 段插一张图 → 正好 50 张
    for i in range(PARAGRAPHS):
        doc.add_paragraph(f"第 {i + 1} 段：这是用于测试超长文档的正文，内容足以让段落数超过两千。")
        if i % 40 == 0 and i // 40 < IMAGES:
            doc.add_picture(_noisy_png(i // 40), width=Inches(4.0))

    doc.add_paragraph("END-OF-DOCX-MARK-6B2C")

    path = os.path.join(OUT, "large-20mb.docx")
    doc.save(path)
    return path


pdf_path = make_pdf()
docx_path = make_docx()
print(f"pdf   {os.path.getsize(pdf_path) / 1048576:.2f} MB  500 页")
print(f"docx  {os.path.getsize(docx_path) / 1048576:.2f} MB  50 图 + 2000 段")
