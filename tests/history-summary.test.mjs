import test from 'node:test';
import assert from 'node:assert/strict';
import {previousRoundPreview,summarizeHistory} from '../src/history-summary.mjs';

test('only the last ended round displays a provisional result, with official results taking precedence',()=>{
  const current=1800000000, round=current-300;
  const pending={round,status:'pending'}, estimate={round,outcome:'UP'};
  assert.equal(previousRoundPreview(pending,current,estimate),'UP');
  assert.equal(previousRoundPreview(pending,current+300,estimate),null);
  assert.equal(previousRoundPreview({...pending,status:'void'},current,estimate),null);
  assert.equal(previousRoundPreview({...pending,result:'DOWN',status:'resolved'},current,estimate),null);
  assert.equal(previousRoundPreview({...pending,open:100,close:99,closeSource:'polymarket_event_metadata'},current,estimate),'DOWN');
  assert.equal(previousRoundPreview({...pending,forecast:estimate},current),'UP');
  assert.equal(previousRoundPreview(pending,current,{...estimate,round:round-300}),null);
  assert.deepEqual(summarizeHistory([{...pending,provisional:'UP'}]),{up:0,down:0,pending:1,void:0});
});
