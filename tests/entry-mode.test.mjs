import test from 'node:test';
import assert from 'node:assert/strict';
import {ENTRY_MODES,entryMode,entryModeLabel,withEntryMode} from '../src/entry-mode.mjs';
import {validateConfig} from '../server/strategy.mjs';
import {Store} from '../server/store.mjs';

test('all four dropdown modes save mutually exclusive settings and preserve the configured delay across switching and reload',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  let config={...store.account('paper').config,entryDelay:20,followPreviousAtOpen:true,sameDirectionOnly:true};
  assert.equal(entryMode(config),'follow_previous');
  assert.equal(ENTRY_MODES.length,4);
  for(const option of [...ENTRY_MODES,...ENTRY_MODES.toReversed()]){
    config=validateConfig(withEntryMode(config,option.value));
    store.saveAccount({...store.account('paper'),config});
    const saved=store.account('paper').config;
    assert.equal(entryMode(saved),option.value);assert.equal(entryModeLabel(saved),option.label);assert.equal(saved.entryDelay,20);
    assert.equal(saved.followPreviousAtOpen&&saved.sameDirectionOnly,false);
    assert.equal([saved.followPreviousAtOpen,saved.sameDirectionOnly,saved.reverseSignal].filter(Boolean).length,option.value==='independent'?0:1);
    assert.equal(store.account('live').config.followPreviousAtOpen,false);
  }
  assert.throws(()=>withEntryMode(config,'invalid'),/无效/);
});
