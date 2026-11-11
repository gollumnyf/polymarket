import { Polymarket, safeError } from '../server/polymarket.mjs';
import { roundStart } from '../server/strategy.mjs';
const venue = new Polymarket();
const results = await Promise.allSettled([
  venue.spot().then(s => ({ source: s.source, price: s.price, reference: s.previousOpen, direction: s.direction })),
  venue.market(roundStart()).then(async m => {
    const books = await venue.books(m);
    return { slug: m.slug, version: m.version, active: m.active, feeSchedule: m.feeSchedule,
      upAsk: books.UP.asks[0]?.price, downAsk: books.DOWN.asks[0]?.price };
  }),
]);
for (let i = 0; i < results.length; i++) {
  const r = results[i]; console.log(JSON.stringify({ source: ['BTC', 'Polymarket'][i],
    ok: r.status === 'fulfilled', ...(r.status === 'fulfilled' ? { data: r.value } : { error: safeError(r.reason) }) }));
}
venue.close();
if (results.some(r => r.status === 'rejected')) process.exitCode = 1;
