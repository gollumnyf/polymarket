import test from 'node:test';
import assert from 'node:assert/strict';
import { submitAction, latestSnapshot, startWithAmount } from '../src/api.mjs';

test('saving an amount reads committed config and derived stake without an SSE update', async () => {
  const requests = [];
  const committed = { time: 20, accounts: { paper: { config: { baseAmount: 25 }, losses: 2, nextAmount: 100 } } };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => url === '/api/state' ? committed : { ok: true } };
  };
  const state = await submitAction('paper/config', { baseAmount: 25 }, 'control-token', fetchImpl);
  assert.equal(requests[0].url, '/api/paper/config');
  assert.equal(JSON.parse(requests[0].options.body).baseAmount, 25);
  assert.equal(requests[1].url, '/api/state');
  assert.equal(requests[1].options.cache, 'no-store');
  const account = state.accounts.paper;
  assert.deepEqual([0, 1, 2, 3].map(step => account.config.baseAmount * 2 ** step), [25, 50, 100, 200]);
  assert.equal(account.nextAmount, 100);
});

test('an older stream or initial fetch cannot overwrite a newly saved configuration', () => {
  const saved = { time: 20, accounts: { paper: { config: { baseAmount: 25 } } } };
  const old = { time: 10, accounts: { paper: { config: { baseAmount: 10 } } } };
  assert.equal(latestSnapshot(saved, old), saved);
  assert.equal(latestSnapshot(old, saved), saved);
});

test('a rejected save reports the server error instead of pretending to update the sequence', async () => {
  let requests = 0;
  await assert.rejects(submitAction('paper/config', { baseAmount: 0 }, 'token', async () => {
    requests++;
    return { ok: false, json: async () => ({ error: '请先暂停策略' }) };
  }), /请先暂停策略/);
  assert.equal(requests, 1);
});

for (const [mode, amount] of [['paper', 2], ['live', 8]]) {
test(`${mode}: directly starting saves the typed ${amount} before starting instead of using the old 10`, async () => {
  let saved = 10, running = false;
  const posts = [];
  const fetchImpl = async (url, options) => {
    if (options?.method === 'POST') {
      posts.push(url);
      if (url === `/api/${mode}/config`) saved = JSON.parse(options.body).baseAmount;
      if (url === `/api/${mode}/start`) { assert.equal(saved, amount); running = true; }
    }
    return { ok: true, json: async () => url === '/api/state'
      ? { time: 20, accounts: { [mode]: { config: { baseAmount: saved }, nextAmount: saved, running } } }
      : { ok: true } };
  };
  const state = await startWithAmount(mode, amount, { baseAmount: 10 }, 'token', fetchImpl);
  assert.deepEqual(posts, [`/api/${mode}/config`, `/api/${mode}/start`]);
  assert.equal(state.accounts[mode].running, true);
  assert.equal(state.accounts[mode].nextAmount, amount);
  assert.deepEqual([0, 1, 2, 3].map(n => state.accounts[mode].config.baseAmount * 2 ** n), [amount, amount * 2, amount * 4, amount * 8]);
});
}

test('a failed auto-save cannot start trading with the previous stake', async () => {
  const requests = [];
  await assert.rejects(startWithAmount('paper', 2, { baseAmount: 10 }, 'token', async url => {
    requests.push(url);
    return { ok: false, json: async () => ({ error: '已有持仓尚未结算' }) };
  }), /已有持仓尚未结算/);
  assert.deepEqual(requests, ['/api/paper/config']);
});

test('invalid draft amounts cannot start the strategy', async () => {
  for (const value of [0, NaN, -2]) {
    await assert.rejects(startWithAmount('paper', value, { baseAmount: 10 }, 'token', () => {
      throw new Error('No request should be made');
    }), /有效首笔金额/);
  }
});
