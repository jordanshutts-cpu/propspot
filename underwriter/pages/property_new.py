"""
/property/new  —  add a new property by typing in the basic identifying info.

Pre-loads both Initial Pro Forma and Actual Results with `model.DEFAULTS` (the
base assumptions consistent with the 5 sample underwriters), then redirects
to /property/<new_id> so the user can fill in valuation/rental specifics.
"""
from __future__ import annotations

import dash
from dash import dcc, html, Input, Output, State, no_update

import auth
import db
import styles
from model import DEFAULTS, _default_rental_opex

dash.register_page(__name__, path="/add-property", name="Add Property")


def layout():
    return html.Div(
        [
            html.Div(
                [
                    dcc.Link("← Portfolio", href="/",
                             style={"color": "#94a3b8", "fontSize": "12px",
                                     "textDecoration": "none"}),
                    html.Div("Add new property",
                             style={"fontSize": "20px", "fontWeight": 600,
                                     "marginTop": "4px"}),
                    html.Div(
                        "We'll create both an Initial Pro Forma and an Actual Results "
                        "underwriter, pre-loaded with the standard base assumptions. "
                        "You can fill in valuation, rental, and deal-specific "
                        "details on the next screen.",
                        style={"color": "#475569", "fontSize": "13px",
                                "marginTop": "8px",
                                "maxWidth": "640px"},
                    ),
                ],
                style={"padding": "20px 22px",
                       "background": "#0f172a", "color": "#fff"},
            ),
            html.Div(
                [
                    html.Div(
                        [
                            html.Div("Address", style=styles.LABEL),
                            dcc.Input(id="np-address", type="text",
                                      placeholder="123 Main St",
                                      style=styles.INPUT),

                            html.Div(
                                [
                                    html.Div([html.Div("City", style=styles.LABEL),
                                               dcc.Input(id="np-city", type="text",
                                                          style=styles.INPUT)]),
                                    html.Div([html.Div("State (2 letters)",
                                                         style=styles.LABEL),
                                               dcc.Input(id="np-state", type="text",
                                                          maxLength=2,
                                                          style=styles.INPUT)]),
                                    html.Div([html.Div("ZIP", style=styles.LABEL),
                                               dcc.Input(id="np-zip", type="text",
                                                          maxLength=10,
                                                          style=styles.INPUT)]),
                                ],
                                style={"display": "grid",
                                       "gridTemplateColumns": "2fr 1fr 1fr",
                                       "gap": "10px",
                                       "marginTop": "10px"},
                            ),

                            html.Div(
                                [
                                    html.Div([html.Div("County", style=styles.LABEL),
                                               dcc.Input(id="np-county", type="text",
                                                          style=styles.INPUT)]),
                                    html.Div([html.Div("Square footage", style=styles.LABEL),
                                               dcc.Input(id="np-sqft", type="number",
                                                          min=0,
                                                          style=styles.INPUT)]),
                                    html.Div([html.Div("List price ($)", style=styles.LABEL),
                                               dcc.Input(id="np-list-price",
                                                          type="number", min=0,
                                                          style=styles.INPUT)]),
                                ],
                                style={"display": "grid",
                                       "gridTemplateColumns": "1fr 1fr 1fr",
                                       "gap": "10px",
                                       "marginTop": "10px"},
                            ),

                            html.Div(id="np-error",
                                      style={"color": "#b91c1c", "fontSize": "13px",
                                              "marginTop": "12px"}),

                            html.Div(
                                [
                                    html.Button("Cancel",
                                                 id="np-cancel",
                                                 n_clicks=0,
                                                 style={"padding": "8px 16px",
                                                         "border": "1px solid #cbd5e1",
                                                         "borderRadius": "6px",
                                                         "background": "#fff",
                                                         "fontSize": "13px",
                                                         "cursor": "pointer",
                                                         "marginRight": "8px"}),
                                    html.Button("Create property",
                                                 id="np-create",
                                                 n_clicks=0,
                                                 style={"padding": "8px 16px",
                                                         "border": "none",
                                                         "borderRadius": "6px",
                                                         "background": "#0f172a",
                                                         "color": "#fff",
                                                         "fontSize": "13px",
                                                         "fontWeight": 600,
                                                         "cursor": "pointer"}),
                                ],
                                style={"marginTop": "20px",
                                       "display": "flex",
                                       "justifyContent": "flex-end"},
                            ),
                            dcc.Location(id="np-redirect", refresh=True),
                        ],
                        style={"padding": "20px",
                                "background": "#fff",
                                "border": "1px solid #d8d8d4",
                                "borderRadius": "8px",
                                "maxWidth": "640px"},
                    ),
                ],
                style={"padding": "20px",
                       "maxWidth": "1500px",
                       "margin": "0 auto"},
            ),
        ]
    )


@dash.callback(
    Output("np-error", "children"),
    Output("np-redirect", "href"),
    Input("np-create", "n_clicks"),
    Input("np-cancel", "n_clicks"),
    State("np-address", "value"),
    State("np-city",    "value"),
    State("np-state",   "value"),
    State("np-zip",     "value"),
    State("np-county",  "value"),
    State("np-sqft",    "value"),
    State("np-list-price", "value"),
    prevent_initial_call=True,
)
def create_property(create_clicks, cancel_clicks, addr, city, state, zip_,
                    county, sqft, list_price):
    if dash.ctx.triggered_id == "np-cancel":
        return "", "/"
    if not create_clicks:
        return no_update, no_update

    if not addr or not addr.strip():
        return "Address is required.", no_update
    if not city or not state:
        return "City and state are required.", no_update

    full_addr = f"{addr.strip()}, {city.strip()}, {state.strip().upper()} {(zip_ or '').strip()}".strip()
    user = auth.acting_user()
    list_price = list_price or 0

    pro_forma = dict(DEFAULTS)
    pro_forma["rentalOpEx"] = _default_rental_opex(0, 0, 0)
    pro_forma["listPrice"] = list_price

    try:
        prop_id = db.create_property(
            address=full_addr,
            city=city.strip(),
            state=state.strip().upper(),
            zip=(zip_ or "").strip(),
            county=(county or "").strip(),
            sqft=sqft or 0,
            list_price=list_price,
            source_file="(manual entry)",
            pro_forma=pro_forma,
            user=user,
        )
    except ValueError as e:
        return str(e), no_update

    # Redirect to intake page so the user can enter title/foreclosure
    # details before working in the underwriter.
    return "", f"/property/{prop_id}/intake"
