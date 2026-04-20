import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcMortgage,
  calcIRR,
  calcCore,
  sanitizeState,
  estimateUnitRent,
} from '../js/math.js';

describe('estimateUnitRent', () => {
  it('scales with price and unit index', () => {
    assert.ok(estimateUnitRent(500_000, 0) > 600);
    assert.equal(estimateUnitRent(500_000, 1), estimateUnitRent(500_000, 0) - 50);
  });
});

describe('calcMortgage', () => {
  it('returns positive monthly payment for typical inputs', () => {
    const m = calcMortgage(400_000, 20, 6.5);
    assert.ok(m > 1800 && m < 2600);
  });

  it('handles zero rate amortization', () => {
    const m = calcMortgage(300_000, 25, 0);
    assert.ok(Math.abs(m - (300_000 * 0.75) / 360) < 1e-6);
  });
});

describe('calcIRR', () => {
  it('finds ~10% IRR on simple two-period cashflow', () => {
    const irr = calcIRR([-1000, 1100]);
    assert.ok(irr > 9 && irr < 11);
  });
});

describe('sanitizeState', () => {
  it('rejects invalid prices', () => {
    assert.equal(sanitizeState({ price: 100 }), null);
    assert.equal(sanitizeState(null), null);
  });

  it('accepts a minimal valid payload', () => {
    const s = sanitizeState({
      price: 350000,
      units: 2,
      downPct: 25,
      rate: 7,
      rents: [2000, 1800],
      addr: { state: 'NJ', zip: '07030' },
    });
    assert.ok(s);
    assert.equal(s.price, 350000);
    assert.equal(s.units, 2);
    assert.equal(s.addr.state, 'NJ');
  });
});

describe('calcCore', () => {
  it('produces coherent headline metrics', () => {
    const snapshot = {
      price: 400000,
      units: 1,
      downPct: 20,
      rate: 6.5,
      rents: [2800],
      taxes: 400,
      insurance: 150,
      maintenance: 200,
      vacancy: 200,
      management: 200,
      otherExp: 0,
      appreciation: 3,
      addr: { state: 'TX' },
    };
    const R = calcCore(snapshot, {});
    assert.ok(R.mort > 0);
    assert.ok(R.capRate > 0);
    assert.ok(R.dscr > 0);
    assert.ok(typeof R.cf === 'number');
  });
});
