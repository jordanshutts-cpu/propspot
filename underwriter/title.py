"""
Preliminary Title Data — schema, defaults, computations.

Mirrors the V16.x spreadsheet's Dashboard 'FORECLOSURE / SUBTO DETAILS' box
(cells K36:P77).  All values feed off the property's intake form, which
the user fills in once at /property/<id>/intake.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any


# ---------------------------------------------------------------------------
# Default empty intake record
# ---------------------------------------------------------------------------
def empty_mortgage() -> dict:
    return {
        "company": "", "date": "", "initialAmount": 0, "rate": 0.0625,
        "assignmentServicer": "", "assignmentDate": "",
    }


def empty_payoff() -> dict:
    return {
        "statementDate": "",
        "currentPrincipal": 0,
        "cumulativeInterest": 0,
        "escrowsOwed": 0,
        "taxesOwed": 0,
        "insuranceOwed": 0,
        "lateFees": 0,
        "foreclosureCosts": 0,
        "attorneyFees": 0,
        "other": 0,
    }


def empty_seller_mortgage() -> dict:
    return {
        "principalPerMo": 0, "interestPerMo": 0,
        "taxesPerMo": 0, "insurancePerMo": 0,
        "solarPerMo": 0, "otherPerMo": 0,
    }


def empty_lien() -> dict:
    return {"dateFiled": "", "holder": "", "lienNumber": "",
            "bookPage": "", "principalAmount": 0, "interestRate": 0.0625}


def empty_judgment() -> dict:
    return {"judgmentDate": "", "plaintiff": "", "caseNumber": "",
            "principalAmount": 0, "interestRate": 0.08}


DEFAULT_PRELIM_TITLE = {
    # Section 1
    "parcelId": "",
    "owners": "",

    # Section 2
    "mortgage1": empty_mortgage(),
    "mortgage2": empty_mortgage(),
    "monthsDelinquent": 0,

    # Section 3
    "payoff1": empty_payoff(),
    "payoff2": empty_payoff(),

    # Section 4
    "sellerMortgage1": empty_seller_mortgage(),
    "sellerMortgage2": empty_seller_mortgage(),

    # Sections 5 + 6 (variable rows)
    "liens":     [empty_lien()     for _ in range(3)],
    "judgments": [empty_judgment() for _ in range(3)],
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _to_date(value) -> date | None:
    """Best-effort: parse 'YYYY-MM-DD', datetime objects, etc."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    s = str(value).strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _months_between(d1: date, d2: date) -> float:
    """Decimal months between d1 and d2 (positive if d2 > d1)."""
    return (d2 - d1).days / 30.4166


def _num(v, default=0.0) -> float:
    if v in (None, ""):
        return default
    try:    return float(v)
    except (TypeError, ValueError): return default


# ---------------------------------------------------------------------------
# Per-mortgage payoff total — sum of section 3 fields
# ---------------------------------------------------------------------------
def payoff_total(payoff: dict) -> float:
    if not payoff:
        return 0
    keys = ("currentPrincipal", "cumulativeInterest",
            "escrowsOwed", "taxesOwed", "insuranceOwed",
            "lateFees", "foreclosureCosts", "attorneyFees", "other")
    return sum(_num(payoff.get(k)) for k in keys)


def seller_mortgage_total(s: dict) -> float:
    if not s: return 0
    return sum(_num(s.get(k)) for k in
                ("principalPerMo", "interestPerMo",
                 "taxesPerMo", "insurancePerMo",
                 "solarPerMo", "otherPerMo"))


# ---------------------------------------------------------------------------
# Lien / judgment interest accruals (compounded monthly)
# ---------------------------------------------------------------------------
def lien_interest_to_date(lien: dict, today: date | None = None) -> float:
    today = today or date.today()
    d = _to_date(lien.get("dateFiled"))
    if not d:
        return 0
    months = _months_between(d, today)
    if months <= 0:
        return 0
    p = _num(lien.get("principalAmount"))
    r = _num(lien.get("interestRate"), 0)
    if p <= 0:
        return 0
    # Monthly compounding: P × ((1 + r/12)^N − 1)
    return p * ((1 + r / 12) ** months - 1)


def judgment_interest_to_date(j: dict, today: date | None = None) -> float:
    today = today or date.today()
    d = _to_date(j.get("judgmentDate"))
    if not d:
        return 0
    months = _months_between(d, today)
    if months <= 0:
        return 0
    p = _num(j.get("principalAmount"))
    r = _num(j.get("interestRate"), 0)
    if p <= 0:
        return 0
    return p * ((1 + r / 12) ** months - 1)


def judgment_expiration(j: dict) -> date | None:
    d = _to_date(j.get("judgmentDate"))
    if not d:
        return None
    try:
        return d.replace(year=d.year + 10)
    except ValueError:
        # Feb 29 etc. — bump to Feb 28
        return d.replace(month=2, day=28, year=d.year + 10)


# ---------------------------------------------------------------------------
# Foreclosure / Subto Details derived figures
# ---------------------------------------------------------------------------
def compute_title_summary(pt: dict, A: dict | None = None) -> dict:
    """Compute every value displayed in the dashboard's
    Foreclosure / Subto Details box from the intake record `pt`.

    `A` is the assumption dict (used for taxes/insurance fall-back).  May be
    None — we just fill in zero defaults.
    """
    if not pt:
        pt = {}
    A = A or {}

    m1 = pt.get("mortgage1") or {}
    p1 = pt.get("payoff1")   or {}
    p2 = pt.get("payoff2")   or {}
    s1 = pt.get("sellerMortgage1") or {}
    liens     = pt.get("liens") or []
    judgments = pt.get("judgments") or []

    today = date.today()

    # --- Last loan / modif row ----------------------------------------------
    last_loan_date_str = m1.get("date") or ""
    last_loan_amount = _num(m1.get("initialAmount"))
    last_loan_d = _to_date(last_loan_date_str)
    months_since_last_loan = (
        round(_months_between(last_loan_d, today), 0)
        if last_loan_d else 0
    )

    # --- 1A / 1B  Principal in Order/Stmt -----------------------------------
    p1_principal = _num(p1.get("currentPrincipal"))
    p1_interest  = _num(p1.get("cumulativeInterest"))
    p1_fc_costs  = (_num(p1.get("foreclosureCosts"))
                    + _num(p1.get("attorneyFees"))
                    + _num(p1.get("escrowsOwed"))
                    + _num(p1.get("taxesOwed"))
                    + _num(p1.get("insuranceOwed"))
                    + _num(p1.get("lateFees"))
                    + _num(p1.get("other")))
    p1_total_in_stmt = p1_principal + p1_interest + p1_fc_costs
    est_total_payoff = p1_total_in_stmt  # 1B is the same in V16.x absent extras

    # 'Interest for X mos.' — months between principal-date and today
    p1_stmt_d = _to_date(p1.get("statementDate"))
    interest_months = (
        _months_between(p1_stmt_d, today) if p1_stmt_d else 0
    )

    # --- 2) 2nd Mortgage ----------------------------------------------------
    p2_principal = _num(p2.get("currentPrincipal"))
    p2_interest  = _num(p2.get("cumulativeInterest"))
    second_total = p2_principal + p2_interest

    # --- 3A liens / 3B judgments -------------------------------------------
    lien_totals  = [(_num(l.get("principalAmount"))
                     + lien_interest_to_date(l, today))
                    for l in liens]
    judg_totals  = [(_num(j.get("principalAmount"))
                     + judgment_interest_to_date(j, today))
                    for j in judgments]
    liens_judgments_total = sum(lien_totals) + sum(judg_totals)

    # --- ACTUAL PAYOFF (Mtg + Liens + Judgments) ----------------------------
    actual_payoff = est_total_payoff + second_total + liens_judgments_total

    # --- Seller assumed amounts --------------------------------------------
    seller_1st_assumed = p1_principal
    seller_2nd_assumed = second_total  # if not paid at acq
    seller_liens_assumed = liens_judgments_total
    assumed_total = seller_1st_assumed + seller_2nd_assumed + seller_liens_assumed

    # --- SUBTO SELLER'S MORTGAGE -------------------------------------------
    sm_principal = _num(s1.get("principalPerMo"))
    sm_interest  = _num(s1.get("interestPerMo"))
    sm_taxes     = _num(s1.get("taxesPerMo"))
    sm_insurance = _num(s1.get("insurancePerMo"))
    sm_solar     = _num(s1.get("solarPerMo"))
    sm_other     = _num(s1.get("otherPerMo"))
    sm_total = sm_principal + sm_interest + sm_taxes + sm_insurance + sm_solar + sm_other

    # --- ESTIMATED REINSTATEMENT -------------------------------------------
    # Past Due Pmts = monthly mtg payment × months since order date
    past_due_pmts = sm_total * interest_months
    costs_and_fees = (_num(p1.get("foreclosureCosts"))
                       + _num(p1.get("attorneyFees")))
    est_reinstatement = past_due_pmts + costs_and_fees - past_due_pmts * 0  # = past_due + costs
    # Approximate: in the spreadsheet, est_reinstatement = past_due + costs - taxes_ins_offset
    # We use the simpler approximation: past_due + fc_costs.
    est_reinstatement = past_due_pmts + costs_and_fees
    est_principal_reduction = sm_principal * interest_months

    return {
        # Last-loan row
        "last_loan_date":      last_loan_date_str,
        "last_loan_amount":    last_loan_amount,
        "months_since_last_loan": months_since_last_loan,

        # 1A / 1B
        "p1_principal_date":   p1.get("statementDate", ""),
        "p1_principal":        p1_principal,
        "p1_interest_months":  interest_months,
        "p1_interest":         p1_interest,
        "p1_fc_costs":         p1_fc_costs,
        "p1_total_in_stmt":    p1_total_in_stmt,
        "est_total_payoff":    est_total_payoff,

        # 2nd mortgage
        "p2_principal":        p2_principal,
        "p2_interest":         p2_interest,
        "second_total":        second_total,

        # 3A/B
        "lien_totals":          lien_totals,
        "judgment_totals":      judg_totals,
        "liens_judgments_total":liens_judgments_total,

        # Totals
        "actual_payoff":           actual_payoff,
        "seller_1st_assumed":      seller_1st_assumed,
        "seller_2nd_assumed":      seller_2nd_assumed,
        "seller_liens_assumed":    seller_liens_assumed,
        "assumed_total":           assumed_total,

        # Subto
        "sm_principal": sm_principal,
        "sm_interest":  sm_interest,
        "sm_taxes":     sm_taxes,
        "sm_insurance": sm_insurance,
        "sm_solar":     sm_solar,
        "sm_other":     sm_other,
        "sm_total":     sm_total,

        # Reinstatement
        "past_due_pmts":           past_due_pmts,
        "fc_costs_and_fees":       costs_and_fees,
        "est_reinstatement":       est_reinstatement,
        "est_principal_reduction": est_principal_reduction,
    }
