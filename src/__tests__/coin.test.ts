import test from 'node:test';
import assert from 'node:assert/strict';

import { Coin } from '../utils/coin.js';

void test('Coin.toPretty formats amounts with zero decimals', () => {
  const coin = new Coin('whole', 'WHOLE', 0);

  assert.equal(coin.toPretty(123), '123');
});

void test('Coin.toPretty preserves six decimal places', () => {
  const coin = new Coin('micro', 'MICRO', 6);

  assert.equal(coin.toPretty(1234567), '1.234567');
  assert.equal(coin.toPretty(1000000), '1.000000');
});

void test('Coin.toRawAmount converts zero-decimal amounts', () => {
  const coin = new Coin('whole', 'WHOLE', 0);

  assert.equal(coin.toRawAmount(123), 123);
});

void test('Coin round-trips a six-decimal amount', () => {
  const coin = new Coin('micro', 'MICRO', 6);
  const rawAmount = 1234567;

  assert.equal(coin.toRawAmount(Number(coin.toPretty(rawAmount))), rawAmount);
});

void test('Coin.toRawAmount rounds to the nearest raw unit', () => {
  const coin = new Coin('micro', 'MICRO', 6);

  assert.equal(coin.toRawAmount(1.2345674), 1234567);
  assert.equal(coin.toRawAmount(1.2345676), 1234568);
});
