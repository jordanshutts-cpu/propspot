"""
Multi-property PropSpot Underwriter dashboard with login.

Run:
    pip install dash openpyxl dash_mantine_components
    python app.py             # launches at http://127.0.0.1:8050

Properties are auto-seeded from properties/*.xlsx on every startup —
no need to run seed.py manually.  New spreadsheets pushed to GitHub will
appear automatically after Railway redeploys.

First-time use: visit /login → create the admin account.  The admin can
invite collaborators from /settings.  Every audit-log entry is attributed to
the logged-in user automatically.
"""
from __future__ import annotations

import os
from datetime import timedelta
from pathlib import Path

import dash
import dash_mantine_components as dmc
from dash import Dash, dcc, html, Input, Output
from flask import redirect, request, session
from werkzeug.middleware.proxy_fix import ProxyFix

import auth
import db
import seed
import styles


db.init_db()
# Auto-import any new .xlsx files from properties/ — safe to run every startup
# because upsert_property_from_xlsx skips addresses already in the database.
seed.seed()

# ---------------------------------------------------------------------------
# Secret key — env var in production, local file for dev
# ---------------------------------------------------------------------------
SECRET_KEY = os.environ.get("SECRET_KEY")
if not SECRET_KEY:
    KEY_FILE = Path(__file__).parent / "secret_key.txt"
    if not KEY_FILE.exists():
        KEY_FILE.write_text(os.urandom(32).hex())
    SECRET_KEY = KEY_FILE.read_text().strip()


external_stylesheets = dmc.styles.ALL

app = Dash(
    __name__,
    use_pages=True,
    pages_folder="pages",
    title="PropSpot Underwriter — Portfolio",
    suppress_callback_exceptions=True,
    external_stylesheets=external_stylesheets,
)
app.server.secret_key = SECRET_KEY
IS_PROD = bool(os.environ.get("DATABASE_URL"))
app.server.config.update(
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=IS_PROD,
)
app.server.wsgi_app = ProxyFix(app.server.wsgi_app, x_proto=1, x_host=1)


# ---------------------------------------------------------------------------
# Auth middleware — bounce unauthenticated visitors to /login
# ---------------------------------------------------------------------------
# Only these actual app pages require a login — everything else
# (Dash internals, assets, callbacks) passes through freely.
PROTECTED_PREFIXES = ("/property", "/settings", "/audit", "/add-property")
PROTECTED_EXACT = {"/"}


@app.server.before_request
def _require_auth():
    p = request.path
    if p in ("/login", "/logout"):
        return None
    needs_auth = (p in PROTECTED_EXACT or
                  any(p.startswith(pp) for pp in PROTECTED_PREFIXES))
    if needs_auth and "user" not in session:
        return redirect("/login")
    return None


@app.server.route("/logout")
def _logout():
    auth.logout()
    return redirect("/login")


# ---------------------------------------------------------------------------
# Layout — header (logged-in user + logout) + page container
# ---------------------------------------------------------------------------
def header():
    return html.Div(
        [
            html.Div(
                [
                    html.A(
                        "PropSpot Underwriter",
                        href="/",
                        style={"color": "#fff", "textDecoration": "none",
                                "fontSize": "18px", "fontWeight": 600},
                    ),
                    html.Span(" · Portfolio dashboard",
                               style={"color": "#94a3b8",
                                      "fontSize": "13px",
                                      "marginLeft": "8px"}),
                ]
            ),
            html.Div(id="header-user-area",
                      style={"display": "flex",
                             "alignItems": "center",
                             "gap": "10px"}),
        ],
        style={"background": "#0f172a", "color": "#fff",
               "padding": "12px 22px",
               "display": "flex", "justifyContent": "space-between",
               "alignItems": "center"},
    )


app.layout = dmc.MantineProvider(
    html.Div(
        [
            dcc.Location(id="url"),
            header(),
            dash.page_container,
        ],
        style=styles.PAGE_STYLE,
    ),
)


# ---------------------------------------------------------------------------
# Header user-area — re-renders on every page navigation
# ---------------------------------------------------------------------------
@app.callback(
    Output("header-user-area", "children"),
    Input("url", "pathname"),
)
def _header_user(_pathname):
    user = auth.current_user()
    if not user:
        return html.Span("Not signed in",
                          style={"color": "#94a3b8", "fontSize": "12px"})
    role = auth.current_role() or "user"
    children = [
        html.Span(
            [
                html.Span("Signed in as ",
                           style={"color": "#94a3b8", "fontSize": "12px"}),
                html.B(user, style={"color": "#fff", "fontSize": "13px"}),
                html.Span(f"  ({role})",
                           style={"color": "#94a3b8",
                                  "fontSize": "11px"}),
            ],
        ),
    ]
    if role == "admin":
        children.append(html.A(
            "Settings", href="/settings",
            style={"color": "#cbd5e1", "fontSize": "12px",
                   "textDecoration": "none",
                   "padding": "4px 10px",
                   "border": "1px solid #334155",
                   "borderRadius": "4px"},
        ))
    children.append(html.A(
        "Sign out", href="/logout",
        style={"color": "#cbd5e1", "fontSize": "12px",
               "textDecoration": "none",
               "padding": "4px 10px",
               "border": "1px solid #334155",
               "borderRadius": "4px"},
    ))
    return children


server = app.server  # expose for gunicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8050))
    host = "0.0.0.0" if IS_PROD else "127.0.0.1"
    print()
    print(f"  PropSpot Underwriter — http://{host}:{port}")
    print()
    app.run(host=host, port=port, debug=False)
