"""
/property/<prop_id>  —  Single-property underwriter detail page.

Two assumption sets per property: 'initial_pro_forma' (planning baseline) and
'actual_results' (reality as the deal plays out).  Each is independently
editable, with all field-level changes recorded to audit_log.

Page sections (top to bottom):
    Header       — address, tab selector, audit-log link, revert button
    Result cards — Flip + DSCR profit/IRR for BOTH snapshots, with deltas
    Editor       — color-coded assumption groups for the active snapshot only
    Breakdowns   — flip cash flow, DSCR cash flow, side-by-side comparison
"""
from __future__ import annotations

import dash
import dash_mantine_components as dmc
from dash import dcc, html, Input, Output, State, ALL, ctx, no_update

import auth
import db
import styles
import title
from model import (compute, best_strategy, sync_op_ex,
                    SECTION_FIELDS, RENTAL_OPEX_LINES, _default_rental_opex)


# Build a {field_id: kind} map covering every section so callbacks know how
# to interpret an input value (num%, num$, etc.) without having to look it up.
FIELD_KIND = {fid: kind
              for section in SECTION_FIELDS.values()
              for fid, _label, kind in section}

dash.register_page(__name__, path_template="/property/<prop_id>")


# Each assumption row: [(field_id, label, kind)]
VALUATION_COL1 = SECTION_FIELDS["valuation_col1"]
VALUATION_COL2 = SECTION_FIELDS["valuation_col2"]
PML_FIELDS     = SECTION_FIELDS["pml"]
DSCR_FIELDS      = SECTION_FIELDS["dscr"]
BASE_FLIP        = SECTION_FIELDS["base_flip"]
BASE_RENTAL      = SECTION_FIELDS["base_rental"]

# These rental op-ex lines are read-only (driven by valuation values)
OPEX_AUTO_LINES = {fid for fid, _l, _f, auto in RENTAL_OPEX_LINES if auto}


# ---------------------------------------------------------------------------
# Field renderer — uses dmc.NumberInput for live currency / percent formatting.
# Percents are stored as decimals (0.068) but displayed/edited as % (6.8%).
# Conversion happens at the callback boundary; see _coerce_input_value().
# ---------------------------------------------------------------------------
def _make_number_input(field_id: str, kind: str, value, disabled=False,
                        id_obj=None):
    if id_obj is None:
        id_obj = {"type": "edit", "field": field_id}
    if kind == "num$":
        return dmc.NumberInput(
            id=id_obj,
            value=value if value not in (None, "") else 0,
            prefix="$ ",
            thousandSeparator=",",
            decimalScale=2,
            fixedDecimalScale=True,
            allowDecimal=True,
            disabled=disabled,
            size="xs",
            styles={"input": {"fontSize": "12px",
                                "fontVariantNumeric": "tabular-nums",
                                "minHeight": "26px", "height": "26px"}},
        )
    if kind == "num%":
        # Display as percentage points (6.80 for 0.068).
        display = (value * 100) if value not in (None, "") else 0
        return dmc.NumberInput(
            id=id_obj,
            value=display,
            suffix=" %",
            decimalScale=2,
            fixedDecimalScale=True,
            allowDecimal=True,
            disabled=disabled,
            size="xs",
            styles={"input": {"fontSize": "12px",
                                "fontVariantNumeric": "tabular-nums",
                                "minHeight": "26px", "height": "26px"}},
        )
    # plain integer-ish (days, months, years, sqft)
    return dmc.NumberInput(
        id=id_obj,
        value=value if value not in (None, "") else 0,
        thousandSeparator=",",
        decimalScale=2,
        allowDecimal=True,
        disabled=disabled,
        size="xs",
        styles={"input": {"fontSize": "12px",
                            "fontVariantNumeric": "tabular-nums",
                            "minHeight": "26px", "height": "26px"}},
    )


def _field_row(field_id: str, label: str, kind: str, value,
               disabled: bool = False) -> html.Div:
    if kind == "bool":
        return html.Div(
            dcc.Checklist(
                id={"type": "edit", "field": field_id},
                options=[{"label": "  " + label, "value": "on"}],
                value=["on"] if value else [],
                style={"fontSize": "12px", "padding": "3px 0"},
            ),
            style={"marginBottom": "4px"},
        )
    if kind == "text":
        ctrl = dcc.Input(
            id={"type": "edit", "field": field_id},
            type="text",
            value=value or "",
            disabled=disabled,
            debounce=True,
            style={**styles.INPUT_SM,
                   "background": "#f5f5f5" if disabled else "#fff"},
        )
    else:
        ctrl = _make_number_input(field_id, kind, value, disabled=disabled)

    return html.Div(
        [
            html.Div(label, style=styles.LABEL_SM),
            ctrl,
        ],
        style={"marginBottom": "6px"},
    )


def _coerce_input_value(field_id: str, raw_val):
    """Translate a value coming back from a callback into the model's units.

    NumberInput returns the *displayed* value (e.g. 6.8 for a 6.8 % field).
    For 'num%' fields we divide by 100 so the snapshot stores 0.068.
    """
    kind = FIELD_KIND.get(field_id)
    if kind == "num%":
        if raw_val in (None, ""):
            return 0.0
        try: return float(raw_val) / 100
        except (TypeError, ValueError): return 0.0
    if kind in ("num$", "num"):
        if raw_val in (None, ""):
            return 0.0
        try: return float(raw_val)
        except (TypeError, ValueError): return 0.0
    return raw_val


# ---------------------------------------------------------------------------
# Section panels
# ---------------------------------------------------------------------------
def _section_panel(key: str, body, *, sub: str = "",
                   small: bool = False, clearable: bool = False) -> html.Div:
    """Wrap section body with a colored header per styles.SECTION_COLORS."""
    sc = styles.SECTION_COLORS[key]
    title_style = {
        "fontSize": "14px" if sc.get("emphasis") else "12px",
        "fontWeight": 700 if sc.get("emphasis") else 600,
        "padding": "5px 10px",
        "background": sc["header_bg"],
        "color": "#0f172a",
        "borderBottom": f"1px solid {sc['border']}",
        "borderRadius": "5px 5px 0 0",
        "letterSpacing": "0.03em",
    }
    if small:
        title_style["fontSize"] = "11px"
        title_style["padding"] = "4px 10px"

    label_part = [
        html.Span(sc["label"]),
        html.Span(" — " + sub,
                   style={"color": "#475569", "fontWeight": 400,
                          "fontSize": "11px"}) if sub else None,
    ]

    if clearable:
        header_children = html.Div(
            [
                html.Div(label_part),
                html.Button(
                    "Clear",
                    id={"type": "clear-section", "section": key},
                    n_clicks=0,
                    style={
                        "fontSize": "10px",
                        "padding": "2px 8px",
                        "border": "1px solid rgba(0,0,0,0.18)",
                        "borderRadius": "4px",
                        "background": "rgba(255,255,255,0.55)",
                        "cursor": "pointer",
                        "color": "#475569",
                        "fontWeight": 500,
                        "lineHeight": "1.4",
                    },
                ),
            ],
            style={**title_style,
                   "display": "flex",
                   "justifyContent": "space-between",
                   "alignItems": "center"},
        )
    else:
        header_children = html.Div(label_part, style=title_style)

    return html.Div(
        [
            header_children,
            html.Div(body,
                     style={"padding": "8px 10px", "background": sc["bg"]}),
        ],
        style={"border": f"1px solid {sc['border']}",
               "borderRadius": "5px", "marginBottom": "8px",
               "overflow": "hidden",
               "fontSize": "11px" if small else "12px"},
    )


def _grid(children, cols=2) -> html.Div:
    return html.Div(
        children,
        style={"display": "grid",
               "gridTemplateColumns": "1fr " * cols,
               "gap": "6px 10px"},
    )


def _valuation_section(A: dict) -> html.Div:
    col1 = [_field_row(fid, lbl, kind, A.get(fid, 0))
            for fid, lbl, kind in VALUATION_COL1]
    col2 = [_field_row(fid, lbl, kind, A.get(fid, 0))
            for fid, lbl, kind in VALUATION_COL2]
    body = html.Div(
        [html.Div(col1), html.Div(col2)],
        style={"display": "grid",
               "gridTemplateColumns": "1fr 1fr",
               "gap": "0 14px"},
    )
    return _section_panel("valuation", body, clearable=True)


def _pml_section(A: dict) -> html.Div:
    rows = [_field_row(fid, lbl, kind, A.get(fid, 0))
            for fid, lbl, kind in PML_FIELDS]
    return _section_panel("pml", _grid(rows, cols=4), clearable=True)


def _dscr_section(A: dict) -> html.Div:
    rows = [_field_row(fid, lbl, kind, A.get(fid, 0))
            for fid, lbl, kind in DSCR_FIELDS]
    return _section_panel("dscr", _grid(rows, cols=3),
                           sub="DSCR-specific assumptions", clearable=True)


def _base_section(A: dict) -> html.Div:
    flip_rows = [_field_row(fid, lbl, kind, A.get(fid, 0))
                 for fid, lbl, kind in BASE_FLIP]
    rental_rows = [_field_row(fid, lbl, kind, A.get(fid, 0))
                   for fid, lbl, kind in BASE_RENTAL]
    sub_h = {"fontSize": "10px", "fontWeight": 600,
             "textTransform": "uppercase", "letterSpacing": "0.05em",
             "color": "#475569", "marginBottom": "4px"}
    body = html.Div([
        html.Div("Base Flip Assumptions", style=sub_h),
        _grid(flip_rows, cols=4),
        html.Div("Base Rental Assumptions",
                  style={**sub_h, "marginTop": "10px"}),
        _grid(rental_rows, cols=4),
    ])
    return _section_panel("base", body, small=True,
                           sub="Standard defaults — override only when this deal differs",
                           clearable=True)


def _rental_section(A: dict) -> html.Div:
    """Rental op-ex table — condensed: 13 lines × (amount, freq, escalation)."""
    opex = A.get("rentalOpEx") or _default_rental_opex(
        A.get("insuranceAnnual", 0), A.get("annualPropertyTax", 0),
        A.get("rentOverride", 0))

    th_style = {"fontSize": "10px", "fontWeight": 600,
                 "textTransform": "uppercase", "letterSpacing": "0.04em",
                 "color": "#475569"}
    grid_template = "2fr 1.3fr 0.9fr 0.9fr"

    header = html.Div(
        [
            html.Div("Line", style=th_style),
            html.Div("Amount", style=th_style),
            html.Div("Freq.", style=th_style),
            html.Div("Esc. /yr", style=th_style),
        ],
        style={"display": "grid", "gridTemplateColumns": grid_template,
               "gap": "8px", "padding": "0 0 4px",
               "borderBottom": "1px solid #6aa84f"},
    )

    rows = []
    for fid, label, default_freq, auto in RENTAL_OPEX_LINES:
        line = opex.get(fid, {"amount": 0, "frequency": default_freq, "escalation": 0})
        is_auto = auto in ("insuranceAnnual", "annualPropertyTax")
        display_amount = (A.get("insuranceAnnual", 0) if auto == "insuranceAnnual"
                          else A.get("annualPropertyTax", 0) if auto == "annualPropertyTax"
                          else line["amount"])

        amt_input = dmc.NumberInput(
            id={"type": "opex", "field": fid, "attr": "amount"},
            value=display_amount,
            prefix="$ ", thousandSeparator=",",
            decimalScale=2, fixedDecimalScale=True, allowDecimal=True,
            disabled=is_auto, size="xs",
            styles={"input": {"fontSize": "11px",
                                "minHeight": "24px", "height": "24px",
                                "background": "#f5f5f5" if is_auto else "#fff"}},
        )
        freq_input = dcc.Dropdown(
            id={"type": "opex", "field": fid, "attr": "frequency"},
            options=[{"label": "Annual", "value": "Annual"},
                     {"label": "Monthly", "value": "Monthly"}],
            value=line.get("frequency", default_freq),
            clearable=False,
            style={"fontSize": "11px", "minHeight": "24px"},
        )
        esc_input = dmc.NumberInput(
            id={"type": "opex", "field": fid, "attr": "escalation"},
            value=(line.get("escalation", 0) or 0) * 100,
            suffix=" %",
            decimalScale=2, fixedDecimalScale=True, allowDecimal=True,
            size="xs",
            styles={"input": {"fontSize": "11px",
                                "minHeight": "24px", "height": "24px"}},
        )
        rows.append(html.Div(
            [
                html.Div(label,
                          style={"fontSize": "11px", "color": "#0f172a",
                                 "fontStyle": "italic" if is_auto else "normal"}),
                amt_input,
                freq_input,
                esc_input,
            ],
            style={"display": "grid", "gridTemplateColumns": grid_template,
                   "gap": "8px", "alignItems": "center",
                   "padding": "3px 0",
                   "borderTop": "1px solid #b6d7a8"},
        ))

    note = html.Div(
        "Each line escalates at its own annual rate over the hold period. "
        "Rent escalates at the Annual Rent Increase Rate set in Valuation. "
        "Set rates to 0 % for flat cashflow.",
        style={"marginTop": "8px", "fontSize": "10px",
                "color": "#475569", "fontStyle": "italic"},
    )
    return _section_panel("rental",
                           html.Div([header] + rows + [note]),
                           sub="Year-1 op-ex; insurance & tax follow Valuation",
                           clearable=True)


# ---------------------------------------------------------------------------
# Result cards (compact, sticky, color-coded)
#
# Coloring rules per spec:
#   - Pro Forma cards always in mid-dark gray (planning baseline, neutral)
#   - Actual Results coloring depends on Actual values:
#       DSCR IRR  > 25%                       -> DSCR green, Flip red
#       DSCR IRR <= 25% AND Flip $ >= $30,000 -> DSCR neutral, Flip green
#       DSCR IRR <= 25% AND Flip $ <  $30,000 -> DSCR neutral, Flip red
#   - Greens use forest tones (NOT lime)
# ---------------------------------------------------------------------------
COLOR = styles.RESULT_COLOR  # Excel palette: gray/green/red/muted
DSCR_THRESHOLD = 0.25
FLIP_PROFIT_THRESHOLD = 30_000


def _actual_colors(r_ar: dict) -> dict:
    """Return {'flip': color_key, 'dscr': color_key} for the Actual cards."""
    if r_ar["dscr_irr"] > DSCR_THRESHOLD:
        return {"flip": "red", "dscr": "green"}
    if r_ar["flip_profit"] >= FLIP_PROFIT_THRESHOLD:
        return {"flip": "green", "dscr": "muted"}
    return {"flip": "red", "dscr": "muted"}


def _recommendation(r_ar: dict) -> tuple[str, str]:
    """Return (text, color_key) describing the system's pick for Actual."""
    if r_ar["dscr_irr"] > DSCR_THRESHOLD:
        return (f"Recommended: Long-Term Rental (DSCR) — "
                f"DSCR IRR {styles.pct(r_ar['dscr_irr'], 2)} clears the "
                f"{int(DSCR_THRESHOLD*100)}% threshold.", "green")
    if r_ar["flip_profit"] >= FLIP_PROFIT_THRESHOLD:
        return (f"Recommended: Flip — Net profit "
                f"{styles.fmt2(r_ar['flip_profit'])} clears the "
                f"${FLIP_PROFIT_THRESHOLD:,} threshold.", "green")
    return ("No clear winner — Actual DSCR IRR below "
            f"{int(DSCR_THRESHOLD*100)}% and Actual Flip profit below "
            f"${FLIP_PROFIT_THRESHOLD:,}.  Re-examine assumptions.", "red")


def _mini_card(title: str, profit: float, irr: float, color_key: str) -> html.Div:
    c = COLOR[color_key]
    return html.Div(
        [
            html.Div(title, style={"fontSize": "10px",
                                     "textTransform": "uppercase",
                                     "letterSpacing": "0.05em",
                                     "color": c["ink"], "fontWeight": 600,
                                     "marginBottom": "2px"}),
            html.Div(
                [
                    html.Span(styles.fmt0(profit),
                               style={"fontSize": "16px", "fontWeight": 700,
                                      "color": c["ink"],
                                      "fontVariantNumeric": "tabular-nums"}),
                    html.Span("  ·  ", style={"color": "#94a3b8",
                                                "fontSize": "12px"}),
                    html.Span(styles.pct(irr, 2),
                               style={"fontSize": "14px", "fontWeight": 600,
                                      "color": c["ink"],
                                      "fontVariantNumeric": "tabular-nums"}),
                ],
            ),
        ],
        style={"flex": 1, "padding": "6px 12px",
               "background": c["bg"],
               "borderLeft": f"3px solid {c['border']}",
               "minWidth": 0},
    )


def _results_grid(r_pf: dict, r_ar: dict) -> html.Div:
    actual_colors = _actual_colors(r_ar)
    rec_text, rec_color = _recommendation(r_ar)
    rec_c = COLOR[rec_color]

    return html.Div(
        [
            # --- Pro Forma row ---
            html.Div(
                [
                    html.Div(
                        "PRO FORMA",
                        style={"width": "90px",
                                "padding": "6px 12px",
                                "background": "#94a3b8",
                                "color": "#fff",
                                "fontSize": "10px",
                                "fontWeight": 700,
                                "letterSpacing": "0.06em",
                                "display": "flex",
                                "alignItems": "center",
                                "justifyContent": "center"},
                    ),
                    _mini_card("Flip",
                                r_pf["flip_profit"], r_pf["flip_irr"], "gray"),
                    _mini_card("DSCR",
                                r_pf["dscr_profit"], r_pf["dscr_irr"], "gray"),
                ],
                style={"display": "flex",
                       "borderBottom": "1px solid #d8d8d4"},
            ),
            # --- Actual Results row ---
            html.Div(
                [
                    html.Div(
                        "ACTUAL",
                        style={"width": "90px",
                                "padding": "6px 12px",
                                "background": "#0f172a",
                                "color": "#fff",
                                "fontSize": "10px",
                                "fontWeight": 700,
                                "letterSpacing": "0.06em",
                                "display": "flex",
                                "alignItems": "center",
                                "justifyContent": "center"},
                    ),
                    _mini_card("Flip",
                                r_ar["flip_profit"], r_ar["flip_irr"],
                                actual_colors["flip"]),
                    _mini_card("DSCR",
                                r_ar["dscr_profit"], r_ar["dscr_irr"],
                                actual_colors["dscr"]),
                ],
                style={"display": "flex"},
            ),
            # --- Recommendation line ---
            html.Div(
                rec_text,
                style={"padding": "6px 12px",
                       "background": rec_c["bg"],
                       "borderTop": f"3px solid {rec_c['border']}",
                       "color": rec_c["ink"],
                       "fontSize": "12px",
                       "fontWeight": 600,
                       "fontFamily":
                           "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"},
            ),
        ],
        style={"background": "#fff",
               "border": "1px solid #d8d8d4",
               "borderRadius": "6px",
               "overflow": "hidden",
               "boxShadow": "0 1px 3px rgba(0,0,0,0.06)"},
    )


# ---------------------------------------------------------------------------
# Calculation breakdowns
# ---------------------------------------------------------------------------
def _row(label, value, indent=0, bold=False, top=None):
    pad_left = 6 + indent * 12
    s_label = {"padding": f"2px 6px 2px {pad_left}px", "fontSize": "11px"}
    s_value = {"padding": "2px 6px", "fontSize": "11px",
                "textAlign": "right",
                "fontVariantNumeric": "tabular-nums",
                "whiteSpace": "nowrap"}
    if bold:
        s_label["fontWeight"] = "700"
        s_value["fontWeight"] = "700"
    if top:
        s_label["borderTop"] = top
        s_value["borderTop"] = top
    return html.Tr([html.Td(label, style=s_label),
                     html.Td(value, style=s_value)])


def _section_label(label):
    return html.Tr(html.Td(label, colSpan=2, style={
        "fontSize": "10px", "textTransform": "uppercase",
        "letterSpacing": "0.05em", "color": "#475569",
        "padding": "8px 6px 2px", "fontWeight": "600",
    }))


def _flip_breakdown(A: dict, r: dict) -> html.Div:
    rows = [
        _section_label("Bridge loan sizing"),
        _row("Purchase + Reno (basis)", styles.fmt2(r["G30"])),
        _row(f"Bridge ARV × {A['maxLTV']*100:.0f}% LTV",
             styles.fmt2(A["bridgeARV"] * A["maxLTV"]), indent=1),
        _row("Basis × LTC", styles.fmt2(r["G30"] * A["maxLTC"]), indent=1),
        _row("Bridge loan amount", styles.fmt2(r["V9"]), bold=True,
             top="1px solid #cbd5e1"),

        _section_label("Cash to close"),
        _row("Closing costs", styles.fmt2(r["V13"]), indent=1),
        _row("Pre/post-closing expenses", styles.fmt2(r["V14"]), indent=1),
        _row("Loan origination fee", styles.fmt2(r["V15"]), indent=1),
        _row("Underwriting fee", styles.fmt2(r["V16"]), indent=1),
        _row("Prepaid interest (partial month)", styles.fmt2(r["V17"]), indent=1),
        _row("Cash to close", styles.fmt2(r["V19"]), bold=True,
             top="1px solid #cbd5e1"),

        _section_label("Bridge holding costs"),
        _row(f"Operations — {styles.num(r['total_days'],1)}d × {styles.fmt2(r['O14'])}/d",
             styles.fmt2(r["V20"]), indent=1),
        _row(f"Bridge interest — {A.get('bridgeRate',0)*100:.2f}% APR",
             styles.fmt2(r["V21"]), indent=1),
        _row("PML fees", styles.fmt2(r["V22"]), indent=1),
        _row("PML interest", styles.fmt2(r["V23"]), indent=1),
        _row("Total bridge costs", styles.fmt2(r["V24"]), bold=True,
             top="1px solid #cbd5e1"),

        _section_label("Cash equity needed"),
        _row("Excess purchase", styles.fmt2(r["V11"]), indent=1),
        _row("Bridge costs", styles.fmt2(r["V24"]), indent=1),
        _row("Cash needed at close", styles.fmt2(r["V26"]),
             bold=True, top="2px solid #1f2937"),

        _section_label("Sale at end of bridge"),
        _row("Sale price (Bridge ARV)", styles.fmt2(r["V37"]), indent=1),
        _row("− Bridge payoff", styles.fmt2(-r["V9"]), indent=1),
        _row("− Riverstone shortage carry", styles.fmt2(r["V40"]), indent=1),
        _row(f"− Dispo commission ({A.get('dispoCommissionPct',0)*100:.1f}%)",
             styles.fmt2(r["V41"]), indent=1),
        _row("− Dispo closing & transfer taxes", styles.fmt2(r["V42"]), indent=1),
        _row("Net dispo proceeds", styles.fmt2(r["V46"]), bold=True,
             top="1px solid #cbd5e1"),

        _row("FLIP PROFIT", styles.fmt2(r["flip_profit"]),
             bold=True, top="2px solid #1f2937"),
        _row("FLIP IRR — annualized", styles.pct(r["flip_irr"], 2),
             bold=True),
    ]
    return html.Table(rows, style={"width": "100%", "borderCollapse": "collapse"})


def _dscr_breakdown(A: dict, r: dict) -> html.Div:
    rows = [
        _section_label("DSCR refi — closing"),
        _row(f"DSCR loan = DSCR ARV × {A.get('dscrMaxLTV',0)*100:.0f}% LTV",
             styles.fmt2(r["Z9"]), indent=1),
        _row("− Bridge & PML payoffs", styles.fmt2(-r["V9"]), indent=1),
        _row("Gross proceeds at refi", styles.fmt2(r["Z11"]), bold=True,
             top="1px solid #cbd5e1"),

        _section_label("DSCR closing costs"),
        _row("Closing costs", styles.fmt2(r["Z13"]), indent=1),
        _row(f"DSCR origination ({A.get('dscrOriginationPct',0)*100:.2f}%, "
             f"min {styles.fmt0(A.get('dscrOrigMin',0))})",
             styles.fmt2(r["Z15"]), indent=1),
        _row("Underwriting fee", styles.fmt2(r["Z16"]), indent=1),
        _row("Prepaids (interest + ins + tax + HOA)", styles.fmt2(r["Z17"]), indent=1),
        _row("DSCR closing total", styles.fmt2(r["Z20"]), bold=True,
             top="1px solid #cbd5e1"),
        _row("DSCR (in)/outflows", styles.fmt2(r["Z22"])),
        _row("Total cash in (Bridge + DSCR)", styles.fmt2(r["Z26"]),
             bold=True, top="2px solid #1f2937"),

        _section_label("Year-1 monthly cashflow"),
        _row("Rent + other", styles.fmt2(r["Z55"]), indent=1),
        _row("− Vacancy", styles.fmt2(r["Z56"]), indent=1),
        _row(f"− DSCR P+I ({int(A.get('amortYears',30))}yr @ "
             f"{A.get('dscrRate',0)*100:.2f}%)",
             styles.fmt2(r["Z57"]), indent=1),
        _row("− Total operating expenses",
             styles.fmt2(-r["opex_mo"]), indent=1),
        _row("Gross profit / mo.", styles.fmt2(r["Z62"]), bold=True,
             top="1px solid #cbd5e1"),
        _row("− Riverstone (cash shortage carry)",
             styles.fmt2(r["Z63"]), indent=1),
        _row("Net cash / mo.", styles.fmt2(r["Z64"]), bold=True),
        _row(f"Total cashflow over {int(A.get('sellAfterYears',5))}yr",
             styles.fmt2(r["Z48"]), bold=True),

        _section_label(f"Sale after {int(A.get('sellAfterYears',5))} years"),
        _row(f"Future ARV @ {A.get('appreciationRate',0)*100:.1f}% appreciation",
             styles.fmt2(r["Z37"]), indent=1),
        _row("− DSCR loan payoff", styles.fmt2(-r["Z9"]), indent=1),
        _row("− Dispo commission", styles.fmt2(r["Z41"]), indent=1),
        _row("− Dispo closing & transfer taxes", styles.fmt2(r["Z42"]), indent=1),
        _row("+ Recovery of prepaids/escrows", styles.fmt2(r["Z43"]), indent=1),
        _row(f"+ Avg principal paydown × {int(A.get('sellAfterYears',5))}yr",
             styles.fmt2(r["Z44"]), indent=1),
        _row("Sale proceeds", styles.fmt2(r["Z46"]), bold=True,
             top="1px solid #cbd5e1"),

        _row("RENTAL PROFIT", styles.fmt2(r["dscr_profit"]),
             bold=True, top="2px solid #1f2937"),
        _row("DSCR IRR — annualized", styles.pct(r["dscr_irr"], 2),
             bold=True),
    ]
    return html.Table(rows, style={"width": "100%", "borderCollapse": "collapse"})


def _comparison_table(A: dict, r: dict) -> html.Div:
    """Original Flip vs DSCR side-by-side (computed for the active snapshot).

    Excel-palette tints: yellow column for Flip, green column for DSCR.
    """
    flip_bg = "#fff2cc"
    dscr_bg = "#d9ead3"

    def cmp_row(label, flip, dscr, bold=False):
        w = 700 if bold else 400
        return html.Tr([
            html.Td(label, style={"padding": "3px 6px", "fontSize": "12px",
                                  "fontWeight": w,
                                  "borderTop": "1px solid #f1f1ee"}),
            html.Td(flip, style={"padding": "3px 6px", "fontSize": "12px",
                                 "textAlign": "right", "fontWeight": w,
                                 "fontVariantNumeric": "tabular-nums",
                                 "background": flip_bg,
                                 "borderTop": "1px solid #f1f1ee"}),
            html.Td(dscr, style={"padding": "3px 6px", "fontSize": "12px",
                                 "textAlign": "right", "fontWeight": w,
                                 "fontVariantNumeric": "tabular-nums",
                                 "background": dscr_bg,
                                 "borderTop": "1px solid #f1f1ee"}),
        ])

    rows = [
        html.Tr([
            html.Td("Strategy", style={"padding": "5px 6px",
                                        "fontWeight": 600,
                                        "fontSize": "11px",
                                        "background": "#fafaf8"}),
            html.Td("FLIP", style={"padding": "5px 6px",
                                    "textAlign": "right",
                                    "fontWeight": 700, "fontSize": "11px",
                                    "background": flip_bg}),
            html.Td("DSCR", style={"padding": "5px 6px",
                                    "textAlign": "right",
                                    "fontWeight": 700, "fontSize": "11px",
                                    "background": dscr_bg}),
        ]),
        cmp_row("Hold period",
                f"{styles.num(r['total_days'],1)} days",
                f"{int(A.get('sellAfterYears',5))} years"),
        cmp_row("Cash needed at close",
                styles.fmt0(r["V26"]), styles.fmt0(r["Z26"])),
        cmp_row("Loan amount",
                styles.fmt0(r["V9"]), styles.fmt0(r["Z9"])),
        cmp_row("Cashflow during hold", "—", styles.fmt0(r["Z48"])),
        cmp_row("Sale price",
                styles.fmt0(r["V37"]), styles.fmt0(r["Z37"])),
        cmp_row("Net dispo proceeds",
                styles.fmt0(r["V46"]), styles.fmt0(r["Z46"])),
        cmp_row("Net profit",
                styles.fmt2(r["flip_profit"]),
                styles.fmt2(r["dscr_profit"]), bold=True),
        cmp_row("IRR",
                styles.pct(r["flip_irr"], 1),
                styles.pct(r["dscr_irr"], 1), bold=True),
        cmp_row("ROE multiple",
                f"{r['V46']/r['V26']:.2f}x" if r["V26"] else "—",
                f"{(r['Z46']+r['Z48'])/r['Z26']:.2f}x" if r["Z26"] else "—"),
    ]
    return html.Table(rows, style={"width": "100%", "borderCollapse": "collapse"})


def _subto_checklist(A: dict, r: dict) -> html.Div:
    """Subto Fund buy-box criteria with PASS/FAIL flags (mirrors V16.x)."""
    rent_mo = A.get("rentOverride", 0) or A.get("uwRent", 0)
    checks = [
        ("Existing Mortgage < $250k",       "—",                          True),
        ("Reno+Closing < $35k",             styles.fmt0(A.get("renoBudget", 0)),
                                             A.get("renoBudget", 0) < 35001),
        ("Inputs < $75k",                   styles.fmt0(r["Z26"]),
                                             r["Z26"] < 75001),
        ("Rental income > $2,000",          styles.fmt0(rent_mo),
                                             rent_mo > 2000),
        ("Cashflow > $400/mo",              styles.fmt2(r["Z62"]),
                                             r["Z62"] > 400),
        ("Instant equity > $25k (flip)",    styles.fmt0(r["flip_profit"]),
                                             r["flip_profit"] > 25000),
    ]
    rows = [
        html.Tr([
            html.Td("Criterion", style={"padding": "5px 6px",
                                         "fontWeight": 600,
                                         "fontSize": "11px",
                                         "background": "#fafaf8"}),
            html.Td("Value", style={"padding": "5px 6px",
                                     "textAlign": "right",
                                     "fontWeight": 600,
                                     "fontSize": "11px",
                                     "background": "#fafaf8"}),
        ]),
    ]
    for label, value, passed in checks:
        flag_style = {"fontSize": "9px", "padding": "1px 5px",
                       "borderRadius": "3px", "marginLeft": "6px",
                       "fontWeight": 600,
                       "background": "#d9ead3" if passed else "#f4cccc",
                       "color": "#0b3a16" if passed else "#5c0000"}
        rows.append(html.Tr([
            html.Td(
                [label, html.Span("PASS" if passed else "FAIL", style=flag_style)],
                style={"padding": "3px 6px", "fontSize": "12px",
                        "borderTop": "1px solid #f1f1ee"}),
            html.Td(value, style={"padding": "3px 6px",
                                   "fontSize": "12px",
                                   "textAlign": "right",
                                   "fontVariantNumeric": "tabular-nums",
                                   "borderTop": "1px solid #f1f1ee"}),
        ]))
    return html.Div([
        html.Table(rows, style={"width": "100%", "borderCollapse": "collapse"}),
        html.Div(
            "For Subto deals only — these checks gauge whether the deal fits "
            "the Subto Fund's buy-box.  Most flip/DSCR deals will fail the "
            "cashflow / instant-equity criteria.",
            style={"fontSize": "10px", "color": "#64748b",
                    "marginTop": "8px", "fontStyle": "italic"},
        ),
    ])


# ---------------------------------------------------------------------------
# Page layout
# ---------------------------------------------------------------------------
def _editor_for(A: dict) -> html.Div:
    return html.Div([
        _valuation_section(A),
        _rental_section(A),
        _pml_section(A),
        _dscr_section(A),
        _base_section(A),
    ])


# ---------------------------------------------------------------------------
# Middle column — condensed summary tables (Offers + Cost Basis + Unfunded)
# ---------------------------------------------------------------------------
def _summary_offers(A: dict, r: dict) -> html.Div:
    """Mirrors Dashboard B10..B17 — the offer ladder."""
    bridge_arv = A.get("bridgeARV", 0) or 0
    reno = A.get("renoBudget", 0) or 0
    flip_profit = r["flip_profit"]
    final_offer = A.get("purchasePrice", 0) or 0
    initial_uw_offer = max(0, bridge_arv * 0.75 - reno)
    hundred_pct_offer = initial_uw_offer
    max_offer_30k = max(initial_uw_offer, final_offer) - (30_000 - flip_profit)
    max_offer_35k = max(initial_uw_offer, final_offer) - (35_000 - flip_profit)
    max_ltv = bridge_arv * 0.75
    seller_payoffs = 0  # not yet plumbed through
    installment_offer = 0  # only known from Std Comp tab; leave 0 if not present

    rows = [
        ("Initial UW Offer",                  initial_uw_offer, False, "#ffffff"),
        ("Max Offer for $30k Flip Profit",    max_offer_30k,    False, "#ffffff"),
        ("100% Financing Offer",              hundred_pct_offer,False, "#ffffff"),
        ("Final Offer",                       final_offer,      True,  "#d9ead3"),
        ("Max LTV (75%)",                     max_ltv,          False, "#ffffff"),
        ("Max FC Auction Offer ($35k Profit)",max_offer_35k,    False, "#ffffff"),
        ("Seller Payoffs for Clear Title",    seller_payoffs,   False, "#ffffff"),
        ("Installment Offer",                 installment_offer,False, "#ffffff"),
    ]
    return html.Table(
        [html.Tr([
            html.Td(label, style={"padding": "3px 6px", "fontSize": "11px",
                                   "fontWeight": 700 if bold else 400,
                                   "background": bg,
                                   "borderTop": "1px solid #e5e5e5"}),
            html.Td(styles.fmt0(value), style={"padding": "3px 6px",
                                                "fontSize": "11px",
                                                "fontWeight": 700 if bold else 500,
                                                "textAlign": "right",
                                                "fontVariantNumeric": "tabular-nums",
                                                "background": bg,
                                                "borderTop": "1px solid #e5e5e5"}),
        ]) for label, value, bold, bg in rows],
        style={"width": "100%", "borderCollapse": "collapse"},
    )


def _summary_cost_basis(A: dict, r: dict) -> html.Div:
    """Mirrors Dashboard A25 + G27..G32 — cost-basis ladder."""
    rent = A.get("rentOverride", 0) or A.get("uwRent", 0) or 0
    purchase = A.get("purchasePrice", 0) or 0
    reno = A.get("renoBudget", 0) or 0
    purch_reno = purchase + reno
    bridge_costs = r["V24"]
    total = purch_reno + bridge_costs
    rent_to_value = (rent / purch_reno) if purch_reno > 0 else 0

    rows = [
        ("Rent to Value",            f"{rent_to_value*100:.2f}%", False, "#ffffff"),
        ("PURCHASE PRICE",           styles.fmt0(purchase),       True,  "#fff2cc"),
        ("+ Reno",                   styles.fmt0(reno),           False, "#d9ead3"),
        ("PURCH + RENO",             styles.fmt0(purch_reno),     True,  "#fff2cc"),
        ("+ BRIDGE CLOSING + OPS",   styles.fmt0(bridge_costs),   False, "#d9d2e9"),
        ("TOTAL FUNDS NEEDED",       styles.fmt0(total),          True,  "#fce5cd"),
    ]
    return html.Table(
        [html.Tr([
            html.Td(label, style={"padding": "3px 6px", "fontSize": "11px",
                                   "fontWeight": 700 if bold else 400,
                                   "background": bg,
                                   "borderTop": "1px solid #e5e5e5"}),
            html.Td(value, style={"padding": "3px 6px", "fontSize": "11px",
                                   "fontWeight": 700 if bold else 500,
                                   "textAlign": "right",
                                   "fontVariantNumeric": "tabular-nums",
                                   "background": bg,
                                   "borderTop": "1px solid #e5e5e5"}),
        ]) for label, value, bold, bg in rows],
        style={"width": "100%", "borderCollapse": "collapse"},
    )


def _summary_unfunded(A: dict, r: dict) -> html.Div:
    """Bridge V11 = (Purch + Reno) − Bridge loan − PML.  Tells you how much of
    the basis is NOT covered by the bridge loan + PML and therefore needs to
    come out of pocket at close."""
    purchase = A.get("purchasePrice", 0) or 0
    reno = A.get("renoBudget", 0) or 0
    bridge_loan = r["V9"]
    pml = (A.get("pmlAmount", 0) or 0) if A.get("usePML") else 0
    unfunded = purchase + reno - bridge_loan - pml
    color = "#fff2cc" if unfunded == 0 else ("#d9ead3" if unfunded < 0 else "#f4cccc")
    return html.Table(
        [
            html.Tr([
                html.Td("Unfunded (Excess) Purch. Price",
                         style={"padding": "3px 6px", "fontSize": "11px",
                                 "fontWeight": 700,
                                 "background": color,
                                 "borderTop": "1px solid #e5e5e5"}),
                html.Td(styles.fmt0(unfunded),
                         style={"padding": "3px 6px", "fontSize": "11px",
                                 "fontWeight": 700,
                                 "textAlign": "right",
                                 "fontVariantNumeric": "tabular-nums",
                                 "background": color,
                                 "borderTop": "1px solid #e5e5e5"}),
            ]),
        ],
        style={"width": "100%", "borderCollapse": "collapse"},
    )


def _prelim_title_panel(prop_id: int, A: dict) -> html.Div:
    """Foreclosure / Subto Details — derived from /intake data."""
    pt = db.get_prelim_title(prop_id)
    s = title.compute_title_summary(pt or {}, A)

    def row(label, value, bg="#ffffff", indent=0, bold=False, big=False):
        pad_left = 6 + indent * 12
        weight = 700 if bold else (600 if big else 400)
        size = "11px" if big else "10px"
        return html.Tr([
            html.Td(label, style={"padding": f"3px 6px 3px {pad_left}px",
                                    "fontSize": size,
                                    "fontWeight": weight,
                                    "background": bg,
                                    "borderTop": "1px solid #e5e5e5"}),
            html.Td(value, style={"padding": "3px 6px",
                                    "fontSize": size,
                                    "fontWeight": weight,
                                    "textAlign": "right",
                                    "fontVariantNumeric": "tabular-nums",
                                    "background": bg,
                                    "borderTop": "1px solid #e5e5e5"}),
        ])

    rows = [
        # Last loan / modif
        row("Last Loan / Modif.", f"{s['last_loan_date'] or '—'}", indent=0),
        row("Loan Amount", styles.fmt0(s["last_loan_amount"]), indent=1),
        row("Months", str(int(s["months_since_last_loan"])), indent=1),

        # Section 1A
        row("1A) Principal in Order/Stmt:", "", bg="#d9d2e9", bold=True),
        row("1st Mtg. Princ. Owed", styles.fmt0(s["p1_principal"]), indent=1),
        row(f"Interest for {s['p1_interest_months']:.1f} mos.",
             styles.fmt0(s["p1_interest"]), indent=1),
        row("FC / Mtg. Costs & Fees", styles.fmt0(s["p1_fc_costs"]),
             indent=1),
        row("TOTAL Owed in Order/Stmt:",
             styles.fmt0(s["p1_total_in_stmt"]), bg="#d9d2e9", bold=True),

        # Section 1B
        row("1B) + Add'l Pre-FC Costs + Int.:", "", bg="#d9d2e9", bold=True),
        row("Est. TOTAL Mtg Payoff:",
             styles.fmt0(s["est_total_payoff"]), bg="#fff2cc", bold=True),

        # Section 2
        row("2) 2nd Mortgage", "", bg="#d9d2e9", bold=True),
        row("Outstanding Principal", styles.fmt0(s["p2_principal"]),
             indent=1),
        row("Outstanding Interest",  styles.fmt0(s["p2_interest"]),
             indent=1),
        row("2nd Mtg Total", styles.fmt0(s["second_total"]), bold=True),

        # Section 3 totals
        row("3) TOTAL Liens / Judgments",
             styles.fmt0(s["liens_judgments_total"]),
             bg="#d9d2e9", bold=True),

        # Actual payoff
        row("ACTUAL PAYOFF (Mtg., Liens, Jmts.)",
             styles.fmt0(s["actual_payoff"]),
             bg="#fff2cc", bold=True, big=True),

        # Seller assumed
        row("1) Seller 1st Mtg. Assumed",
             styles.fmt0(s["seller_1st_assumed"]), indent=0),
        row("2) Seller 2nd Mtg. Assumed",
             styles.fmt0(s["seller_2nd_assumed"]), indent=0),
        row("3) Seller Liens / Jmts Assumed",
             styles.fmt0(s["seller_liens_assumed"]), indent=0),
        row("Assumed Mtg(s) & Liens",
             styles.fmt0(s["assumed_total"]), bg="#cfe2f3", bold=True),

        # Subto seller's mortgage
        row("SUBTO SELLER'S MORTGAGE", "", bg="#b6d7a8", bold=True),
        row("Principal / Mo.", styles.fmt2(s["sm_principal"]), indent=1),
        row("Interest / Mo.",  styles.fmt2(s["sm_interest"]),  indent=1),
        row("Taxes / Mo.",     styles.fmt2(s["sm_taxes"]),     indent=1),
        row("Insurance / Mo.", styles.fmt2(s["sm_insurance"]), indent=1),
        row("Solar Pmts / Mo.",styles.fmt2(s["sm_solar"]),     indent=1),
        row("Other / Mo.",     styles.fmt2(s["sm_other"]),     indent=1),
        row("Seller's Mtg. Pmt.",
             styles.fmt2(s["sm_total"]), bg="#b6d7a8", bold=True),

        # Estimated reinstatement
        row("ESTIMATED REINSTATEMENT", "", bg="#ead1dc", bold=True),
        row("Past Due Pmts:",
             styles.fmt2(s["past_due_pmts"]), indent=1),
        row("Costs & Fees:",
             styles.fmt2(s["fc_costs_and_fees"]), indent=1),
        row("Est. Reinstatement:",
             styles.fmt2(s["est_reinstatement"]),
             bg="#ead1dc", bold=True),
        row("Est. Principal Reduction",
             styles.fmt2(s["est_principal_reduction"]), indent=1),
    ]
    return html.Table(rows,
                       style={"width": "100%", "borderCollapse": "collapse"})


def _summary_column(prop_id: int, A: dict, r: dict) -> html.Div:
    """Middle column: condensed summary tables."""
    panel_h = {**styles.PANEL_H, "padding": "5px 10px",
               "fontSize": "11px"}
    panel = {**styles.PANEL, "marginBottom": "8px"}
    return html.Div([
        html.Div(
            [
                html.Div("Offer Ladder", style=panel_h),
                html.Div(_summary_offers(A, r),
                          style={"padding": "0", "background": "#fff"}),
            ],
            style=panel,
        ),
        html.Div(
            [
                html.Div("Cost Basis", style=panel_h),
                html.Div(_summary_cost_basis(A, r),
                          style={"padding": "0", "background": "#fff"}),
            ],
            style=panel,
        ),
        html.Div(
            [
                html.Div(_summary_unfunded(A, r),
                          style={"padding": "0", "background": "#fff"}),
            ],
            style=panel,
        ),
        html.Div(
            [
                html.Div(
                    [
                        html.Span("Preliminary Title Data"),
                        dcc.Link("Edit →",
                                  href=f"/property/{prop_id}/intake",
                                  style={"float": "right",
                                          "color": "#2563eb",
                                          "fontSize": "10px",
                                          "textDecoration": "none",
                                          "fontWeight": 400}),
                    ],
                    style=panel_h,
                ),
                html.Div(_prelim_title_panel(prop_id, A),
                          style={"padding": "0", "background": "#fff"}),
            ],
            style=panel,
        ),
    ])


def _breakdown_panels(A_pf: dict, A_ar: dict, r_pf: dict, r_ar: dict,
                       active_kind: str) -> html.Div:
    """Calculation breakdowns + Flip-vs-DSCR comparison + Subto checks
    (computed for the active snapshot)."""
    A = A_ar if active_kind == "actual_results" else A_pf
    r = r_ar if active_kind == "actual_results" else r_pf

    panel_h_compact = {**styles.PANEL_H, "padding": "6px 10px",
                        "fontSize": "12px"}
    panel_compact = {**styles.PANEL, "marginBottom": "8px"}

    return html.Div([
        # Flip breakdown — light blue (Acquisition & Flip)
        html.Div(
            [
                html.Div("Flip — bridge period & cash flow",
                          style={**panel_h_compact,
                                 "background": styles.SECTION_COLORS["flip"]["header_bg"],
                                 "borderBottom": f"1px solid {styles.SECTION_COLORS['flip']['border']}"}),
                html.Div(_flip_breakdown(A, r),
                          style={"padding": "8px 10px"}),
            ],
            style={**panel_compact,
                   "border": f"1px solid {styles.SECTION_COLORS['flip']['border']}"},
        ),
        # DSCR breakdown — light red
        html.Div(
            [
                html.Div("Long-term rental — closing & cash flow",
                          style={**panel_h_compact,
                                 "background": styles.SECTION_COLORS["dscr"]["header_bg"],
                                 "borderBottom": f"1px solid {styles.SECTION_COLORS['dscr']['border']}"}),
                html.Div(_dscr_breakdown(A, r),
                          style={"padding": "8px 10px"}),
            ],
            style={**panel_compact,
                   "border": f"1px solid {styles.SECTION_COLORS['dscr']['border']}"},
        ),
        # Original Flip vs DSCR side-by-side
        html.Div(
            [
                html.Div("Side-by-side comparison",
                          style=panel_h_compact),
                html.Div(_comparison_table(A, r),
                          style={"padding": "8px 10px"}),
            ],
            style=panel_compact,
        ),
        # Subto Fund Buy-Box checks
        html.Div(
            [
                html.Div("Subto Fund Buy-Box checks",
                          style=panel_h_compact),
                html.Div(_subto_checklist(A, r),
                          style={"padding": "8px 10px"}),
            ],
            style=panel_compact,
        ),
    ])


def layout(prop_id: str | None = None):
    if not prop_id:
        return html.Div("No property selected.", style={"padding": "20px"})
    try:
        prop_id_i = int(prop_id)
    except ValueError:
        return html.Div("Invalid property id.", style={"padding": "20px"})

    prop = db.get_property(prop_id_i)
    if not prop:
        return html.Div([
            html.H2(f"Property #{prop_id} not found",
                    style={"padding": "18px"}),
            dcc.Link("← Back to portfolio", href="/",
                     style={"padding": "0 18px"}),
        ])

    pf = sync_op_ex({**(db.get_snapshot(prop_id_i, "initial_pro_forma") or {}),
                     "listPrice": prop["list_price"]})
    ar = sync_op_ex({**(db.get_snapshot(prop_id_i, "actual_results")     or {}),
                     "listPrice": prop["list_price"]})
    r_pf = compute(pf)
    r_ar = compute(ar)

    return html.Div([
        dcc.Store(id="prop-id-store", data=prop_id_i),
        dcc.Store(id="active-kind-store", data="actual_results"),  # default tab

        # Address bar
        html.Div(
            [
                dcc.Link("← Portfolio", href="/",
                         style={"color": "#94a3b8", "fontSize": "12px",
                                 "textDecoration": "none",
                                 "marginRight": "12px"}),
                html.Span(prop["address"],
                           style={"fontSize": "16px", "fontWeight": 600}),
                html.Span(f"  ·  {prop.get('city') or ''}, "
                          f"{prop.get('state') or ''} {prop.get('zip') or ''}",
                          style={"color": "#64748b", "marginLeft": "6px"}),
                html.Span(f"  ·  {int(prop.get('sqft') or 0)} sqft  ·  "
                          f"List {styles.fmt0(prop.get('list_price') or 0)}",
                          style={"color": "#64748b", "marginLeft": "6px",
                                  "fontSize": "13px"}),
                html.Div(
                    [
                        dcc.Link("View audit log →",
                                  href=f"/property/{prop_id_i}/audit",
                                  style={"color": "#2563eb",
                                          "fontSize": "12px",
                                          "marginRight": "12px",
                                          "textDecoration": "underline"}),
                        html.Button("Revert Actual to Pro Forma",
                                    id="revert-actual-btn",
                                    n_clicks=0,
                                    style={"padding": "5px 10px",
                                            "fontSize": "12px",
                                            "border": "1px solid #cbd5e1",
                                            "borderRadius": "5px",
                                            "background": "#fff",
                                            "cursor": "pointer"}),
                    ],
                    style={"marginLeft": "auto", "display": "flex",
                           "alignItems": "center"},
                ),
            ],
            style={"padding": "10px 22px",
                   "background": "#fff",
                   "borderBottom": "1px solid #d8d8d4",
                   "display": "flex", "alignItems": "center"},
        ),

        # ----- STICKY: result cards + tabs -----------------------------------
        # Stays pinned to the top of the viewport while the editor and
        # breakdown panels scroll below.
        html.Div(
            [
                # Compact result cards (Pro Forma + Actual + recommendation)
                html.Div(
                    html.Div(_results_grid(r_pf, r_ar), id="result-cards"),
                    style={"padding": "10px 18px 8px",
                           "maxWidth": "1500px",
                           "margin": "0 auto"},
                ),
                # Tab selector — directly below the cards
                html.Div(
                    [
                        html.Div(
                            [
                                html.Button("Initial Pro Forma",
                                             id="tab-pro-forma",
                                             n_clicks=0,
                                             style={"padding": "8px 16px",
                                                     "border": "none",
                                                     "background": "#fff",
                                                     "fontSize": "13px",
                                                     "fontWeight": 600,
                                                     "color": "#475569",
                                                     "borderBottom": "3px solid transparent",
                                                     "cursor": "pointer"}),
                                html.Button("Actual Results",
                                             id="tab-actual",
                                             n_clicks=0,
                                             style={"padding": "8px 16px",
                                                     "border": "none",
                                                     "background": "#fff",
                                                     "fontSize": "13px",
                                                     "fontWeight": 700,
                                                     "color": "#0f172a",
                                                     "borderBottom": "3px solid #0f172a",
                                                     "cursor": "pointer"}),
                            ],
                            style={"display": "flex", "gap": "0"},
                            id="tab-bar",
                        ),
                    ],
                    style={"padding": "0 18px",
                            "background": "#fff",
                            "borderBottom": "1px solid #d8d8d4"},
                ),
            ],
            style={"position": "sticky", "top": "0", "zIndex": 50,
                   "background": "#f7f7f5",
                   "boxShadow": "0 2px 8px rgba(0,0,0,0.05)"},
        ),

        # ---------------- Three-column body ----------------------------------
        # Left: editable assumptions
        # Middle: condensed summary tables (Offers, Cost Basis, Unfunded)
        # Right: cash-flow / closing breakdowns + Side-by-side + Subto checks
        html.Div(
            [
                html.Div(_editor_for(ar),    id="editor-panel"),
                html.Div(_summary_column(prop_id_i, ar, r_ar),
                          id="summary-panel"),
                html.Div(_breakdown_panels(pf, ar, r_pf, r_ar, "actual_results"),
                          id="breakdown-panel"),
            ],
            style={"display": "grid",
                   "gridTemplateColumns":
                       "minmax(360px, 1.1fr) minmax(220px, 0.55fr) minmax(380px, 1fr)",
                   "gap": "12px", "padding": "12px",
                   "maxWidth": "1700px", "margin": "0 auto"},
        ),
    ])


# ---------------------------------------------------------------------------
# Callbacks
# ---------------------------------------------------------------------------
def _build_state(prop_id: int):
    prop = db.get_property(prop_id)
    pf = sync_op_ex({**(db.get_snapshot(prop_id, "initial_pro_forma") or {}),
                     "listPrice": prop["list_price"]})
    ar = sync_op_ex({**(db.get_snapshot(prop_id, "actual_results")     or {}),
                     "listPrice": prop["list_price"]})
    return prop, pf, ar, compute(pf), compute(ar)


@dash.callback(
    Output("editor-panel", "children"),
    Output("summary-panel", "children"),
    Output("breakdown-panel", "children"),
    Output("result-cards", "children"),
    Output("active-kind-store", "data"),
    Output("tab-pro-forma", "style"),
    Output("tab-actual", "style"),
    Input("tab-pro-forma", "n_clicks"),
    Input("tab-actual", "n_clicks"),
    Input({"type": "edit", "field": ALL}, "value"),
    Input({"type": "opex", "field": ALL, "attr": ALL}, "value"),
    Input("revert-actual-btn", "n_clicks"),
    Input({"type": "clear-section", "section": ALL}, "n_clicks"),
    State({"type": "edit", "field": ALL}, "id"),
    State({"type": "opex", "field": ALL, "attr": ALL}, "id"),
    State("prop-id-store", "data"),
    State("active-kind-store", "data"),
    prevent_initial_call=True,
)
def on_change(_pf_clicks, _ar_clicks, edit_values, opex_values, revert_clicks,
              _clear_clicks, edit_ids, opex_ids, prop_id, active_kind):
    if not prop_id:
        return [no_update] * 7

    user = auth.acting_user()
    triggered_id = ctx.triggered_id

    # ---- Tab switch ----
    if triggered_id == "tab-pro-forma":
        active_kind = "initial_pro_forma"
    elif triggered_id == "tab-actual":
        active_kind = "actual_results"

    # ---- Revert ----
    elif triggered_id == "revert-actual-btn" and revert_clicks:
        db.revert_to_pro_forma(prop_id, user=user)
        active_kind = "actual_results"

    # ---- Clear section ----
    elif isinstance(triggered_id, dict) and triggered_id.get("type") == "clear-section":
        section = triggered_id["section"]
        snap = db.get_snapshot(prop_id, active_kind) or {}
        new_data = dict(snap)

        # Map each clearable section to its field list
        _CLEAR_FIELDS = {
            "valuation": VALUATION_COL1 + VALUATION_COL2,
            "pml":       PML_FIELDS,
            "dscr":      DSCR_FIELDS,
            "base":      BASE_FLIP + BASE_RENTAL,
        }
        if section in _CLEAR_FIELDS:
            for fid, _lbl, kind in _CLEAR_FIELDS[section]:
                new_data[fid] = False if kind == "bool" else 0
        elif section == "rental":
            # Zero all op-ex amounts and escalations; keep default frequencies
            opex = {}
            for fid, _lbl, default_freq, _auto in RENTAL_OPEX_LINES:
                opex[fid] = {"amount": 0, "frequency": default_freq, "escalation": 0}
            new_data["rentalOpEx"] = opex

        try:
            db.apply_edits(prop_id, active_kind, new_data, user=user)
        except Exception as e:
            print(f"clear-section error: {e}")

    # ---- Field edit (any input on the editor) ----
    elif triggered_id is not None:
        kind = active_kind
        snap = db.get_snapshot(prop_id, kind) or {}
        new_data = dict(snap)

        for spec, val in zip(edit_ids, edit_values):
            field = spec["field"]
            existing = snap.get(field)
            if isinstance(existing, bool) or field in (
                "usePML", "borrowMaxDSCR", "includeAppreciation",
                "useDwellaPM",
            ):
                new_data[field] = bool(val and "on" in val)
            else:
                new_data[field] = _coerce_input_value(field, val)

        # Op-ex edits — escalation comes back as percentage points (3.0 for 3%)
        opex = dict(snap.get("rentalOpEx") or {})
        for spec, val in zip(opex_ids, opex_values):
            fid = spec["field"]; attr = spec["attr"]
            line = dict(opex.get(fid, {}))
            if attr == "amount":
                line["amount"] = float(val) if val not in (None, "") else 0
            elif attr == "frequency":
                line["frequency"] = val or "Annual"
            elif attr == "escalation":
                # NumberInput shows %, store as decimal
                line["escalation"] = (float(val) / 100) if val not in (None, "") else 0
            opex[fid] = line
        new_data["rentalOpEx"] = opex

        try:
            db.apply_edits(prop_id, kind, new_data, user=user)
        except Exception as e:
            print(f"apply_edits error: {e}")

    # ---- Re-render ----
    _prop, pf, ar, r_pf, r_ar = _build_state(prop_id)
    A_active = ar if active_kind == "actual_results" else pf
    r_active = r_ar if active_kind == "actual_results" else r_pf

    editor    = _editor_for(A_active)
    summary   = _summary_column(prop_id, A_active, r_active)
    breakdown = _breakdown_panels(pf, ar, r_pf, r_ar, active_kind)
    cards     = _results_grid(r_pf, r_ar)

    pf_style = {
        "padding": "8px 16px", "border": "none", "background": "#fff",
        "fontSize": "13px",
        "fontWeight": 700 if active_kind == "initial_pro_forma" else 600,
        "color": "#0f172a" if active_kind == "initial_pro_forma" else "#475569",
        "borderBottom": "3px solid " + ("#0f172a"
                                          if active_kind == "initial_pro_forma"
                                          else "transparent"),
        "cursor": "pointer",
    }
    ar_style = {
        "padding": "8px 16px", "border": "none", "background": "#fff",
        "fontSize": "13px",
        "fontWeight": 700 if active_kind == "actual_results" else 600,
        "color": "#0f172a" if active_kind == "actual_results" else "#475569",
        "borderBottom": "3px solid " + ("#0f172a"
                                          if active_kind == "actual_results"
                                          else "transparent"),
        "cursor": "pointer",
    }

    return editor, summary, breakdown, cards, active_kind, pf_style, ar_style
