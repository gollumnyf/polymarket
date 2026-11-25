// Hidden tabs release their long-lived HTTP connection. Reopening replays state
// and chart history; trading continues independently in the server.
export function connectPageStream({url,onState,onPrices,onHistory,onOpening,onRange,onConnected,onOpen,
  document=globalThis.document,window=globalThis.window,EventSource=globalThis.EventSource}){
  let stream=null,closed=false;
  const disconnect=()=>{
    if(stream){const previous=stream;stream=null;previous.close();}
    onConnected(false);
  };
  const connect=()=>{
    if(closed||document.hidden||stream)return;
    const current=new EventSource(url);stream=current;
    const listen=(event,handle)=>current.addEventListener(event,message=>{
      if(stream===current&&!closed)handle(JSON.parse(message.data));
    });
    listen('message',onState);listen('chart-prices',onPrices);listen('chart-history',onHistory);
    listen('chart-opening',onOpening);listen('chart-range',onRange);
    current.onopen=()=>{if(stream===current&&!closed){onConnected(true);onOpen?.();}};
    current.onerror=()=>{if(stream===current&&!closed)onConnected(false);};
  };
  const visibility=()=>document.hidden?disconnect():connect();
  document.addEventListener('visibilitychange',visibility);
  window?.addEventListener('pagehide',disconnect);window?.addEventListener('pageshow',connect);
  connect();
  return ()=>{closed=true;disconnect();document.removeEventListener('visibilitychange',visibility);
    window?.removeEventListener('pagehide',disconnect);window?.removeEventListener('pageshow',connect);};
}
