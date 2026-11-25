// State and market data remain independent producers on one browser connection.
// A silent or busy strategy never gates live chart frames.
export function serveUiStream(req,res,engine,{chart=null,state=true,prices=true}={}){
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});
  res.flushHeaders();
  const cleanup=[];
  let queuedState=null;
  const sendState=value=>{
    if(res.writableEnded||res.destroyed)return;
    if(res.writableNeedDrain){queuedState=value;return;}
    queuedState=null;res.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  if(state){
    const drain=()=>{if(queuedState)sendState(queuedState);};
    sendState(engine.snapshot());engine.on('update',sendState);res.on('drain',drain);
    cleanup.push(()=>{engine.off('update',sendState);res.off('drain',drain);});
  }
  if(prices){
    const feed=chart?.feed??engine.venue.priceFeed,opening=chart?.opening,range=chart?.range;
    let queued=[];const pending=new Map();
    const write=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const send=(latest,points=[latest])=>{
      if(res.writableEnded||res.destroyed)return;
      const window=latest?.oracleWindow;
      queued=queued.concat(points.map(point=>window==null?point:{...point,oracleWindow:window})).slice(-120);
      if(res.writableNeedDrain||!queued.length)return;
      const data=queued;queued=[];write('chart-prices',data);
    };
    const sendValue=(event,value)=>{
      if(res.writableEnded||res.destroyed)return;
      if(res.writableNeedDrain){pending.set(event,value);return;}
      pending.delete(event);write(event,value);
    };
    const sendOpening=value=>sendValue('chart-opening',value),sendRange=value=>sendValue('chart-range',value);
    const drain=()=>{
      for(const [event,value] of pending){if(res.writableNeedDrain)return;sendValue(event,value);}
      send(null,[]);
    };
    opening?.on('opening',sendOpening);const savedOpening=opening?.current();if(savedOpening)sendOpening(savedOpening);
    range?.on('range',sendRange);if(range)sendRange(range.current());res.on('drain',drain);
    const recent=feed?.recent?.(2000).map(point=>({...point,oracleWindow:feed.spec?.seconds}));
    const saved=chart?.store?.ticks(Date.now()-31*60000,{withOracle:true}),seed=new Map();
    for(const point of [...(saved??[]),...(recent??[])])seed.set(point.time,point);
    if(seed.size)sendValue('chart-history',[...seed.values()].sort((a,b)=>a.time-b.time).slice(-2000));
    feed?.on?.('price',send);
    cleanup.push(()=>{feed?.off?.('price',send);opening?.off('opening',sendOpening);range?.off('range',sendRange);res.off('drain',drain);});
  }
  const heartbeat=setInterval(()=>{if(!res.writableNeedDrain&&!res.destroyed)res.write(': keep-alive\n\n');},15000);
  req.once('close',()=>{clearInterval(heartbeat);for(const close of cleanup)close();});
}
