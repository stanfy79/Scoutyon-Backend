import assert from 'node:assert/strict';
import test from 'node:test';
import { assessVendorEvidence, normalizeVendorInput } from '../src/vendor.service.js';
import { computeBudgetState } from '../src/purchase.service.js';

test('vendor evidence assessment marks corroborated records as reliable but not verified', () => {
  const assessment = assessVendorEvidence([
    { source: 'website', collectedAt: new Date(), status: 'corroborated', summary: 'Company appears on official website and ships internationally.' },
    { source: 'directory', collectedAt: new Date(), status: 'corroborated', summary: 'Business directory lists a matching domain and contact details.' },
  ]);

  assert.equal(assessment.status, 'corroborated');
  assert.ok(assessment.reliabilityScore >= 30);
});

test('vendor normalization strips the www prefix from domains', () => {
  const normalized = normalizeVendorInput('Acme Tech', 'https://www.acmetech.example');
  assert.equal(normalized.name, 'Acme Tech');
  assert.equal(normalized.domain, 'acmetech.example');
});

test('budget calculations remain decimal-safe for remaining budget checks', () => {
  const state = computeBudgetState(1200, 450, 180);
  assert.equal(state.remaining, 570);
  assert.equal(state.utilization, 52.5);
});
