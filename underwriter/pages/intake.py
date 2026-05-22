"""
/property/<prop_id>/intake  —  Preliminary Title Data form.

Captures the basic background / title info described in §§1-6 of the spec
and persists it to the property's `prelim_title_json` column.  The
property's underwriter (/property/<id>) reads this data to populate the
Foreclosure / Subto Details panel.
"""
from __future__ import annotations

import dash
import dash_mantine_components as dmc
from dash import dcc, html, Input, Output, State, ALL, ctx, no_update

import auth
import db
import styles
import title


# Percent-typed fields (stored as decimals; displayed/edited as % × 100)
PERCENT_FIELDS = {
    ("mortgage", "rate"),
    ("lien",     "interestRate"),
    ("judgment", "interestRate"),
}


def _is_percent(section: str, field: str) -> bool:
    return (section, field) in PERCENT_FIELDS

dash.register_page(__name__, path_template="/property/<prop_id>/intake")


# ---------------------------------------------------------------------------
# Field helpers — small, dense components
# ---------------------------------------------------------------------------
def _txt(field_id: str, value: str = "", placeholder: str = "",
         disabled: bool = False) -> dcc.Input:
    return dcc.Input(
        id=field_id, type="text", value=value or "", placeholder=placeholder,
        disabled=disabled, debounce=True,
        style={**styles.INPUT_SM,
               "background": "#f5f5f5" if disabled else "#fff"},
    )


def _date(field_id: str, value: str = "") -> dcc.Input:
    return dcc.Input(
        id=field_id, type="date", value=value or "",
        debounce=True, style=styles.INPUT_SM,
    )


def _num_field(field_id, value: float = 0, kind: str = "num$"):
    """Dollar / percent / plain-number input with live formatting."""
    base_styles = {"input": {"fontSize": "12px",
                              "fontVariantNumeric": "tabular-nums",
                              "minHeight": "26px", "height": "26px",
                              "padding": "2px 8px"}}
    if kind == "num%":
        # Stored as decimals (0.0625) — display × 100 for the user (6.25 %)
        display_val = (float(value) * 100) if value not in (None, "") else 0
        return dmc.NumberInput(
            id=field_id, value=display_val,
            suffix=" %",
            decimalScale=2, fixedDecimalScale=True, allowDecimal=True,
            size="xs", styles=base_styles,
        )
    if kind == "num$":
        return dmc.NumberInput(
            id=field_id,
            value=(float(value) if value not in (None, "") else 0),
            prefix="$ ", thousandSeparator=",",
            decimalScale=2, fixedDecimalScale=True, allowDecimal=True,
            size="xs", styles=base_styles,
        )
    # plain integer-ish (e.g. months delinquent)
    return dmc.NumberInput(
        id=field_id,
        value=(float(value) if value not in (None, "") else 0),
        thousandSeparator=",", allowDecimal=True,
        size="xs", styles=base_styles,
    )


def _label(text: str) -> html.Div:
    return html.Div(text, style=styles.LABEL_SM)


def _section_header(title_text: str, subtitle: str = "") -> html.Div:
    return html.Div(
        [
            html.Div(title_text,
                     style={"fontSize": "13px",
                             "fontWeight": 700,
                             "color": "#0f172a"}),
            html.Div(subtitle,
                     style={"fontSize": "11px",
                             "color": "#64748b",
                             "marginTop": "2px"}) if subtitle else None,
        ],
        style={"padding": "10px 14px",
                "background": "#fafaf8",
                "borderBottom": "1px solid #d8d8d4"},
    )


def _section_panel(title_text: str, body, sub: str = "") -> html.Div:
    return html.Div(
        [_section_header(title_text, sub),
         html.Div(body, style={"padding": "12px 14px",
                                "background": "#fff"})],
        style={**styles.PANEL, "marginBottom": "12px"},
    )


# ---------------------------------------------------------------------------
# Sub-form builders
# ---------------------------------------------------------------------------
MORTGAGE_FIELDS = [
    ("company",            "Mortgage Company",  "text"),
    ("date",               "Mortgage Date",     "date"),
    ("initialAmount",      "Initial Amount",    "num$"),
    ("rate",               "Rate",              "num%"),
    ("assignmentServicer", "Assignment Servicer","text"),
    ("assignmentDate",     "Assignment Date",   "date"),
]

PAYOFF_FIELDS = [
    ("statementDate",      "Payoff Statement Date","date"),
    ("currentPrincipal",   "Current Principal Balance","num$"),
    ("cumulativeInterest", "Cumulative Interest Owed","num$"),
    ("escrowsOwed",        "Escrows Owed","num$"),
    ("taxesOwed",          "Taxes Owed","num$"),
    ("insuranceOwed",      "Insurance Owed","num$"),
    ("lateFees",           "Late Fees","num$"),
    ("foreclosureCosts",   "Foreclosure Costs","num$"),
    ("attorneyFees",       "Attorney Fees","num$"),
    ("other",              "Other","num$"),
]

SELLER_MORTGAGE_FIELDS = [
    ("principalPerMo", "Principal / Mo",  "num$"),
    ("interestPerMo",  "Interest / Mo",   "num$"),
    ("taxesPerMo",     "Taxes / Mo",      "num$"),
    ("insurancePerMo", "Insurance / Mo",  "num$"),
    ("solarPerMo",     "Solar Pmts / Mo", "num$"),
    ("otherPerMo",     "Other / Mo",      "num$"),
]


def _mortgage_block(slot: str, data: dict) -> html.Div:
    """Render the column for 1st or 2nd mortgage (slot = '1' or '2')."""
    rows = []
    for fid, lbl, kind in MORTGAGE_FIELDS:
        val = data.get(fid, "")
        ctrl_id = {"type": "intake", "section": "mortgage", "slot": slot,
                    "field": fid}
        if kind == "text":
            ctrl = _txt(ctrl_id, val)
        elif kind == "date":
            ctrl = _date(ctrl_id, val)
        else:
            ctrl = _num_field(ctrl_id, val, kind)
        rows.append(html.Div([_label(lbl), ctrl],
                              style={"marginBottom": "6px"}))
    return html.Div(rows)


def _payoff_block(slot: str, data: dict) -> html.Div:
    rows = []
    for fid, lbl, kind in PAYOFF_FIELDS:
        val = data.get(fid, 0 if kind != "date" else "")
        ctrl_id = {"type": "intake", "section": "payoff", "slot": slot,
                    "field": fid}
        if kind == "date":
            ctrl = _date(ctrl_id, val)
        else:
            ctrl = _num_field(ctrl_id, val, kind)
        rows.append(html.Div([_label(lbl), ctrl],
                              style={"marginBottom": "6px"}))
    rows.append(html.Div(
        ["Total: ", html.B(styles.fmt2(title.payoff_total(data)),
                            id={"type": "intake-readout",
                                "section": "payoff",
                                "slot": slot})],
        style={"marginTop": "8px",
                "padding": "6px 8px",
                "background": "#fafaf8",
                "borderTop": "1px solid #cbd5e1",
                "fontSize": "12px"},
    ))
    return html.Div(rows)


def _seller_mortgage_block(slot: str, data: dict) -> html.Div:
    rows = []
    for fid, lbl, kind in SELLER_MORTGAGE_FIELDS:
        val = data.get(fid, 0)
        ctrl_id = {"type": "intake", "section": "sellerMtg", "slot": slot,
                    "field": fid}
        rows.append(html.Div([_label(lbl), _num_field(ctrl_id, val, kind)],
                              style={"marginBottom": "6px"}))
    return html.Div(rows)


def _two_col(col1, col2) -> html.Div:
    return html.Div(
        [
            html.Div(col1,
                     style={"borderRight": "1px solid #d8d8d4",
                             "paddingRight": "14px"}),
            html.Div(col2, style={"paddingLeft": "14px"}),
        ],
        style={"display": "grid",
                "gridTemplateColumns": "1fr 1fr",
                "gap": "0"},
    )


def _liens_table(liens: list[dict]) -> html.Div:
    while len(liens) < 3:
        liens.append(title.empty_lien())
    header = [
        "Date Filed", "Lien Holder", "Lien #",
        "Book/Page", "Principal Amt.", "Rate %", "Interest to Date",
    ]
    cols_template = "1.1fr 1.6fr 1fr 1fr 1.1fr 0.8fr 1.1fr"
    head_row = html.Div(
        [html.Div(h, style={"fontSize": "10px", "fontWeight": 600,
                              "color": "#475569",
                              "textTransform": "uppercase"}) for h in header],
        style={"display": "grid",
                "gridTemplateColumns": cols_template,
                "gap": "8px",
                "padding": "0 4px 4px"},
    )
    rows = [head_row]
    for i, lien in enumerate(liens):
        interest = title.lien_interest_to_date(lien)
        cells = [
            _date({"type": "intake", "section": "lien", "row": i,
                    "field": "dateFiled"}, lien.get("dateFiled", "")),
            _txt({"type": "intake", "section": "lien", "row": i,
                   "field": "holder"}, lien.get("holder", "")),
            _txt({"type": "intake", "section": "lien", "row": i,
                   "field": "lienNumber"}, lien.get("lienNumber", "")),
            _txt({"type": "intake", "section": "lien", "row": i,
                   "field": "bookPage"}, lien.get("bookPage", "")),
            _num_field({"type": "intake", "section": "lien", "row": i,
                          "field": "principalAmount"},
                         lien.get("principalAmount", 0)),
            _num_field({"type": "intake", "section": "lien", "row": i,
                          "field": "interestRate"},
                         lien.get("interestRate", 0.0625), "num%"),
            html.Div(styles.fmt2(interest),
                      id={"type": "intake-readout", "section": "lien",
                           "row": i, "field": "interestToDate"},
                      style={"fontSize": "11px", "padding": "4px",
                              "fontVariantNumeric": "tabular-nums",
                              "color": "#475569"}),
        ]
        rows.append(html.Div(cells,
            style={"display": "grid",
                    "gridTemplateColumns": cols_template,
                    "gap": "8px",
                    "padding": "4px 4px",
                    "borderTop": "1px solid #f1f1ee"}))
    return html.Div(rows)


def _judgments_table(judgments: list[dict]) -> html.Div:
    while len(judgments) < 3:
        judgments.append(title.empty_judgment())
    header = [
        "Judgment Date", "Plaintiff", "Case #",
        "Expiration", "Principal Amt.", "Rate %", "Interest to Date",
    ]
    cols_template = "1.1fr 1.6fr 1fr 1.1fr 1.1fr 0.8fr 1.1fr"
    head_row = html.Div(
        [html.Div(h, style={"fontSize": "10px", "fontWeight": 600,
                              "color": "#475569",
                              "textTransform": "uppercase"}) for h in header],
        style={"display": "grid",
                "gridTemplateColumns": cols_template,
                "gap": "8px",
                "padding": "0 4px 4px"},
    )
    rows = [head_row]
    for i, j in enumerate(judgments):
        interest = title.judgment_interest_to_date(j)
        exp = title.judgment_expiration(j)
        cells = [
            _date({"type": "intake", "section": "judgment", "row": i,
                    "field": "judgmentDate"}, j.get("judgmentDate", "")),
            _txt({"type": "intake", "section": "judgment", "row": i,
                   "field": "plaintiff"}, j.get("plaintiff", "")),
            _txt({"type": "intake", "section": "judgment", "row": i,
                   "field": "caseNumber"}, j.get("caseNumber", "")),
            html.Div(exp.isoformat() if exp else "—",
                      id={"type": "intake-readout", "section": "judgment",
                           "row": i, "field": "expiration"},
                      style={"fontSize": "11px", "padding": "4px",
                              "color": "#475569"}),
            _num_field({"type": "intake", "section": "judgment", "row": i,
                          "field": "principalAmount"},
                         j.get("principalAmount", 0)),
            _num_field({"type": "intake", "section": "judgment", "row": i,
                          "field": "interestRate"},
                         j.get("interestRate", 0.08), "num%"),
            html.Div(styles.fmt2(interest),
                      id={"type": "intake-readout", "section": "judgment",
                           "row": i, "field": "interestToDate"},
                      style={"fontSize": "11px", "padding": "4px",
                              "fontVariantNumeric": "tabular-nums",
                              "color": "#475569"}),
        ]
        rows.append(html.Div(cells,
            style={"display": "grid",
                    "gridTemplateColumns": cols_template,
                    "gap": "8px",
                    "padding": "4px 4px",
                    "borderTop": "1px solid #f1f1ee"}))
    return html.Div(rows)


# ---------------------------------------------------------------------------
# Page layout
# ---------------------------------------------------------------------------
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
            html.H2("Property not found", style={"padding": "20px"}),
            dcc.Link("← Portfolio", href="/", style={"padding": "0 20px"}),
        ])

    pt = {**title.DEFAULT_PRELIM_TITLE, **db.get_prelim_title(prop_id_i)}

    return html.Div([
        dcc.Store(id="intake-prop-id", data=prop_id_i),

        # Title bar
        html.Div(
            [
                dcc.Link("← Property", href=f"/property/{prop_id_i}",
                          style={"color": "#94a3b8", "fontSize": "12px",
                                  "textDecoration": "none"}),
                html.Div(f"Preliminary Title Data — {prop['address']}",
                          style={"fontSize": "16px", "fontWeight": 600,
                                  "marginTop": "4px"}),
                html.Div("Captures background / intake info for this property. "
                          "Section 1 is required (Address is set when you create "
                          "the property).  Sections 2–6 feed the Foreclosure / "
                          "Subto Details panel on the underwriter.",
                          style={"fontSize": "12px", "color": "#94a3b8",
                                  "marginTop": "4px",
                                  "maxWidth": "780px"}),
            ],
            style={"padding": "16px 22px",
                    "background": "#0f172a", "color": "#fff"},
        ),

        html.Div(
            [
                # SECTION 1
                _section_panel(
                    "Section 1 — Property Details",
                    html.Div(
                        [
                            html.Div([_label("Address (read-only)"),
                                       _txt({"type": "intake-static",
                                              "field": "address"},
                                              prop["address"], disabled=True)]),
                            html.Div([_label("County"),
                                       _txt({"type": "intake-meta",
                                              "field": "county"},
                                              prop.get("county") or "")]),
                            html.Div([_label("Parcel ID"),
                                       _txt({"type": "intake",
                                              "section": "meta",
                                              "field": "parcelId"},
                                              pt.get("parcelId", ""))]),
                            html.Div([_label("Owner(s)"),
                                       _txt({"type": "intake",
                                              "section": "meta",
                                              "field": "owners"},
                                              pt.get("owners", ""))]),
                        ],
                        style={"display": "grid",
                                "gridTemplateColumns":
                                    "1.5fr 1fr 1fr 1.5fr",
                                "gap": "12px"},
                    ),
                ),

                # SECTION 2 — mortgage details (1st + 2nd, side by side)
                _section_panel(
                    "Section 2 — Mortgage Details",
                    _two_col(
                        [html.Div("1st Mortgage",
                                    style={"fontWeight": 600,
                                            "marginBottom": "8px",
                                            "fontSize": "12px"}),
                         _mortgage_block("1", pt.get("mortgage1") or {})],
                        [html.Div("2nd Mortgage",
                                    style={"fontWeight": 600,
                                            "marginBottom": "8px",
                                            "fontSize": "12px"}),
                         _mortgage_block("2", pt.get("mortgage2") or {})],
                    ),
                    sub="If no 2nd mortgage exists, leave that column blank.",
                ),

                # months delinquent — single line below the columns
                _section_panel(
                    "Months Delinquent",
                    _num_field({"type": "intake", "section": "meta",
                                  "field": "monthsDelinquent"},
                                pt.get("monthsDelinquent", 0), "num"),
                ),

                # SECTION 3
                _section_panel(
                    "Section 3 — Payoff Statement / Foreclosure Order",
                    _two_col(
                        [html.Div("1st Mortgage",
                                    style={"fontWeight": 600,
                                            "marginBottom": "8px",
                                            "fontSize": "12px"}),
                         _payoff_block("1", pt.get("payoff1") or {})],
                        [html.Div("2nd Mortgage",
                                    style={"fontWeight": 600,
                                            "marginBottom": "8px",
                                            "fontSize": "12px"}),
                         _payoff_block("2", pt.get("payoff2") or {})],
                    ),
                ),

                # SECTION 4
                _section_panel(
                    "Section 4 — Seller's Existing Mortgage (per month)",
                    _two_col(
                        [html.Div("1st Mortgage",
                                    style={"fontWeight": 600,
                                            "marginBottom": "8px",
                                            "fontSize": "12px"}),
                         _seller_mortgage_block("1",
                                                 pt.get("sellerMortgage1") or {})],
                        [html.Div("2nd Mortgage",
                                    style={"fontWeight": 600,
                                            "marginBottom": "8px",
                                            "fontSize": "12px"}),
                         _seller_mortgage_block("2",
                                                 pt.get("sellerMortgage2") or {})],
                    ),
                ),

                # SECTION 5
                _section_panel(
                    "Section 5 — Lien Index",
                    _liens_table(list(pt.get("liens") or [])),
                    sub="Default rate 6.25 %.  Interest compounds monthly from "
                        "the Date Filed to today.",
                ),

                # SECTION 6
                _section_panel(
                    "Section 6 — Judgment Liens",
                    _judgments_table(list(pt.get("judgments") or [])),
                    sub="Default rate 8.00 %.  Expiration = Judgment Date + 10 years.",
                ),

                # Save bar
                html.Div(
                    [
                        html.Span(id="intake-save-msg",
                                   style={"fontSize": "12px",
                                           "color": "#15803d"}),
                        html.Button("Save", id="intake-save-btn",
                                     n_clicks=0,
                                     style={"padding": "8px 18px",
                                             "border": "none",
                                             "borderRadius": "5px",
                                             "background": "#0f172a",
                                             "color": "#fff",
                                             "fontSize": "13px",
                                             "fontWeight": 600,
                                             "cursor": "pointer"}),
                        dcc.Link(
                            "Save & view underwriter",
                            id="intake-save-and-view",
                            href=f"/property/{prop_id_i}",
                            style={"padding": "8px 16px",
                                    "fontSize": "12px",
                                    "color": "#2563eb",
                                    "textDecoration": "none",
                                    "border": "1px solid #cbd5e1",
                                    "borderRadius": "5px"},
                        ),
                    ],
                    style={"display": "flex",
                            "justifyContent": "flex-end",
                            "alignItems": "center",
                            "gap": "10px",
                            "padding": "16px 0"},
                ),
            ],
            style={"padding": "16px",
                    "maxWidth": "1500px",
                    "margin": "0 auto"},
        ),
    ])


# ---------------------------------------------------------------------------
# Save callback
# ---------------------------------------------------------------------------
@dash.callback(
    Output("intake-save-msg", "children"),
    Input("intake-save-btn", "n_clicks"),
    State("intake-prop-id", "data"),
    State({"type": "intake", "section": ALL, "slot": ALL, "field": ALL}, "value"),
    State({"type": "intake", "section": ALL, "slot": ALL, "field": ALL}, "id"),
    State({"type": "intake", "section": ALL, "field": ALL}, "value"),
    State({"type": "intake", "section": ALL, "field": ALL}, "id"),
    State({"type": "intake", "section": ALL, "row": ALL, "field": ALL}, "value"),
    State({"type": "intake", "section": ALL, "row": ALL, "field": ALL}, "id"),
    State({"type": "intake-meta", "field": ALL}, "value"),
    prevent_initial_call=True,
)
def save(n_clicks, prop_id,
         slot_vals, slot_ids,
         meta_vals, meta_ids,
         row_vals, row_ids,
         meta2_vals):
    if not n_clicks or not prop_id:
        return no_update

    user = auth.acting_user()

    # Start from existing data so we preserve unmodified fields
    pt = {**title.DEFAULT_PRELIM_TITLE, **db.get_prelim_title(prop_id)}

    # ---- slot inputs (sections 2/3/4) ----
    section_to_key = {"mortgage": "mortgage",
                       "payoff":   "payoff",
                       "sellerMtg":"sellerMortgage"}
    for spec, val in zip(slot_ids, slot_vals):
        section = spec["section"]; slot = spec["slot"]; field = spec["field"]
        bucket = section_to_key.get(section)
        if not bucket: continue
        key = f"{bucket}{slot}"
        existing = dict(pt.get(key) or {})
        if _is_percent(section, field):
            existing[field] = (float(val) / 100) if val not in (None, "") else 0
        elif field in ("company", "assignmentServicer",
                        "date", "assignmentDate", "statementDate"):
            existing[field] = val or ""
        else:
            existing[field] = float(val) if val not in (None, "") else 0
        pt[key] = existing

    # ---- meta fields (parcelId, owners, monthsDelinquent) ----
    for spec, val in zip(meta_ids, meta_vals):
        if spec.get("section") != "meta":
            continue
        pt[spec["field"]] = val if val is not None else ""

    # ---- liens / judgments rows ----
    liens = list(pt.get("liens") or [])
    judgments = list(pt.get("judgments") or [])
    while len(liens) < 3: liens.append(title.empty_lien())
    while len(judgments) < 3: judgments.append(title.empty_judgment())
    for spec, val in zip(row_ids, row_vals):
        section = spec["section"]; row = spec["row"]; field = spec["field"]
        target = liens if section == "lien" else judgments if section == "judgment" else None
        if target is None: continue
        if row >= len(target):
            continue
        if _is_percent(section, field):
            target[row][field] = (float(val) / 100) if val not in (None, "") else 0
        elif ("Date" in field or "holder" in field or "Number" in field
              or "bookPage" in field or "plaintiff" in field):
            target[row][field] = val or ""
        else:
            target[row][field] = float(val) if val not in (None, "") else 0
    pt["liens"] = liens
    pt["judgments"] = judgments

    # ---- Section 1 county (read from intake-meta input) ----
    # We can also update the property row's county field if user typed one.
    # (kept simple: just store within prelim_title; future: copy to properties.county)

    db.set_prelim_title(prop_id, pt, user=user)
    return "✓ Saved."
