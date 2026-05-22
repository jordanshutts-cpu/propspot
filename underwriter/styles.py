"""Shared style dicts + number formatters."""
from __future__ import annotations

import math


# ---------------------------------------------------------------------------
# Color-coded section schemes — exact Excel/Google-Sheets palette pulled
# from the V16.x workbook's styles.xml (so the dashboard matches the
# spreadsheet's look).
# ---------------------------------------------------------------------------
SECTION_COLORS = {
    "valuation":   {"bg": "#fff2cc", "border": "#bf9000",
                     "header_bg": "#ffe599", "label": "Valuation Assumptions",
                     "emphasis": True},   # YELLOW (Excel light yellow 3)
    "rental":      {"bg": "#d9ead3", "border": "#6aa84f",
                     "header_bg": "#b6d7a8", "label": "Rental Assumptions",
                     "emphasis": False},  # GREEN  (Excel light green 3)
    "pml":         {"bg": "#d9d2e9", "border": "#674ea7",
                     "header_bg": "#b4a7d6", "label": "PML Assumptions",
                     "emphasis": False},  # PURPLE (Excel light purple 3)
    "flip":        {"bg": "#cfe2f3", "border": "#3d85c6",
                     "header_bg": "#9fc5e8", "label": "Acquisition & Flip (Bridge loan)",
                     "emphasis": False},  # BLUE   (Excel light cornflower blue 3)
    "dscr":        {"bg": "#f4cccc", "border": "#cc0000",
                     "header_bg": "#ea9999", "label": "Long-term Rental (DSCR + 5-year hold)",
                     "emphasis": False},  # RED    (Excel light red 3)
    "base":        {"bg": "#f3f3f3", "border": "#999999",
                     "header_bg": "#d9d9d9", "label": "Base Assumptions",
                     "emphasis": False},  # GRAY   (Excel light gray 2/3)
}

# Result-card colors — also from the Excel palette
RESULT_COLOR = {
    "gray":  {"bg": "#d9d9d9", "border": "#999999", "ink": "#0f172a"},
    "green": {"bg": "#b6d7a8", "border": "#6aa84f", "ink": "#0b3a16"},
    "red":   {"bg": "#ea9999", "border": "#cc0000", "ink": "#5c0000"},
    "muted": {"bg": "#efefef", "border": "#b7b7b7", "ink": "#3c3c3c"},
}


# ---------------------------------------------------------------------------
# Generic style dicts
# ---------------------------------------------------------------------------
PAGE_STYLE = {
    "background": "#f7f7f5",
    "minHeight": "100vh",
    "fontFamily": "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    "color": "#1a1a1a",
    "margin": 0,
    "padding": 0,
}

PANEL = {
    "background": "#ffffff",
    "border": "1px solid #d8d8d4",
    "borderRadius": "8px",
    "marginBottom": "14px",
}

PANEL_H = {
    "fontSize": "13px", "textTransform": "uppercase", "letterSpacing": "0.06em",
    "color": "#475569", "margin": "0", "padding": "10px 14px",
    "borderBottom": "1px solid #d8d8d4", "background": "#fafaf8",
    "borderRadius": "8px 8px 0 0", "fontWeight": "600",
}

INPUT = {
    "padding": "5px 8px",
    "border": "1px solid #d8d8d4",
    "borderRadius": "5px",
    "fontSize": "13px",
    "width": "100%",
    "boxSizing": "border-box",
    "fontVariantNumeric": "tabular-nums",
}

# Condensed input — used in the assumption editor to fit more on screen
INPUT_SM = {
    "padding": "2px 5px",
    "border": "1px solid #d8d8d4",
    "borderRadius": "3px",
    "fontSize": "12px",
    "width": "100%",
    "boxSizing": "border-box",
    "fontVariantNumeric": "tabular-nums",
    "height": "24px",
}

LABEL = {
    "fontSize": "11px", "color": "#475569", "textTransform": "uppercase",
    "letterSpacing": "0.04em", "marginBottom": "2px",
}

LABEL_SM = {
    "fontSize": "10px", "color": "#475569",
    "marginBottom": "1px",
    "lineHeight": "1.2",
}

TABLE = {"width": "100%", "borderCollapse": "collapse"}

TD = {"padding": "4px 6px", "fontSize": "13px",
      "borderTop": "1px solid #f1f1ee"}

TH = {"padding": "8px 6px", "fontSize": "11px",
      "textTransform": "uppercase", "letterSpacing": "0.05em",
      "color": "#475569", "fontWeight": 600,
      "background": "#fafaf8", "borderBottom": "1px solid #d8d8d4",
      "textAlign": "left"}


# ---------------------------------------------------------------------------
# Number formatters
# ---------------------------------------------------------------------------
def fmt0(n):
    if n is None or (isinstance(n, float) and not math.isfinite(n)):
        return "—"
    return f"${n:,.0f}"


def fmt2(n):
    """$0,000.00 format."""
    if n is None or (isinstance(n, float) and not math.isfinite(n)):
        return "—"
    return f"${n:,.2f}"


def pct(n, d=2):
    """00.00% format (2-decimal default).

    The model uses 100.0 (i.e. 10000%) as a sentinel for "infinite IRR" when
    the deal is cashback-positive at refi (Z26 < 0).  Render that case as
    a clear infinity glyph so it isn't mistaken for a real percentage.
    """
    if n is None or (isinstance(n, float) and not math.isfinite(n)):
        return "—"
    if n >= 100:
        return "∞ (cashback)"
    return f"{n*100:.{d}f}%"


def num(n, d=2):
    if n is None or (isinstance(n, float) and not math.isfinite(n)):
        return "—"
    return f"{n:.{d}f}"


def fmt_by_kind(kind: str, value):
    """Format a value according to its UI kind: num$ -> $0,000.00 etc."""
    if value is None or value == "":
        return "—"
    try:
        if kind == "num$":
            return fmt2(float(value))
        if kind == "num%":
            return pct(float(value), 2)
        if kind == "num":
            f = float(value)
            return f"{int(f):,}" if f.is_integer() else f"{f:,.2f}"
        if kind == "bool":
            return "Yes" if value else "No"
    except (TypeError, ValueError):
        pass
    return str(value)


def fmt_value(field: str, v):
    """Best-guess formatter using field name heuristics (used in audit log)."""
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if v is None or v == "":
        return "—"
    f = field.lower()
    if any(k in f for k in ("rate", "pct", "vacancy", "ltv", "ltc",
                             "appreciation", "commission", "transfer")):
        try: return f"{float(v)*100:.2f}%"
        except (TypeError, ValueError): return str(v)
    if any(k in f for k in ("price", "fee", "cost", "amount", "budget",
                             "tax", "insurance", "rent", "hoa", "arv",
                             "min", "expense")):
        try: return f"${float(v):,.2f}"
        except (TypeError, ValueError): return str(v)
    if any(k in f for k in ("days", "months", "years", "sqft")):
        try:
            f_v = float(v)
            return f"{int(f_v)}" if f_v.is_integer() else f"{f_v:.2f}"
        except (TypeError, ValueError):
            return str(v)
    return str(v)
