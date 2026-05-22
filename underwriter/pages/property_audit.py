"""
/property/<prop_id>/audit  —  full audit log for one property.

Shows every field-level change ever recorded, grouped by snapshot kind
(Initial Pro Forma vs Actual Results), most recent first.
"""
from __future__ import annotations

import dash
from dash import dcc, html

import db
import styles

dash.register_page(__name__, path_template="/property/<prop_id>/audit")


def _entry(e: dict) -> html.Div:
    return html.Div(
        [
            html.Div(
                [
                    html.Span(e["field"],
                               style={"fontWeight": 600, "fontSize": "13px"}),
                    html.Span(
                        f"  ·  {db.KIND_LABELS.get(e['kind'], e['kind'])}",
                        style={"fontSize": "11px",
                                "color": "#64748b",
                                "marginLeft": "6px"}),
                ],
            ),
            html.Div(
                f"by {e['changed_by']}  ·  "
                f"{e['changed_at'][:19].replace('T', ' ')} UTC",
                style={"fontSize": "11px", "color": "#94a3b8",
                        "marginTop": "2px"},
            ),
            html.Div(
                [
                    html.Span(styles.fmt_value(e["field"], e["old_value"]),
                               style={"color": "#b91c1c",
                                      "textDecoration": "line-through",
                                      "fontVariantNumeric": "tabular-nums"}),
                    html.Span(" → ", style={"color": "#94a3b8",
                                              "margin": "0 6px"}),
                    html.Span(styles.fmt_value(e["field"], e["new_value"]),
                               style={"color": "#15803d", "fontWeight": 600,
                                      "fontVariantNumeric": "tabular-nums"}),
                ],
                style={"fontSize": "13px", "marginTop": "4px"},
            ),
        ],
        style={"padding": "10px 14px",
               "borderTop": "1px solid #f1f1ee"},
    )


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
            html.H2("Property not found.", style={"padding": "20px"}),
            dcc.Link("← Portfolio", href="/", style={"padding": "0 20px"}),
        ])

    log = db.get_audit_log(prop_id_i, limit=2000)

    return html.Div([
        html.Div(
            [
                dcc.Link("← Back to property",
                         href=f"/property/{prop_id_i}",
                         style={"color": "#94a3b8", "fontSize": "12px",
                                 "textDecoration": "none"}),
                html.Div(prop["address"],
                         style={"fontSize": "18px", "fontWeight": 600,
                                 "marginTop": "4px"}),
                html.Div(f"{len(log)} change{'s' if len(log) != 1 else ''} recorded",
                         style={"fontSize": "13px", "color": "#94a3b8",
                                 "marginTop": "2px"}),
            ],
            style={"padding": "16px 22px",
                   "background": "#0f172a", "color": "#fff"},
        ),
        html.Div(
            [
                html.Div(
                    [
                        html.Div("Audit log",
                                 style={**styles.PANEL_H,
                                        "background": "#fafaf8"}),
                        html.Div(
                            ([_entry(e) for e in log]
                              if log
                              else [html.Div("No changes yet.",
                                              style={"padding": "16px",
                                                      "fontSize": "13px",
                                                      "color": "#64748b"})]),
                        ),
                    ],
                    style=styles.PANEL,
                ),
            ],
            style={"padding": "20px",
                   "maxWidth": "900px",
                   "margin": "0 auto"},
        ),
    ])
