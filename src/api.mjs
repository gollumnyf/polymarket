// Read the committed state before reporting success. A settings save must update
// every derived amount even when the SSE message arrives late or is disconnected.
export function apiPath(path,pathname=globalThis.location?.pathname||'/paper'){
  const routes=['loss-follow-live','loss-follow','previous-live','previous','range','momentum'];
  const page=pathname.split('/')[1];
  const prefix=routes.includes(page)?'/'+page:'';
  return `${prefix}/api/${path}`;
}

export async function submitAction(path, body, token, fetchImpl = fetch) {
  const response = await fetchImpl(apiPath(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Control-Token': token },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');

  const stateResponse = await fetchImpl(apiPath('state'), { cache: 'no-store' });
  if (!stateResponse.ok) throw new Error('操作已保存，但读取最新状态失败，请刷新页面');
  return stateResponse.json();
}

export function latestSnapshot(current, incoming) {
  return !current || incoming.time >= current.time ? incoming : current;
}

export async function startWithAmount(mode, amount, config, token, fetchImpl = fetch) {
  // A typed draft must never silently start the strategy with the old saved stake.
  if (!Number.isFinite(amount) || amount < 1) throw new Error('请输入至少 1 pUSD 的有效首笔金额');
  if (amount !== config.baseAmount) {
    await submitAction(`${mode}/config`, { ...config, baseAmount: amount }, token, fetchImpl);
  }
  return submitAction(`${mode}/start`, {}, token, fetchImpl);
}
