/**
 * Pure rental underwriting math — no DOM, no globals.
 * Used by the app and by unit tests.
 */
import { DEF, MARKET_DEFAULTS, RATES, STATES } from './constants.js';

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Per-unit rent heuristic when comps are missing (matches legacy script.js). */
export function estimateUnitRent(price, unitIndex = 0) {
  return Math.max(600, Math.round(price ? price * 0.009 : 1000) - unitIndex * 50);
}

export function getPropTaxRate(state) {
  const st = state || '';
  return st === 'NJ' ? MARKET_DEFAULTS.NJ_PROP_TAX_RATE : MARKET_DEFAULTS.DEFAULT_PROP_TAX_RATE;
}

/** Monthly mortgage payment (30-yr fixed). */
export function calcMortgage(price, downPct, rate) {
  const loan = price * (1 - downPct / 100);
  const mr = rate / 100 / 12;
  const n = 360;
  if (mr === 0) return loan / n;
  return loan * (mr * Math.pow(1 + mr, n)) / (Math.pow(1 + mr, n) - 1);
}

export function calcOpEx(price, gross, snapshot, ov = {}) {
  const ptr = getPropTaxRate(snapshot.addr && snapshot.addr.state);
  return {
    tx:   ov.tx   ?? (snapshot.taxes       || Math.round(price * ptr / 12)),
    ins:  ov.ins  ?? (snapshot.insurance   || Math.round(price * RATES.INSURANCE / 12)),
    mnt:  ov.mnt  ?? (snapshot.maintenance || Math.round(price * RATES.MAINTENANCE / 12)),
    vac:  ov.vac  ?? (snapshot.vacancy     || Math.round(gross * RATES.VACANCY)),
    mgmt: ov.mgmt ?? (snapshot.management  || Math.round(gross * RATES.MANAGEMENT)),
    oth:  ov.oth  ?? (snapshot.otherExp    || 0),
  };
}

export function calcIRR(cashflows) {
  if (!cashflows || cashflows.length < 2) return 0;
  let r = 0.1;
  for (let i = 0; i < 200; i++) {
    let npv = 0, dnpv = 0;
    cashflows.forEach((cf, t) => {
      const d = Math.pow(1 + r, t);
      npv += cf / d;
      dnpv -= t * cf / (d * (1 + r));
    });
    if (Math.abs(dnpv) < 1e-10) break;
    const r1 = r - npv / dnpv;
    if (Math.abs(r1 - r) < 1e-8) { r = r1; break; }
    r = isFinite(r1) ? r1 : r * 0.9;
  }
  return isFinite(r) ? r * 100 : 0;
}

/**
 * @param {object} snapshot — full app state shape (same fields as DEF + rents, etc.)
 * @param {object} [ov] — overrides merged into the calc (same keys as legacy calcCore)
 */
export function calcCore(snapshot, ov = {}) {
  const price       = ov.price  ?? snapshot.price;
  const dp          = ov.dp     ?? snapshot.downPct;
  const rate        = ov.rate   ?? snapshot.rate;
  const appPct      = ov.appreciation ?? snapshot.appreciation ?? 3;
  const appM        = 1 + appPct / 100;
  const rents       = ov.rents  ?? snapshot.rents;
  const units       = snapshot.units || 1;
  const gross       = rents.reduce((a, b) => a + b, 0) || (estimateUnitRent(price, 0) * units);

  const mort        = calcMortgage(price, dp, rate);
  const { tx, ins, mnt, vac, mgmt, oth } = calcOpEx(price, gross, snapshot, ov);
  const opExp       = tx + ins + mnt + vac + mgmt + oth;
  const totalExp    = mort + opExp;

  const noi         = (gross - vac - mgmt - mnt - tx - ins - oth) * 12;
  const capRate     = price ? noi / price * 100 : 0;
  const down        = price * dp / 100;
  const annualCF    = (gross - totalExp) * 12;
  const coc         = down ? annualCF / down * 100 : 0;
  const loan        = price * (1 - dp / 100);
  const ltv         = price ? loan / price * 100 : 0;
  const grm         = gross * 12 > 0 ? price / (gross * 12) : 0;
  const dscr        = mort * 12 > 0 ? (gross - vac - mgmt) * 12 / (mort * 12) : 0;
  const ber         = gross > 0 ? totalExp / gross * 100 : 100;
  const oer         = gross > 0 ? opExp / gross * 100 : 0;

  const mr          = rate / 100 / 12;
  const mn360       = mr > 0 ? Math.pow(1 + mr, 360) : 1;
  const remLoan10   = mr > 0 ? loan * (mn360 - Math.pow(1 + mr, 120)) / (mn360 - 1) : Math.max(0, loan - loan / 360 * 120);
  const remLoan30   = mr > 0 ? loan * (mn360 - Math.pow(1 + mr, 360)) / (mn360 - 1) : 0;
  const fv10        = price * Math.pow(appM, 10) - remLoan10;
  const fv30        = price * Math.pow(appM, 30) - remLoan30;
  const irr10       = down > 0 ? calcIRR([-down, ...Array(9).fill(annualCF), annualCF + fv10]) : 0;
  const irr30       = down > 0 ? calcIRR([-down, ...Array(29).fill(annualCF), annualCF + fv30]) : 0;
  const eqMult      = down > 0 ? (annualCF * 10 + fv10) / down : 0;

  return {
    mort, gross, totalExp, opExp, noi, capRate, coc, annualCF,
    cf: gross - totalExp, down, price, dp, rate, ltv, grm, dscr,
    ber, oer, irr10, irr30, eqMult, tx, ins, mnt, vac, mgmt, oth,
    loan, appreciation: appPct,
  };
}

export function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const price = +raw.price;
  if (!price || price < 10000 || price > 1e8) return null;
  const units = clamp(+raw.units || 1, 1, 4);
  const downPct = clamp(+raw.downPct || 20, 3, 50);
  const rate = clamp(+raw.rate || MARKET_DEFAULTS.MORTGAGE_30Y_FRM, 2, 20);
  const rents = Array.isArray(raw.rents)
    ? raw.rents.slice(0, 4).map(r => clamp(+r || 0, 0, 50000))
    : [];
  const appreciation = clamp(raw.appreciation != null ? +raw.appreciation : 3, -5, 20);

  const addr = raw.addr && typeof raw.addr === 'object' ? {
    street:  String(raw.addr.street  || '').slice(0, 120),
    city:    String(raw.addr.city    || '').slice(0, 80),
    state:   STATES.includes(raw.addr.state) ? raw.addr.state : '',
    zip:     String(raw.addr.zip     || '').replace(/[^0-9]/g, '').slice(0, 5),
    country: String(raw.addr.country || 'United States').slice(0, 60),
  } : structuredClone(DEF.addr);

  return {
    price, units, downPct, rate, rents, appreciation, addr,
    taxes:       clamp(+raw.taxes       || 0, 0, 999999),
    insurance:   clamp(+raw.insurance   || 0, 0, 999999),
    maintenance: clamp(+raw.maintenance || 0, 0, 999999),
    vacancy:     clamp(+raw.vacancy     || 0, 0, 999999),
    management:  clamp(+raw.management  || 0, 0, 999999),
    otherExp:    clamp(+raw.otherExp    || 0, 0, 999999),
    period:      raw.period === 'yr' ? 'yr' : 'mo',
  };
}
