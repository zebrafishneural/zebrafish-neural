const CONFIG_URL=new URL('../live-config.json',import.meta.url);
const LOOPBACK=new Set(['localhost','127.0.0.1']);

function validPacket(data){
  return data!==null && typeof data==='object' && data.schemaVersion===1 &&
    Array.isArray(data.rates) && data.rates.length===8 && data.rates.every(Number.isFinite);
}

/** Read-only shared controller transport. The optional second argument supplies test dependencies. */
export class SharedFeed {
  constructor({onData=()=>{},onStatus=()=>{}}={},dependencies={}){
    this.onData=onData;this.onStatus=onStatus;
    this.env={fetch:globalThis.fetch?.bind(globalThis),WebSocket:globalThis.WebSocket,
      now:()=>performance.now(),setTimeout:globalThis.setTimeout.bind(globalThis),
      clearTimeout:globalThis.clearTimeout.bind(globalThis),
      location:globalThis.location,AbortController:globalThis.AbortController,...dependencies};
    this.active=false;this.generation=0;this.connection=0;this.socket=null;this.endpoint='';
    this.requests=new Set();this.retryTimer=null;this.watchdogTimer=null;this.openTimer=null;
    this.latest=null;this.lastPacketAt=null;this.openedAt=null;this.retries=0;this.lastStatus=null;
  }
  start(){
    if(this.active)return;
    this.active=true;this.generation++;this.retries=0;this.lastStatus=null;
    this.latest=null;this.lastPacketAt=null;this.openedAt=null;this.endpoint='';
    const generation=this.generation;
    this.watch(generation);void this.connect(generation);
  }
  stop(){
    this.active=false;this.generation++;this.connection++;
    for(const name of ['retryTimer','watchdogTimer','openTimer'])this.clearTimer(name);
    for(const request of this.requests){request.controller.abort();this.env.clearTimeout(request.timer);}
    this.requests.clear();
    const socket=this.socket;this.socket=null;
    try{socket?.close();}catch{}
    this.endpoint='';this.latest=null;this.lastPacketAt=null;this.openedAt=null;
  }
  current(generation,connection=this.connection){
    return this.active && generation===this.generation && connection===this.connection;
  }
  clearTimer(name){
    if(this[name]!==null)this.env.clearTimeout(this[name]);
    this[name]=null;
  }
  status(label,detail,kind){
    const key=JSON.stringify([label,detail,kind]);
    if(key===this.lastStatus)return;
    this.lastStatus=key;this.onStatus({label,detail,kind});
  }
  async request(url,read){
    const controller=new this.env.AbortController();
    const timer=this.env.setTimeout(()=>controller.abort(),8000);
    const pending={controller,timer};this.requests.add(pending);
    try{
      const response=await this.env.fetch(url,{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error('The controller request failed');
      return await read(response);
    }finally{
      this.env.clearTimeout(timer);this.requests.delete(pending);
    }
  }
  async connect(generation){
    if(!this.current(generation))return;
    const connection=++this.connection;
    this.endpoint='';this.openedAt=null;this.lastPacketAt=null;this.latest=null;
    this.status('Connecting','Connecting to the shared controller.','connecting');
    if(!this.current(generation,connection))return;
    try{
      const config=await this.request(CONFIG_URL,response=>response.json());
      if(!this.current(generation,connection))return;
      const url=new URL(config.endpoint);
      if(url.protocol!=='https:' && !(url.protocol==='http:' && LOOPBACK.has(url.hostname) && LOOPBACK.has(this.env.location?.hostname)))throw Error('Unsupported controller endpoint');
      this.endpoint=url.origin;
      const socketURL=new URL('/ws',this.endpoint);socketURL.protocol=url.protocol==='https:'?'wss:':'ws:';
      const socket=new this.env.WebSocket(socketURL);this.socket=socket;
      const ownsSocket=()=>this.current(generation,connection)&&this.socket===socket;
      this.openTimer=this.env.setTimeout(()=>{
        if(ownsSocket() && socket.readyState!==this.env.WebSocket.OPEN)this.disconnected(socket,generation,connection);
      },12000);
      socket.addEventListener('open',()=>{
        if(!ownsSocket())return;
        this.clearTimer('openTimer');this.openedAt=this.env.now();this.lastPacketAt=null;
      });
      socket.addEventListener('message',event=>{
        if(!ownsSocket())return;
        let data;try{data=JSON.parse(event.data);}catch{return;}
        if(!validPacket(data))return;
        this.lastPacketAt=this.env.now();this.latest=data;this.retries=0;this.lastStatus=null;
        this.onData(data);
      });
      socket.addEventListener('error',()=>{if(ownsSocket())this.disconnected(socket,generation,connection);});
      socket.addEventListener('close',()=>{if(ownsSocket())this.disconnected(socket,generation,connection);});
    }catch{
      if(!this.current(generation,connection))return;
      this.status('Offline','The controller host is not reachable. Reconnecting automatically.','offline');
      this.schedule(generation);
    }
  }
  disconnected(socket,generation,connection){
    if(!this.current(generation,connection)||this.socket!==socket)return;
    this.socket=null;this.openedAt=null;this.clearTimer('openTimer');
    try{socket.close();}catch{}
    this.status('Offline','The controller host is not reachable. Reconnecting automatically.','offline');
    this.schedule(generation);
  }
  schedule(generation){
    if(!this.current(generation)||this.retryTimer!==null)return;
    const delay=Math.min(15000,2000*2**Math.min(this.retries++,3));
    this.retryTimer=this.env.setTimeout(()=>{
      this.retryTimer=null;
      if(this.current(generation))void this.connect(generation);
    },delay);
  }
  watch(generation){
    this.watchdogTimer=this.env.setTimeout(()=>{
      this.watchdogTimer=null;
      if(!this.current(generation))return;
      const socket=this.socket;
      if(socket?.readyState===this.env.WebSocket.OPEN && this.openedAt!==null){
        const elapsed=this.env.now()-(this.lastPacketAt??this.openedAt);
        const frameAge=this.latest?.frame?.ageMs;
        const staleFrame=Number.isFinite(frameAge) && frameAge>=0 && frameAge+elapsed>=6000;
        if(elapsed>=6000||staleFrame)this.status('Interrupted','No fresh browser frames. Waiting for the shared controller.','interrupted');
        if(elapsed>=12000)this.disconnected(socket,generation,this.connection);
      }
      if(this.current(generation))this.watch(generation);
    },1000);
  }
  async getRecording(){
    if(!this.active||!this.endpoint)throw Error('The shared controller is not connected');
    const generation=this.generation,connection=this.connection,endpoint=this.endpoint;
    const blob=await this.request(endpoint+'/recording.json',response=>response.blob());
    if(!this.current(generation,connection)||this.endpoint!==endpoint)throw Error('The shared controller connection changed');
    return blob;
  }
}
