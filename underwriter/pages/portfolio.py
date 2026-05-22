"""
/  —  Portfolio dashboard.

Sortable / filterable table of every property, computed against its
Actual Results snapshot.  Click an address to drill into the property's
Initial Pro Forma + Actual Results underwriters.

Columns (per latest spec):
    Address · Purchase · Reno · Rent/Value · Bridge: Cash to Close ·
    BRIDGE: CLOSING + OP COSTS · BRIDGE: (IN)/OUTFLOWS ·
    DSCR: Refi Gross Proceeds · DSCR: Closing Expenses ·
    DSCR: (IN)/OUTFLOWS · Best · Flip $ · Flip IRR · DSCR $ · DSCR IRR ·
    Updated · By

A totals row sums all dollar columns at the bottom.
"""
from __future__ import annotations

import json

import dash
from dash import dash_table, dcc, html

import db
import styles
from model import (compute, best_strategy, sync_op_ex,
                    nav_if_sold_today, yr1_dscr_pnl)

dash.register_page(__name__, path="/", name="Portfolio")


def _incomplete_row(prop: dict) -> dict:
    """Stub row for a property whose data cannot be computed yet."""
    return {
        "id":             prop["id"],
        "address":        prop["address"],
        "status":         "⚠ Needs data",
        "purchase_n": 0, "purchase": "", "reno_n": 0, "reno": "",
        "rent_to_value": "", "rent_to_value_n": 0,
        "br_cash_close_n": 0, "br_cash_close": "",
        "br_close_op_n": 0,  "br_close_op": "",
        "br_outflows_n": 0,  "br_outflows": "",
        "dscr_outflows_n": 0, "dscr_outflows": "",
        "total_outflow_n": 0, "total_outflow": "",
        "nav_n": 0, "nav": "", "yr1_pnl_n": 0, "yr1_pnl": "",
        "best": "", "flip_profit_n": 0, "flip_profit": "",
        "flip_irr": "", "flip_irr_n": 0,
        "dscr_profit_n": 0, "dscr_profit": "",
        "dscr_irr": "", "dscr_irr_n": 0,
        "updated_at": "", "updated_by": "",
    }


def _row_for(prop: dict) -> dict:
    """Compute Actual-snapshot summary metrics for one property."""
    if prop["actual_data"] is None:
        return _incomplete_row(prop)
    try:
        ar = sync_op_ex({**json.loads(prop["actual_data"]),
                          "listPrice": prop["list_price"]})
        r = compute(ar)
    except Exception:
        # Property has incomplete/invalid data (e.g. manually added but not
        # yet filled in).  Show a stub row rather than crashing the page.
        return _incomplete_row(prop)

    # Manually-added properties that haven't been filled in yet will have a
    # $0 purchase price — treat those as incomplete too.
    if (ar.get("purchasePrice", 0) or 0) == 0 and prop.get("source_file") == "(manual entry)":
        return _incomplete_row(prop)

    purchase = ar.get("purchasePrice", 0) or 0
    reno = ar.get("renoBudget", 0) or 0
    purch_reno = purchase + reno
    rent_mo = ar.get("rentOverride", 0) or ar.get("uwRent", 0) or 0
    rent_to_value = (rent_mo / purch_reno) if purch_reno > 0 else 0

    return {
        "id":             prop["id"],
        "address":        prop["address"],
        "status":         "",
        # numeric (sort) + display columns
        "purchase_n":     purchase,
        "purchase":       styles.fmt0(purchase),
        "reno_n":         reno,
        "reno":           styles.fmt0(reno),
        "rent_to_value":  f"{rent_to_value*100:.2f}%",
        "rent_to_value_n":rent_to_value,
        "br_cash_close_n":r["V19"],
        "br_cash_close":  styles.fmt0(r["V19"]),
        "br_close_op_n":  r["V24"],
        "br_close_op":    styles.fmt0(r["V24"]),
        "br_outflows_n":  r["V26"],
        "br_outflows":    styles.fmt0(r["V26"]),
        "dscr_outflows_n":r["Z22"],
        "dscr_outflows":  styles.fmt0(r["Z22"]),
        "total_outflow_n":r["Z26"],
        "total_outflow":  styles.fmt0(r["Z26"]),
        "nav_n":          nav_if_sold_today(ar, r),
        "nav":            styles.fmt0(nav_if_sold_today(ar, r)),
        "yr1_pnl_n":      yr1_dscr_pnl(ar, r),
        "yr1_pnl":        styles.fmt0(yr1_dscr_pnl(ar, r)),
        "best":           best_strategy(r),
        "flip_profit_n":  r["flip_profit"],
        "flip_profit":    styles.fmt0(r["flip_profit"]),
        "flip_irr":       styles.pct(r["flip_irr"], 1),
        "flip_irr_n":     r["flip_irr"],
        "dscr_profit_n":  r["dscr_profit"],
        "dscr_profit":    styles.fmt0(r["dscr_profit"]),
        "dscr_irr":       styles.pct(r["dscr_irr"], 1),
        "dscr_irr_n":     r["dscr_irr"],
        "updated_at":     (prop.get("actual_updated_at") or "")[:10],
        "updated_by":     prop.get("actual_updated_by") or "",
    }


def _totals_row(rows: list[dict]) -> dict:
    """Sum dollar columns; leave non-additive columns blank.
    Only complete rows (status == '') are included in the totals."""
    complete = [r for r in rows if r.get("status") == ""]
    if not complete:
        return {}
    cols_to_sum = ["purchase_n", "reno_n",
                    "br_cash_close_n", "br_close_op_n", "br_outflows_n",
                    "dscr_outflows_n", "total_outflow_n",
                    "nav_n", "yr1_pnl_n",
                    "flip_profit_n", "dscr_profit_n"]
    sums = {c: sum(r.get(c, 0) for r in complete) for c in cols_to_sum}
    n = len(complete)
    return {
        "id": -1,
        "address": f"TOTAL — {n} prop{'s' if n != 1 else ''}",
        "status":         "",
        "purchase":       styles.fmt0(sums["purchase_n"]),
        "reno":           styles.fmt0(sums["reno_n"]),
        "rent_to_value":  "",
        "br_cash_close":  styles.fmt0(sums["br_cash_close_n"]),
        "br_close_op":    styles.fmt0(sums["br_close_op_n"]),
        "br_outflows":    styles.fmt0(sums["br_outflows_n"]),
        "dscr_outflows":  styles.fmt0(sums["dscr_outflows_n"]),
        "total_outflow":  styles.fmt0(sums["total_outflow_n"]),
        "nav":            styles.fmt0(sums["nav_n"]),
        "yr1_pnl":        styles.fmt0(sums["yr1_pnl_n"]),
        "best":           "",
        "flip_profit":    styles.fmt0(sums["flip_profit_n"]),
        "flip_irr":       "",
        "dscr_profit":    styles.fmt0(sums["dscr_profit_n"]),
        "dscr_irr":       "",
        "updated_at":     "",
        "updated_by":     "",
    }


def _summary_cards(rows: list[dict]) -> html.Div:
    # Only use complete rows for summary stats
    complete = [r for r in rows if r.get("status") == ""]
    n_incomplete = len(rows) - len(complete)
    if not rows:
        return html.Div(
            html.Div("No properties yet.  Click \"+ Add property\" above.",
                     style={"padding": "32px", "textAlign": "center",
                             "color": "#64748b", "fontSize": "13px"}),
            style={**styles.PANEL,
                   "maxWidth": "1700px",
                   "margin": "12px auto"},
        )
    n = len(complete)
    n_dscr_pick = sum(1 for r in complete if r["best"] == "DSCR")
    n_flip_pick = sum(1 for r in complete if r["best"] == "Flip")
    n_neither = n - n_dscr_pick - n_flip_pick
    avg_flip_profit = sum(r["flip_profit_n"] for r in complete) / n if n else 0
    avg_dscr_profit = sum(r["dscr_profit_n"] for r in complete) / n if n else 0

    def card(title, value, sub=""):
        return html.Div(
            [
                html.Div(title, style={"fontSize": "10px", "color": "#64748b",
                                         "textTransform": "uppercase",
                                         "letterSpacing": "0.05em"}),
                html.Div(value, style={"fontSize": "18px",
                                         "fontWeight": 700,
                                         "marginTop": "2px"}),
                html.Div(sub, style={"fontSize": "11px", "color": "#64748b"}),
            ],
            style={"flex": 1, "padding": "10px 14px",
                   "background": "#fff",
                   "border": "1px solid #d8d8d4",
                   "borderRadius": "6px"},
        )

    cards = [
        card("Properties", str(n),
             f"+ {n_incomplete} awaiting data" if n_incomplete else ""),
        card("Best = DSCR", str(n_dscr_pick),
             f"{n_dscr_pick/n*100:.0f}% of portfolio" if n else ""),
        card("Best = Flip", str(n_flip_pick),
             f"{n_flip_pick/n*100:.0f}%" if n else ""),
        card("No clear winner", str(n_neither)),
        card("Avg Flip $", styles.fmt0(avg_flip_profit)),
        card("Avg DSCR $", styles.fmt0(avg_dscr_profit)),
    ]
    return html.Div(
        cards,
        style={"display": "flex", "gap": "8px",
               "padding": "10px 12px 0",
               "maxWidth": "1700px", "margin": "0 auto"},
    )


# Column definitions — order matters for display.
COLUMNS = [
    {"name": "Address",                          "id": "address"},
    {"name": "Status",                           "id": "status"},
    {"name": "Purchase",                         "id": "purchase"},
    {"name": "Reno",                             "id": "reno"},
    {"name": "Rent / Value",                     "id": "rent_to_value"},
    {"name": "Bridge Cash to Close",             "id": "br_cash_close"},
    {"name": "Bridge Closing + Op Costs",        "id": "br_close_op"},
    {"name": "Bridge (In)/Outflows",             "id": "br_outflows"},
    {"name": "DSCR (In)/Outflows",               "id": "dscr_outflows"},
    {"name": "Total Outflow (BR+DSCR)",          "id": "total_outflow"},
    {"name": "NAV",                              "id": "nav"},
    {"name": "Yr 1 DSCR P&L",                    "id": "yr1_pnl"},
    {"name": "Best",                             "id": "best"},
    {"name": "Flip $",                           "id": "flip_profit"},
    {"name": "Flip IRR",                         "id": "flip_irr"},
    {"name": "DSCR $",                           "id": "dscr_profit"},
    {"name": "DSCR IRR",                         "id": "dscr_irr"},
    {"name": "Updated",                          "id": "updated_at"},
    {"name": "By",                               "id": "updated_by"},
]

NUMERIC_COL_IDS = {
    "purchase", "reno", "rent_to_value",
    "br_cash_close", "br_close_op", "br_outflows",
    "dscr_outflows", "total_outflow", "nav", "yr1_pnl",
    "flip_profit", "flip_irr", "dscr_profit", "dscr_irr",
}


def layout():
    props = db.list_properties()
    rows = [r for r in (_row_for(p) for p in props) if r]
    totals = [_totals_row(rows)] if rows else []

    return html.Div(
        [
            _summary_cards(rows),
            html.Div(
                [
                    html.Div(
                        [
                            html.Div(
                                [
                                    html.H2("All Properties",
                                             style={**styles.PANEL_H,
                                                     "borderRadius": "6px 6px 0 0",
                                                     "padding": 0,
                                                     "border": "none",
                                                     "background": "transparent",
                                                     "margin": 0,
                                                     "fontSize": "12px"}),
                                    dcc.Link("+ Add property",
                                              href="/add-property",
                                              style={"padding": "4px 10px",
                                                      "background": "#0f172a",
                                                      "color": "#fff",
                                                      "borderRadius": "4px",
                                                      "textDecoration": "none",
                                                      "fontSize": "11px",
                                                      "fontWeight": 600}),
                                ],
                                style={"display": "flex",
                                       "justifyContent": "space-between",
                                       "alignItems": "center",
                                       "padding": "8px 12px",
                                       "background": "#fafaf8",
                                       "borderBottom": "1px solid #d8d8d4",
                                       "borderRadius": "6px 6px 0 0"},
                            ),
                            html.Div(
                                [
                                    dash_table.DataTable(
                                        id="portfolio-table",
                                        columns=COLUMNS,
                                        data=rows + totals,
                                        sort_action="native",
                                        filter_action="native",
                                        page_size=100,
                                        cell_selectable=True,
                                        fixed_rows={"headers": True},
                                        style_table={"overflowX": "auto"},
                                        style_header={
                                            "background": "#fafaf8",
                                            "fontWeight": "600",
                                            "fontSize": "10px",
                                            "textTransform": "uppercase",
                                            "letterSpacing": "0.04em",
                                            "color": "#475569",
                                            "borderBottom": "1px solid #d8d8d4",
                                            "padding": "6px 5px",
                                            "textAlign": "left",
                                            "whiteSpace": "normal",
                                            "lineHeight": "1.15",
                                        },
                                        style_cell={
                                            "fontSize": "11px",
                                            "fontFamily":
                                                "-apple-system,BlinkMacSystemFont,"
                                                "'Segoe UI',Roboto,sans-serif",
                                            "padding": "4px 5px",
                                            "borderBottom": "1px solid #f1f1ee",
                                            "textAlign": "left",
                                            "whiteSpace": "normal",
                                            "minWidth": "60px",
                                            "maxWidth": "180px",
                                        },
                                        style_data_conditional=[
                                            {"if": {"column_id":
                                                     list(NUMERIC_COL_IDS)},
                                             "textAlign": "right",
                                             "fontVariantNumeric":
                                                 "tabular-nums"},
                                            {"if": {"filter_query":
                                                     "{best} = 'DSCR'",
                                                     "column_id": "best"},
                                             "background": "#d9ead3",
                                             "color": "#0b3a16",
                                             "fontWeight": 600},
                                            {"if": {"filter_query":
                                                     "{best} = 'Flip'",
                                                     "column_id": "best"},
                                             "background": "#fff2cc",
                                             "color": "#7f5800",
                                             "fontWeight": 600},
                                            {"if": {"filter_query":
                                                     "{best} = 'None'",
                                                     "column_id": "best"},
                                             "background": "#f4cccc",
                                             "color": "#7f0000"},
                                            {"if": {"column_id": "address"},
                                             "color": "#2563eb",
                                             "cursor": "pointer",
                                             "textDecoration": "underline",
                                             "fontWeight": 500},
                                            # Incomplete / awaiting data rows
                                            {"if": {"filter_query":
                                                     "{status} = '⚠ Needs data'"},
                                             "background": "#fffbeb",
                                             "color": "#92400e",
                                             "fontStyle": "italic"},
                                            {"if": {"filter_query":
                                                     "{status} = '⚠ Needs data'",
                                                    "column_id": "status"},
                                             "fontWeight": 600,
                                             "fontStyle": "normal"},
                                            # Totals row styling — id = -1
                                            {"if": {"filter_query": "{id} = -1"},
                                             "background": "#fafaf8",
                                             "fontWeight": 700,
                                             "borderTop": "2px solid #1f2937",
                                             "color": "#0f172a",
                                             "textDecoration": "none",
                                             "cursor": "default"},
                                            {"if": {"filter_query": "{id} = -1",
                                                    "column_id": "address"},
                                             "color": "#0f172a",
                                             "textDecoration": "none",
                                             "cursor": "default"},
                                        ],
                                    ),
                                ],
                                style={"padding": "0"},
                            ),
                        ],
                        style={**styles.PANEL, "marginBottom": "0"},
                    ),
                ],
                style={"padding": "10px 12px",
                       "maxWidth": "1700px",
                       "margin": "0 auto"},
            ),
            dcc.Location(id="portfolio-nav", refresh=True),
        ]
    )


@dash.callback(
    dash.Output("portfolio-nav", "href"),
    dash.Input("portfolio-table", "active_cell"),
    dash.State("portfolio-table", "data"),
    prevent_initial_call=True,
)
def navigate_on_click(active_cell, rows):
    if not active_cell or active_cell.get("column_id") != "address":
        return dash.no_update
    row = rows[active_cell["row"]]
    if row.get("id") == -1:  # totals row
        return dash.no_update
    return f"/property/{row['id']}"
