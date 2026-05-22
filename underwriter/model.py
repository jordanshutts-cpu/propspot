"""
Flip-vs-DSCR underwriter model.

Direct port of the V16.x Dashboard tab.  Validated against the V16.2 379
Curtis Dr workbook to 30/30 cells matching the spreadsheet's cached values
(see legacy/validate.py for the test).

Public API:
    DEFAULTS              base assumption values for new properties
    RENTAL_OPEX_LINES     ordered list of (id, label, default_freq, auto_from)
    SECTION_FIELDS        dict mapping UI section -> field ids
    compute(A)            -> dict of computed cells
"""
from __future__ import annotations

import math
from datetime import date, timedelta


# ---------------------------------------------------------------------------
# Rental operating-expense schema (mirrors the V16.x op-ex table)
# ---------------------------------------------------------------------------
# (id, label, default_frequency, auto_from)
#   auto_from: "annualPropertyTax" / "insuranceAnnual" / None — when set, this
#   line's amount is read-only and follows the corresponding valuation field.
RENTAL_OPEX_LINES = [
    ("HOA",          "HOA",                   "Annual",  None),
    ("solar1",       "Solar Panel Pmts",      "Monthly", None),
    ("insurance",    "Insurance",             "Annual",  "insuranceAnnual"),
    ("landscaping",  "Landscaping",           "Annual",  None),
    ("solar2",       "Solar Panel Pmts (2)",  "Monthly", None),
    ("propMgmt",     "Property Management",   "Monthly", None),
    ("repairs",      "Repairs & Maintenance", "Monthly", None),
    ("supplies",     "Supplies",              "Annual",  None),
    ("propertyTax",  "Property Tax",          "Annual",  "annualPropertyTax"),
    ("trash",        "Trash Removal",         "Annual",  None),
    ("utilities",    "Utilities",             "Monthly", None),
    ("waterSewer",   "Water and Sewer",       "Annual",  None),
    ("other",        "Other Expenses",        "Annual",  None),
]


# ---------------------------------------------------------------------------
# UI section definitions — drives the property-page color-coded groups
# ---------------------------------------------------------------------------
# Each entry: (field_id, label, kind)
#   kind ∈ {'num$', 'num%', 'num', 'bool', 'text'}
SECTION_FIELDS = {
    # Two explicit columns (rendered side-by-side, NOT a wrapping grid):
    "valuation_col1": [
        ("bridgeARV",         "Bridge ARV",                "num$"),
        ("dscrARV",           "DSCR ARV",                  "num$"),
        ("purchasePrice",     "Purchase Price",            "num$"),
        ("renoBudget",        "Reno Budget",               "num$"),
    ],
    "valuation_col2": [
        ("rentOverride",      "Rent (per month)",          "num$"),
        ("rentEscalation",    "Annual Rent Increase Rate", "num%"),
        ("annualPropertyTax", "Annual Property Tax",       "num$"),
        ("insuranceAnnual",   "Insurance (per year)",      "num$"),
    ],
    "pml": [
        ("usePML",     "Use PML?",          "bool"),
        ("pmlAmount",  "PML Amount",        "num$"),
        ("pmlRate",    "PML Rate",          "num%"),
        ("pmlFees",    "PML Fees",          "num$"),
    ],
    "flip": [  # Acquisition & Flip
        ("dscrCostsBypass", "(this section is intentionally empty — see Base Assumptions)", "text"),
    ],
    "dscr": [  # Long-term Rental specific
        ("appreciationRate",    "Appreciation Rate (annual)",    "num%"),
        ("includeAppreciation", "Include appreciation",          "bool"),
        ("sellAfterYears",      "Sell After (years)",            "num"),
        ("vacancyRate",         "Vacancy Rate",                  "num%"),
        ("monthlyRepairs",      "Monthly Repairs",               "num$"),
        ("prepaidInterestDays", "Prepaid Interest Days",         "num"),
        ("hoaMonths",           "HOA Prepaid (months)",          "num"),
        ("insuranceMonths",     "Insurance Prepaid (months)",    "num"),
        ("propTaxMonths",       "Property Tax Prepaid (months)", "num"),
        ("useDwellaPM",         "Use Dwella PM (10% of rent)",   "bool"),
        ("borrowMaxDSCR",       "Borrow max DSCR",               "bool"),
        ("riverstoneRate",      "Riverstone (cash-shortage) rate","num%"),
    ],
    "base_flip": [
        ("bridgeRate",                "Bridge Rate (annual)",         "num%"),
        ("maxLTV",                    "Max LTV (Bridge)",             "num%"),
        ("maxLTC",                    "Max LTC (Bridge)",             "num%"),
        ("bridgeOrigPct",             "Loan Origination",             "num%"),
        ("bridgeOrigMin",             "Loan Origination Minimum",     "num$"),
        ("bridgeUWFee",               "Bridge UW Fee",                "num$"),
        ("bridgeClosingCosts",        "Bridge Closing Costs",         "num$"),
        ("bridgePreClosingExpenses",  "Pre-closing Expenses",         "num$"),
        ("bridgePostClosingExpenses", "Post-closing Expenses",        "num$"),
        ("vacateDays",                "Vacate Days",                  "num"),
        ("listingRefiDays",           "Listing/Refi Days",            "num"),
        ("closingDays",               "Closing Days",                 "num"),
        ("utilityCostsMonthly",       "Bridge Utility (per month)",   "num$"),
        ("bridgeInsuranceOverride",   "Bridge Insurance (per year, 0=auto)", "num$"),
        ("dispoCommissionPct",        "Dispo Commission",             "num%"),
        ("dispoTransferTaxPct",       "Dispo Transfer Tax",           "num%"),
        ("dispoClosingCosts",         "Dispo Closing Costs",          "num$"),
    ],
    "base_rental": [
        ("dscrRate",            "DSCR Rate (annual)",       "num%"),
        ("dscrMaxLTV",          "DSCR Max LTV",             "num%"),
        ("dscrOriginationPct",  "DSCR Origination",         "num%"),
        ("dscrOrigMin",         "DSCR Origination Min",     "num$"),
        ("dscrUWFee",           "DSCR UW Fee",              "num$"),
        ("dscrClosingCosts",    "DSCR Closing Costs",       "num$"),
        ("amortYears",          "Amortization (years)",     "num"),
    ],
}


# ---------------------------------------------------------------------------
# Reference defaults (mirror the V16.2 379-Curtis-Dr workbook)
# ---------------------------------------------------------------------------
def _default_rental_opex(insurance_annual=0, annual_prop_tax=0, rent_mo=0):
    """Build the default per-line rental op-ex dict, with auto-from fields filled in."""
    out = {}
    for fid, _label, freq, auto in RENTAL_OPEX_LINES:
        amount = 0
        if auto == "insuranceAnnual":
            amount = insurance_annual
        elif auto == "annualPropertyTax":
            amount = annual_prop_tax
        elif fid == "propMgmt":
            amount = rent_mo * 0.10  # 10% of rent
        elif fid == "repairs":
            amount = 100  # $100/mo default
        out[fid] = {
            "amount": amount,
            "frequency": freq,
            "escalation": 0.03 if fid in ("insurance", "propMgmt", "propertyTax") else 0.0,
        }
    return out


DEFAULTS: dict = {
    # ---- Valuation Assumptions (per-deal) ----
    "bridgeARV": 0,
    "dscrARV": 0,
    "purchasePrice": 0,
    "renoBudget": 0,
    "rentOverride": 0,
    "uwRent": 0,                  # legacy, kept for back-compat with extractor
    "annualPropertyTax": 0,
    "insuranceAnnual": 0,

    # ---- PML Assumptions ----
    "usePML": True,
    "pmlAmount": 0,
    "pmlRate": 0.10,
    "pmlFees": 0,

    # ---- DSCR / Long-term Rental ----
    "appreciationRate": 0.03,
    "includeAppreciation": True,
    "sellAfterYears": 5,
    "vacancyRate": 0.05,
    "rentEscalation": 0.03,        # annual rent increase rate
    "monthlyRepairs": 100,
    "prepaidInterestDays": 15,
    "hoaMonths": 12,
    "insuranceMonths": 8,
    "propTaxMonths": 11,
    "useDwellaPM": True,
    "borrowMaxDSCR": True,
    "riverstoneRate": 0.10,
    "applyEscalations": False,

    # ---- Base Flip Assumptions ----
    "bridgeRate": 0.1099,
    "maxLTV": 0.75,
    "maxLTC": 1.00,
    "bridgeOrigPct": 0.015,
    "bridgeOrigMin": 2250,
    "bridgeUWFee": 999,
    "bridgeClosingCosts": 2300,
    "bridgePreClosingExpenses": 800,
    "bridgePostClosingExpenses": 0,
    "vacateDays": 0,
    "listingRefiDays": 30,
    "closingDays": 45,
    "utilityCostsMonthly": 150,
    "bridgeInsuranceOverride": 0,
    "dispoCommissionPct": 0.03,
    "dispoTransferTaxPct": 0.0081,
    "dispoClosingCosts": 1500,

    # ---- Base Rental Assumptions ----
    "dscrRate": 0.068,
    "dscrMaxLTV": 0.75,
    "dscrOriginationPct": 0.015,
    "dscrOrigMin": 2000,
    "dscrUWFee": 750,
    "dscrClosingCosts": 2200,
    "amortYears": 30,

    # ---- Rental operating expense table ----
    "rentalOpEx": _default_rental_opex(),
}


# ---------------------------------------------------------------------------
# Excel-equivalent financial primitives
# ---------------------------------------------------------------------------
def rd2(x: float) -> float:
    """Excel ROUNDDOWN(x, 2)."""
    return (math.floor(x * 100) if x >= 0 else math.ceil(x * 100)) / 100


def pmt(r: float, n: int, pv: float) -> float:
    if r == 0:
        return -pv / n
    return pv * r / (1 - (1 + r) ** (-n))


def excel_rate(nper: int, pmt_amt: float, pv: float, fv: float) -> float:
    """Excel RATE() — Newton's method with bisection fallback."""
    r = 0.10
    for _ in range(200):
        try:
            f  = pv * (1 + r) ** nper + pmt_amt * ((1 + r) ** nper - 1) / r + fv
            df = (pv * nper * (1 + r) ** (nper - 1)
                  + pmt_amt * (nper * (1 + r) ** (nper - 1) / r
                               - ((1 + r) ** nper - 1) / (r * r)))
        except (OverflowError, ZeroDivisionError):
            break
        if df == 0 or not math.isfinite(df):
            break
        dr = f / df
        r -= dr
        if abs(dr) < 1e-12:
            return r
        r = max(-0.999, min(100.0, r))
    lo, hi = -0.999, 50.0
    def npv(rr):
        return pv * (1 + rr) ** nper + pmt_amt * ((1 + rr) ** nper - 1) / rr + fv
    for _ in range(120):
        mid = (lo + hi) / 2
        if npv(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def days_remaining_in_closing_month() -> int:
    """V17 partial-month prepaid interest: F4 = TODAY()+10, EOMONTH(F4,0)-F4."""
    close = date.today() + timedelta(days=10)
    if close.month == 12:
        eom = date(close.year + 1, 1, 1) - timedelta(days=1)
    else:
        eom = date(close.year, close.month + 1, 1) - timedelta(days=1)
    return (eom - close).days


# ---------------------------------------------------------------------------
# Rental op-ex aggregation
# ---------------------------------------------------------------------------
def _opex_year_totals(rental_opex: dict, n_years: int, apply_escalations: bool,
                      sync_insurance=None, sync_proptax=None) -> list[float]:
    """For each year 1..n_years, return total annual op-ex (escalated if requested)."""
    totals = [0.0] * n_years
    for fid, _label, _freq, auto in RENTAL_OPEX_LINES:
        line = rental_opex.get(fid, {"amount": 0, "frequency": "Annual", "escalation": 0.0})
        amount = line.get("amount", 0)
        # Apply auto-from values (they should already be synced but be defensive)
        if auto == "insuranceAnnual" and sync_insurance is not None:
            amount = sync_insurance
        elif auto == "annualPropertyTax" and sync_proptax is not None:
            amount = sync_proptax
        if line.get("frequency", "Annual") == "Monthly":
            year_1_annual = amount * 12
        else:
            year_1_annual = amount
        esc = line.get("escalation", 0.0) if apply_escalations else 0.0
        for i in range(n_years):
            totals[i] += year_1_annual * (1 + esc) ** i
    return totals


def opex_monthly_year1(rental_opex: dict,
                        sync_insurance=None, sync_proptax=None) -> float:
    """Convenience: total monthly op-ex in year 1."""
    annual = _opex_year_totals(rental_opex, 1, False,
                                sync_insurance, sync_proptax)[0]
    return annual / 12


# ---------------------------------------------------------------------------
# Model — direct port of Dashboard cells V… and Z… plus rental op-ex
# ---------------------------------------------------------------------------
def compute(A: dict) -> dict:
    A = {**DEFAULTS, **A}  # ensure every field has a value
    list_price = A.get("listPrice", 0) or 0
    rental_opex = A.get("rentalOpEx") or _default_rental_opex(
        A.get("insuranceAnnual", 0), A.get("annualPropertyTax", 0),
        A.get("rentOverride", 0))

    # ---------- Bridge basis & loan ----------
    G27 = A["purchasePrice"]
    G29 = A["renoBudget"]
    G30 = G27 + G29
    C42 = G30 * A["maxLTC"]
    C43 = A["bridgeARV"] * A["maxLTV"]
    V9  = min(C42, C43)

    reno_days  = G29 / 1000
    total_days = math.floor((A["vacateDays"] + reno_days
                             + A["listingRefiDays"] + A["closingDays"]) * 100) / 100

    bot_insurance = (A["bridgeInsuranceOverride"]
                     if A["bridgeInsuranceOverride"] > 0
                     else list_price * 0.005)
    O14 = rd2(((A["utilityCostsMonthly"] * 12) + 0  # HOA in op14 = 0 unless mapped
               + bot_insurance + A["annualPropertyTax"]) / 365)
    L21 = rd2(V9 * A["bridgeRate"] / 365)

    V13 = A["bridgeClosingCosts"]
    V14 = A["bridgePreClosingExpenses"] + A["bridgePostClosingExpenses"]
    C46 = max(V9 * A["bridgeOrigPct"], A["bridgeOrigMin"])
    V15 = C46
    V16 = A["bridgeUWFee"]
    V17 = (days_remaining_in_closing_month() / 30.44) * L21
    V18 = 0
    V19 = V13 + V14 + V15 + V16 + V17 + V18

    V20 = total_days * O14
    V21 = (V9 * A["bridgeRate"] * total_days / 365) - V17
    V22 = A["pmlFees"] if A["usePML"] else 0
    V23 = ((A["pmlAmount"] + V19 + V20 + V21) * A["pmlRate"] * total_days / 365
           if A["usePML"] else 0)
    V24 = V19 + V20 + V21 + V22 + V23

    V10 = A["pmlAmount"] if A["usePML"] else 0
    V11 = G30 - V9 - V10
    V26 = V11 + V24

    V33 = V26 * A["riverstoneRate"] / 12

    V37 = A["bridgeARV"]
    V40 = -(V33 * total_days / 30.44)
    V41 = -(V37 * A["dispoCommissionPct"])
    V42 = -(V37 * A["dispoTransferTaxPct"]) - A["dispoClosingCosts"]
    V46 = V37 + (-V9) + (-V10) + V40 + V41 + V42

    flip_profit = V46 - V26
    flip_irr = (math.pow(V46 / V26, 365 / total_days) - 1
                if total_days > 0 and V26 > 0 and V46 > 0 else float("nan"))

    # ---------- DSCR refi ----------
    Z9  = A["dscrARV"] * A["dscrMaxLTV"] if A["borrowMaxDSCR"] else 0
    Z11 = Z9 - V9 - V10

    Z13 = A["dscrClosingCosts"]
    C80 = max(Z9 * A["dscrOriginationPct"], A["dscrOrigMin"])
    Z15 = C80
    Z16 = A["dscrUWFee"]
    O21 = rd2(Z9 * A["dscrRate"] / 365)
    G76 = A["prepaidInterestDays"] * O21
    G77 = (rental_opex.get("HOA", {}).get("amount", 0)
           if rental_opex.get("HOA", {}).get("frequency") == "Monthly"
           else rental_opex.get("HOA", {}).get("amount", 0) / 12) * A["hoaMonths"]
    G78 = (A["insuranceAnnual"] / 12) * A["insuranceMonths"]
    G79 = (A["annualPropertyTax"] / 12) * A["propTaxMonths"]
    G81 = G76 + G77 + G78 + G79
    Z17 = G81
    Z20 = Z13 + 0 + Z15 + Z16 + Z17 + 0 + 0
    Z22 = Z20 - Z11
    Z26 = V26 + Z22

    appr = A["appreciationRate"] if A["includeAppreciation"] else 0
    n_years = int(A["sellAfterYears"])
    Z37 = A["dscrARV"] * (1 + appr) ** n_years
    Z41 = -(Z37 * A["dispoCommissionPct"])
    Z42 = -(Z37 * A["dispoTransferTaxPct"]) - A["dispoClosingCosts"]
    Z43 = G81

    monthly_rate = A["dscrRate"] / 12
    monthly_pi = pmt(monthly_rate, int(A["amortYears"]) * 12, Z9)
    bal = Z9
    principal_sum = 0.0
    for _ in range(13):
        interest_pmt = bal * monthly_rate
        principal_pmt = monthly_pi - interest_pmt
        principal_sum += principal_pmt
        bal -= principal_pmt
    avg_monthly_principal = principal_sum / 13
    Z44 = avg_monthly_principal * 12 * n_years
    Z46 = Z37 + (-Z9) + Z41 + Z42 + Z43 + Z44

    # ---------- Year-1 rental cashflow ----------
    rent_mo = A["rentOverride"] if A["rentOverride"] > 0 else A.get("uwRent", 0)
    Z55 = rent_mo
    Z56 = -rent_mo * A["vacancyRate"]
    Z57 = -monthly_pi
    # Total monthly op-ex from the rental table (use Valuation values for the
    # auto-from lines, regardless of what's stored in rentalOpEx)
    opex_yr1_annual = _opex_year_totals(
        rental_opex, 1, False,
        sync_insurance=A["insuranceAnnual"],
        sync_proptax=A["annualPropertyTax"],
    )[0]
    Z_opex_mo = opex_yr1_annual / 12
    Z62 = Z55 + Z56 + Z57 - Z_opex_mo

    Z33 = Z26 * A["riverstoneRate"] / 12
    Z63 = -Z33
    Z64 = Z62 + Z63

    # ---------- Total cashflow over hold (with optional escalations) ----------
    # ---------- Total cashflow over hold (always escalated) -----------------
    # Each rental op-ex line escalates at its own annual rate; rent escalates
    # at A['rentEscalation'].  P+I is fixed.  If you want flat cashflow set
    # the escalation rate(s) to 0%.
    opex_year_totals = _opex_year_totals(
        rental_opex, n_years, True,
        sync_insurance=A["insuranceAnnual"],
        sync_proptax=A["annualPropertyTax"],
    )
    cashflow_total = 0.0
    rent_escalation = A.get("rentEscalation", 0.0)
    for i in range(n_years):
        year_rent_mo  = rent_mo * (1 + rent_escalation) ** i
        year_pi_mo    = monthly_pi
        year_vac_mo   = -year_rent_mo * A["vacancyRate"]
        year_opex_mo  = opex_year_totals[i] / 12
        year_cash_mo  = year_rent_mo + year_vac_mo - year_pi_mo - year_opex_mo + Z63
        cashflow_total += year_cash_mo * 12
    Z48 = cashflow_total

    dscr_profit = Z46 - Z26 + Z48

    if Z26 < 0:
        dscr_irr = 100.0
    elif Z26 == 0:
        dscr_irr = float("nan")
    else:
        dscr_irr = excel_rate(n_years, Z48 / n_years, -Z26, Z46)

    return dict(
        # Bridge / Flip
        G27=G27, G29=G29, G30=G30, V9=V9, total_days=total_days,
        reno_days=reno_days, O14=O14, L21=L21,
        V13=V13, V14=V14, V15=V15, V16=V16, V17=V17, V19=V19,
        V20=V20, V21=V21, V22=V22, V23=V23, V24=V24,
        V11=V11, V26=V26, V37=V37, V40=V40, V41=V41, V42=V42, V46=V46,
        flip_profit=flip_profit, flip_irr=flip_irr,
        # DSCR
        Z9=Z9, Z11=Z11, Z13=Z13, Z15=Z15, Z16=Z16, Z17=Z17, Z20=Z20,
        Z22=Z22, Z26=Z26, Z37=Z37, Z41=Z41, Z42=Z42, Z43=Z43, Z44=Z44, Z46=Z46,
        monthly_pi=monthly_pi,
        Z55=Z55, Z56=Z56, Z57=Z57, Z62=Z62, Z63=Z63, Z64=Z64, Z48=Z48,
        opex_mo=Z_opex_mo,
        dscr_profit=dscr_profit, dscr_irr=dscr_irr,
    )


def nav_if_sold_today(A: dict, r: dict) -> float:
    """Net asset value if the property were sold *today* (post-DSCR-refi, no
    appreciation), after paying off the DSCR loan and all selling costs.

        NAV = DSCR ARV
            - DSCR loan payoff
            - dispo commission       (= DSCR ARV × commission %)
            - dispo closing+transfer (= DSCR ARV × transfer % + dispo close $)
            - prepayment penalty     (= DSCR loan × 5 %)
            + recovery of prepaids/escrows

    Mirrors Dashboard Y76:Z83 'NAV / PROFIT IF SOLD AFTER DSCR' but uses
    today's DSCR ARV instead of the appreciated future value.
    """
    dscr_arv = A.get("dscrARV", 0) or 0
    dscr_loan = r["Z9"]
    dispo_comm           = dscr_arv * A.get("dispoCommissionPct", 0)
    dispo_close_transfer = (dscr_arv * A.get("dispoTransferTaxPct", 0)
                             + A.get("dispoClosingCosts", 0))
    prepay_penalty       = dscr_loan * 0.05
    recovery_prepaids    = r["Z17"]
    return (dscr_arv - dscr_loan
            - dispo_comm - dispo_close_transfer
            - prepay_penalty + recovery_prepaids)


def yr1_dscr_pnl(A: dict, r: dict) -> float:
    """Total profit if you bought, ran the bridge, refinanced into DSCR, then
    sold ONE YEAR LATER at today's DSCR ARV (no appreciation).

        Yr 1 P&L = DSCR ARV
                 - dispo expenses (no loan amts: commission + closing + transfer + Riverstone)
                 - acq expenses (bridge total costs + DSCR closing)
                 - prepayment penalty
                 - purchase price
                 - reno

    Mirrors Dashboard Y85:Z91 'Yr 1 DSCR P&L'.
    """
    dscr_arv = A.get("dscrARV", 0) or 0
    purchase = A.get("purchasePrice", 0) or 0
    reno     = A.get("renoBudget", 0) or 0
    dscr_loan = r["Z9"]

    dispo_comm           = dscr_arv * A.get("dispoCommissionPct", 0)
    dispo_close_transfer = (dscr_arv * A.get("dispoTransferTaxPct", 0)
                             + A.get("dispoClosingCosts", 0))
    riverstone           = -r["V40"]   # V40 is negative; selling cost is positive
    dispo_expenses       = dispo_comm + dispo_close_transfer + riverstone

    acq_expenses    = r["V24"] + r["Z20"]
    prepay_penalty  = dscr_loan * 0.05

    return (dscr_arv
            - dispo_expenses
            - acq_expenses
            - prepay_penalty
            - purchase - reno)


def best_strategy(r: dict) -> str:
    """Mirrors Dashboard F17/G17 pick logic."""
    if r["dscr_irr"] > 0.25:
        return "DSCR"
    if r["flip_irr"] > 10:
        return "Flip"
    return "None"


# ---------------------------------------------------------------------------
# Helpers for callers building snapshots
# ---------------------------------------------------------------------------
def sync_op_ex(assumptions: dict) -> dict:
    """Force the auto-from rental op-ex lines to follow Valuation values."""
    A = dict(assumptions)
    rop = dict(A.get("rentalOpEx") or _default_rental_opex(
        A.get("insuranceAnnual", 0), A.get("annualPropertyTax", 0),
        A.get("rentOverride", 0)))
    for fid, _label, _freq, auto in RENTAL_OPEX_LINES:
        if auto in ("insuranceAnnual", "annualPropertyTax"):
            line = dict(rop.get(fid) or {})
            line["amount"] = A.get(auto, 0)
            line.setdefault("frequency", "Annual")
            line.setdefault("escalation", 0.03 if fid in ("insurance","propertyTax") else 0.0)
            rop[fid] = line
    A["rentalOpEx"] = rop
    return A
