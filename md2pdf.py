#!/usr/bin/env python3
"""Convert MD → styled HTML → PDF via Chrome headless."""
import sys
import os
import subprocess
import tempfile
from pathlib import Path
import markdown

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

CSS = """
@page { size: A4; margin: 18mm 16mm 18mm 16mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB",
               -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #1a1d24;
  font-size: 11pt;
  line-height: 1.6;
  max-width: 100%;
}
h1 {
  font-size: 22pt;
  border-bottom: 3px solid #f5c542;
  padding-bottom: 8px;
  margin-top: 0;
  color: #14171f;
  page-break-after: avoid;
}
h2 {
  font-size: 16pt;
  border-left: 5px solid #f5c542;
  padding-left: 10px;
  margin-top: 24px;
  color: #14171f;
  page-break-after: avoid;
}
h3 {
  font-size: 13pt;
  color: #46d1a3;
  margin-top: 18px;
  page-break-after: avoid;
}
h4 {
  font-size: 11pt;
  color: #ff8a4c;
  margin-top: 12px;
}
hr {
  border: none;
  border-top: 1px solid #d8dce5;
  margin: 22px 0;
}
p { margin: 8px 0; }
ul, ol { margin: 8px 0; padding-left: 22px; }
li { margin: 3px 0; }
code {
  background: #f4f5f8;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: "Consolas", "SF Mono", monospace;
  font-size: 0.92em;
  color: #cd2e3a;
}
pre {
  background: #1a1e29;
  color: #e8eaf0;
  padding: 12px 14px;
  border-radius: 8px;
  overflow-x: auto;
  font-family: "Consolas", "SF Mono", monospace;
  font-size: 9.5pt;
  line-height: 1.5;
  page-break-inside: avoid;
}
pre code { background: transparent; color: inherit; padding: 0; }
table {
  border-collapse: collapse;
  width: 100%;
  margin: 12px 0;
  font-size: 10pt;
  page-break-inside: avoid;
}
th {
  background: #14171f;
  color: #ffffff;
  padding: 8px 10px;
  text-align: left;
  font-weight: 600;
  border: 1px solid #14171f;
}
td {
  padding: 7px 10px;
  border: 1px solid #d8dce5;
  vertical-align: top;
}
tr:nth-child(even) td { background: #f7f8fb; }
blockquote {
  border-left: 4px solid #6ab1ff;
  background: #eff5ff;
  padding: 10px 14px;
  margin: 12px 0;
  color: #2a3a55;
  border-radius: 0 4px 4px 0;
}
strong { color: #14171f; }
a { color: #3c5dff; text-decoration: none; }
a:hover { text-decoration: underline; }
/* Avoid splitting key blocks */
table, pre, blockquote { page-break-inside: avoid; }
h1, h2, h3 { page-break-after: avoid; }
"""

HTML_WRAPPER = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>{title}</title>
<style>{css}</style>
</head>
<body>
{body}
</body>
</html>
"""


def convert(md_path: Path, pdf_path: Path):
    md_text = md_path.read_text(encoding="utf-8")
    html_body = markdown.markdown(
        md_text,
        extensions=["tables", "fenced_code", "toc", "sane_lists"],
    )
    full_html = HTML_WRAPPER.format(
        title=md_path.stem, css=CSS, body=html_body,
    )

    # Write HTML next to PDF for debugging / reference
    html_path = pdf_path.with_suffix(".html")
    html_path.write_text(full_html, encoding="utf-8")

    pdf_path_abs = pdf_path.resolve()
    html_url = "file:///" + str(html_path.resolve()).replace("\\", "/")

    cmd = [
        CHROME,
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--no-pdf-header-footer",
        f"--print-to-pdf={pdf_path_abs}",
        html_url,
    ]
    print(f"  → Rendering {pdf_path.name}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0 or not pdf_path.exists():
        print("Chrome stderr:", result.stderr, file=sys.stderr)
        raise RuntimeError(f"Chrome failed to render {md_path}")
    size_kb = pdf_path.stat().st_size / 1024
    print(f"  ✓ {pdf_path.name} ({size_kb:.0f} KB)")


def main():
    root = Path(__file__).parent
    pairs = [
        ("GAME_GUIDE.md",   "GAME_GUIDE.pdf"),
        ("MENTOR_GUIDE.md", "MENTOR_GUIDE.pdf"),
    ]
    for md_name, pdf_name in pairs:
        md_path = root / md_name
        pdf_path = root / pdf_name
        if not md_path.exists():
            print(f"  ! {md_name} not found, skipping")
            continue
        convert(md_path, pdf_path)


if __name__ == "__main__":
    main()
