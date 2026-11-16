// Binance is a signal source only; settlement always uses Polymarket.
export class BinanceFeed{
  constructor(onSample,{now=Date.now}={}){this.onSample=onSample;this.now=now;this.error=null;this.closed=false;}
  start(){
    if(this.closed||this.socket)return;
    const ws=this.socket=new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@aggTrade');
    ws.onmessage=e=>{try{const x=JSON.parse(e.data),receivedAt=this.now();if(x.s!=='BTCUSDT'||!Number.isFinite(Number(x.p))||Number(x.p)<=0||!Number.isFinite(x.T))return;this.error=null;
      // Persist at most one tick per 100 ms; retain source and receipt timestamps.
      if(receivedAt-(this.lastSaved||0)<100)return;this.lastSaved=receivedAt;this.onSample({source:'binance',time:x.T,receivedAt,price:Number(x.p)});
    }catch(error){this.error=error.message;}};
    ws.onerror=()=>{this.error='Binance WebSocket 连接失败，等待重连';ws.close();};
    ws.onclose=()=>{this.socket=null;if(!this.closed)this.timer=setTimeout(()=>this.start(),3000);};
  }
  close(){this.closed=true;clearTimeout(this.timer);this.socket?.close();}
}
