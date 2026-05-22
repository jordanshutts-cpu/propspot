"""
Session-based authentication for the underwriter dashboard.

`current_user()` returns the username from the Flask session, or None.
`current_role()` returns 'admin' / 'user' / None.

The Flask app's `before_request` handler in `app.py` redirects unauthenticated
visitors to /login.  Pages can additionally call `require_user()` at the
top of their layout function for a defence-in-depth check.
"""
from __future__ import annotations

from typing import Optional

from flask import session

import db


def current_user() -> Optional[str]:
    """Username of the logged-in user, or None."""
    return session.get("user")


def current_role() -> Optional[str]:
    """Role of the logged-in user — 'admin', 'user', or None."""
    return session.get("role")


def is_admin() -> bool:
    return current_role() == "admin"


def login(username: str, password: str) -> Optional[dict]:
    """Try to log a user in.  Returns the user record on success, else None."""
    user = db.authenticate(username, password)
    if not user:
        return None
    session["user"] = user["username"]
    session["role"] = user["role"]
    session.permanent = True
    return user


def logout() -> None:
    session.pop("user", None)
    session.pop("role", None)


def acting_user() -> str:
    """The string used in apply_edits() / audit-log writes for the current
    request.  Falls back to 'anonymous' if nobody's logged in (shouldn't
    happen in normal flow because of the route guard, but stay safe)."""
    return current_user() or "anonymous"
