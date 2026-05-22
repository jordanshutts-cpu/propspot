"""
/login  —  username + password sign-in.

If no users exist yet, the form switches to "Create first admin" mode
(account with role=admin is created and immediately logged in).
"""
from __future__ import annotations

import dash
from dash import dcc, html, Input, Output, State, no_update

import auth
import db
import styles

dash.register_page(__name__, path="/login", name="Sign in")


def _input(field_id: str, placeholder: str, type_: str = "text"):
    return dcc.Input(
        id=field_id, type=type_, placeholder=placeholder,
        debounce=False, autoComplete="off",
        style={**styles.INPUT, "fontSize": "14px",
               "padding": "8px 10px", "marginBottom": "8px"},
    )


def layout():
    first_run = not db.has_any_users()

    if first_run:
        title = "Create the first admin"
        subtitle = ("This is a brand-new install.  The first account you "
                     "create becomes the administrator and can invite the "
                     "rest of the team from the Settings page.")
    else:
        title = "Sign in"
        subtitle = "Use your username and password to access the dashboard."

    return html.Div(
        [
            dcc.Store(id="login-mode", data="first_run" if first_run else "login"),
            html.Div(
                [
                    html.H2(title,
                             style={"margin": "0 0 6px",
                                     "fontSize": "20px",
                                     "fontWeight": 600}),
                    html.Div(subtitle,
                              style={"fontSize": "13px",
                                      "color": "#475569",
                                      "marginBottom": "18px",
                                      "lineHeight": "1.45"}),

                    html.Div("Username", style=styles.LABEL_SM),
                    _input("login-username", "username"),

                    # Always rendered so the callback can reference it;
                    # hidden unless this is the first-run admin setup.
                    html.Div([
                        html.Div("Full name (shown in audit log)",
                                 style={**styles.LABEL_SM, "marginTop": "10px"}),
                        _input("login-fullname", "Jane Doe"),
                    ], style={"display": "block" if first_run else "none"}),

                    html.Div("Password",
                              style={**styles.LABEL_SM, "marginTop": "4px"}),
                    _input("login-password",
                            "at least 6 characters" if first_run
                            else "password",
                            type_="password"),

                    html.Div(id="login-error",
                              style={"color": "#b91c1c",
                                      "fontSize": "13px",
                                      "marginTop": "8px",
                                      "minHeight": "18px"}),

                    html.Button(
                        "Create admin & sign in" if first_run else "Sign in",
                        id="login-submit", n_clicks=0,
                        style={"padding": "10px",
                                "border": "none",
                                "borderRadius": "5px",
                                "background": "#0f172a",
                                "color": "#fff",
                                "fontSize": "14px",
                                "fontWeight": 600,
                                "cursor": "pointer",
                                "width": "100%",
                                "marginTop": "12px"},
                    ),

                    dcc.Location(id="login-redirect", refresh=True),
                ],
                style={"background": "#fff",
                        "border": "1px solid #d8d8d4",
                        "borderRadius": "8px",
                        "padding": "26px 24px",
                        "width": "360px",
                        "boxShadow": "0 2px 8px rgba(0,0,0,0.05)"},
            ),
        ],
        style={"display": "flex",
                "alignItems": "center",
                "justifyContent": "center",
                "minHeight": "calc(100vh - 80px)"},
    )


@dash.callback(
    Output("login-error", "children"),
    Output("login-redirect", "href"),
    Input("login-submit", "n_clicks"),
    State("login-username", "value"),
    State("login-password", "value"),
    State("login-fullname", "value"),
    State("login-mode", "data"),
    prevent_initial_call=True,
)
def submit(n_clicks, username, password, full_name, mode):
    if not n_clicks:
        return no_update, no_update
    username = (username or "").strip()
    password = password or ""
    if not username or not password:
        return "Username and password are required.", no_update

    if mode == "first_run":
        try:
            db.create_user(username=username, password=password,
                            role="admin", full_name=(full_name or "").strip(),
                            created_by="(self, first run)")
        except ValueError as e:
            return str(e), no_update
        # Log them in immediately
        auth.login(username, password)
        return "", "/"

    if auth.login(username, password):
        return "", "/"
    return "Invalid username or password.", no_update
