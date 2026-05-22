"""
/settings  —  admin user management.

Admins see:
  * a list of all users (username, role, full name, email, created date)
  * controls to promote/demote, reset password, and delete each user
  * an "Invite collaborator" form to create a new user

Non-admins are redirected to /.
"""
from __future__ import annotations

import dash
from dash import dcc, html, Input, Output, State, ALL, ctx, no_update

import auth
import db
import styles

dash.register_page(__name__, path="/settings", name="Settings")


def _user_row(u: dict, current_username: str) -> html.Tr:
    is_self = u["username"] == current_username
    return html.Tr(
        [
            html.Td(u["username"], style={"padding": "6px 8px",
                                           "fontWeight": 600,
                                           "fontSize": "13px"}),
            html.Td(u.get("full_name") or "—",
                    style={"padding": "6px 8px", "fontSize": "13px"}),
            html.Td(u.get("email") or "—",
                    style={"padding": "6px 8px", "fontSize": "12px",
                           "color": "#475569"}),
            html.Td(
                html.Span(u["role"].upper(),
                           style={"fontSize": "10px",
                                  "padding": "2px 8px",
                                  "borderRadius": "10px",
                                  "background": "#0f172a" if u["role"] == "admin"
                                                else "#e2e8f0",
                                  "color": "#fff" if u["role"] == "admin"
                                            else "#0f172a",
                                  "fontWeight": 600}),
                style={"padding": "6px 8px"},
            ),
            html.Td((u.get("created_at") or "")[:10],
                    style={"padding": "6px 8px", "fontSize": "11px",
                           "color": "#64748b"}),
            html.Td(
                html.Div(
                    [
                        # Reset password
                        dcc.Input(
                            id={"type": "user-pwd",
                                 "username": u["username"]},
                            type="password", placeholder="new password",
                            style={**styles.INPUT_SM, "width": "120px",
                                    "marginRight": "4px"},
                        ),
                        html.Button(
                            "Reset",
                            id={"type": "user-pwd-btn",
                                 "username": u["username"]},
                            n_clicks=0,
                            style={"padding": "3px 8px",
                                    "fontSize": "11px",
                                    "background": "#fff",
                                    "border": "1px solid #cbd5e1",
                                    "borderRadius": "4px",
                                    "cursor": "pointer",
                                    "marginRight": "8px"},
                        ),
                        # Toggle role
                        html.Button(
                            ("Demote" if u["role"] == "admin"
                              else "Promote"),
                            id={"type": "user-role-btn",
                                 "username": u["username"]},
                            n_clicks=0,
                            disabled=is_self,
                            style={"padding": "3px 8px",
                                    "fontSize": "11px",
                                    "background": "#fff",
                                    "border": "1px solid #cbd5e1",
                                    "borderRadius": "4px",
                                    "cursor": "pointer" if not is_self else "not-allowed",
                                    "opacity": 1 if not is_self else 0.4,
                                    "marginRight": "8px"},
                        ),
                        # Delete
                        html.Button(
                            "Delete",
                            id={"type": "user-del-btn",
                                 "username": u["username"]},
                            n_clicks=0,
                            disabled=is_self,
                            style={"padding": "3px 8px",
                                    "fontSize": "11px",
                                    "background": "#fff",
                                    "border": "1px solid #fca5a5",
                                    "color": "#b91c1c",
                                    "borderRadius": "4px",
                                    "cursor": "pointer" if not is_self else "not-allowed",
                                    "opacity": 1 if not is_self else 0.4},
                        ),
                    ],
                    style={"display": "flex", "alignItems": "center"},
                ),
                style={"padding": "6px 8px"},
            ),
        ],
    )


def _users_table(current_username: str) -> html.Div:
    users = db.list_users()
    return html.Div(
        html.Table(
            [
                html.Thead(html.Tr([
                    html.Th(c, style={**styles.TH, "fontSize": "11px"})
                    for c in ("Username", "Full name", "Email",
                               "Role", "Created", "Actions")
                ])),
                html.Tbody([_user_row(u, current_username) for u in users]),
            ],
            style={"width": "100%", "borderCollapse": "collapse"},
        ),
        style={"overflowX": "auto"},
    )


def _invite_form() -> html.Div:
    return html.Div(
        [
            html.H3("Invite a collaborator",
                     style={"fontSize": "14px",
                            "margin": "0 0 8px",
                            "fontWeight": 600}),
            html.Div(
                [
                    html.Div([html.Div("Username", style=styles.LABEL_SM),
                               dcc.Input(id="inv-username", type="text",
                                          style=styles.INPUT_SM)]),
                    html.Div([html.Div("Password", style=styles.LABEL_SM),
                               dcc.Input(id="inv-password", type="password",
                                          placeholder="≥ 6 characters",
                                          style=styles.INPUT_SM)]),
                    html.Div([html.Div("Full name", style=styles.LABEL_SM),
                               dcc.Input(id="inv-fullname", type="text",
                                          style=styles.INPUT_SM)]),
                    html.Div([html.Div("Email (optional)",
                                         style=styles.LABEL_SM),
                               dcc.Input(id="inv-email", type="email",
                                          style=styles.INPUT_SM)]),
                    html.Div([html.Div("Role", style=styles.LABEL_SM),
                               dcc.Dropdown(
                                   id="inv-role",
                                   options=[{"label": "User", "value": "user"},
                                            {"label": "Admin", "value": "admin"}],
                                   value="user",
                                   clearable=False,
                                   style={"fontSize": "13px"})]),
                ],
                style={"display": "grid",
                       "gridTemplateColumns": "1fr 1fr 1fr 1fr 0.7fr",
                       "gap": "8px",
                       "marginBottom": "10px"},
            ),
            html.Div(
                [
                    html.Button(
                        "Send invite",
                        id="inv-submit",
                        n_clicks=0,
                        style={"padding": "6px 14px",
                                "fontSize": "13px",
                                "background": "#0f172a",
                                "color": "#fff",
                                "border": "none",
                                "borderRadius": "5px",
                                "fontWeight": 600,
                                "cursor": "pointer"},
                    ),
                    html.Span(id="inv-msg",
                               style={"marginLeft": "12px",
                                       "fontSize": "12px"}),
                ],
                style={"display": "flex", "alignItems": "center"},
            ),
            html.Div(
                "Currently this app uses honor-system invites — share the "
                "username and password directly with the new collaborator. "
                "We can swap to email-based invites later if needed.",
                style={"fontSize": "11px", "color": "#64748b",
                        "fontStyle": "italic", "marginTop": "8px"},
            ),
        ],
        style={**styles.PANEL, "padding": "16px"},
    )


def layout():
    if not auth.is_admin():
        return html.Div(
            [
                html.Div("Settings is admin-only.",
                         style={"padding": "20px",
                                 "fontSize": "14px"}),
                dcc.Location(id="settings-redirect", href="/", refresh=True),
            ]
        )

    return html.Div(
        [
            html.Div(
                [
                    dcc.Link("← Portfolio", href="/",
                             style={"color": "#94a3b8", "fontSize": "12px",
                                     "textDecoration": "none"}),
                    html.Div("Settings — Users & Access",
                             style={"fontSize": "20px", "fontWeight": 600,
                                     "marginTop": "4px"}),
                    html.Div(
                        "Manage who can access this dashboard.  Every action "
                        "they take is recorded against their username in the "
                        "audit log.",
                        style={"color": "#94a3b8", "fontSize": "12px",
                                "marginTop": "4px",
                                "maxWidth": "640px"},
                    ),
                ],
                style={"padding": "18px 22px",
                       "background": "#0f172a", "color": "#fff"},
            ),
            html.Div(
                [
                    html.Div(
                        [
                            html.Div("All users", style=styles.PANEL_H),
                            html.Div(_users_table(auth.current_user() or ""),
                                      id="settings-users-table",
                                      style={"padding": "8px 14px"}),
                        ],
                        style=styles.PANEL,
                    ),
                    _invite_form(),
                    html.Div(id="settings-msg",
                              style={"fontSize": "13px",
                                      "color": "#15803d",
                                      "marginTop": "10px",
                                      "minHeight": "18px"}),
                ],
                style={"padding": "20px",
                       "maxWidth": "1100px",
                       "margin": "0 auto"},
            ),
        ]
    )


# ---------------------------------------------------------------------------
# Callbacks
# ---------------------------------------------------------------------------
@dash.callback(
    Output("settings-users-table", "children"),
    Output("settings-msg", "children"),
    Output("inv-msg", "children"),
    Input("inv-submit", "n_clicks"),
    Input({"type": "user-pwd-btn", "username": ALL}, "n_clicks"),
    Input({"type": "user-role-btn", "username": ALL}, "n_clicks"),
    Input({"type": "user-del-btn", "username": ALL}, "n_clicks"),
    State("inv-username", "value"),
    State("inv-password", "value"),
    State("inv-fullname", "value"),
    State("inv-email", "value"),
    State("inv-role", "value"),
    State({"type": "user-pwd", "username": ALL}, "value"),
    State({"type": "user-pwd", "username": ALL}, "id"),
    prevent_initial_call=True,
)
def settings_actions(inv_clicks, _pwd_clicks, _role_clicks, _del_clicks,
                     inv_user, inv_pw, inv_fullname, inv_email, inv_role,
                     pwd_values, pwd_ids):
    if not auth.is_admin():
        return no_update, "Admin only.", ""

    triggered = ctx.triggered_id
    settings_msg = ""
    inv_msg = ""

    if triggered == "inv-submit" and inv_clicks:
        try:
            db.create_user(
                username=(inv_user or "").strip(),
                password=inv_pw or "",
                role=inv_role or "user",
                full_name=(inv_fullname or "").strip(),
                email=(inv_email or "").strip(),
                created_by=auth.current_user() or "system",
            )
            inv_msg = html.Span(f"✓ Created {(inv_user or '').strip()!r}",
                                  style={"color": "#15803d"})
        except ValueError as e:
            inv_msg = html.Span(f"✗ {e}", style={"color": "#b91c1c"})
    elif isinstance(triggered, dict):
        username = triggered.get("username")
        kind = triggered.get("type")
        if username and username == auth.current_user() and kind != "user-pwd-btn":
            settings_msg = "You can't modify your own role or delete yourself."
        elif kind == "user-pwd-btn":
            # Find the matching password input
            new_pw = ""
            for pid, val in zip(pwd_ids, pwd_values):
                if pid["username"] == username:
                    new_pw = val or ""
                    break
            try:
                db.update_password(username, new_pw)
                settings_msg = f"Password reset for {username!r}."
            except ValueError as e:
                settings_msg = str(e)
        elif kind == "user-role-btn":
            user = db.get_user(username)
            if user:
                new_role = "user" if user["role"] == "admin" else "admin"
                db.set_role(username, new_role)
                settings_msg = f"{username!r} is now {new_role!r}."
        elif kind == "user-del-btn":
            db.delete_user(username)
            settings_msg = f"Deleted {username!r}."

    return _users_table(auth.current_user() or ""), settings_msg, inv_msg
