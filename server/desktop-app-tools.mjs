import net from 'node:net';
import {readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DEFAULT_PIPE,encodeFrame,FrameDecoder} from './desktop-ipc.mjs';

const pipeRoot=DEFAULT_PIPE.slice(0,-'codex-ipc'.length);
function rpc(path,method,params){
  const frame=encodeFrame({jsonrpc:'2.0',id:1,method,params});
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(path);
    const finish=(error,value)=>{
      clearTimeout(timer);
      socket.destroy();
      if(error)reject(error);else resolve(value);
    };
    const timer=setTimeout(()=>finish(Error('桌面工具请求超时')),5000);
    const decoder=new FrameDecoder(message=>{
      if(message.id!==1)return;
      if(message.jsonrpc!=='2.0'||message.error)finish(Error('当前桌面工具拒绝请求'));
      else finish(null,message.result);
    },{maxFrameBytes:8*1024*1024});
    socket.once('error',error=>finish(error));
    socket.once('close',()=>finish(Error('桌面工具连接已关闭')));
    socket.once('connect',()=>socket.write(frame));
    socket.on('data',chunk=>{try{decoder.push(chunk);}catch(error){finish(error);}});
  });
}

function payload(result){
  if(result?.success!==true)throw Error('桌面工具未确认请求');
  const body=result.structuredContent??result.data??result.output;
  if(body && typeof body==='object')return body;
  for(const item of result.contentItems??[]){
    if(item.json&&typeof item.json==='object')return item.json;
    if(typeof item.text==='string'){try{return JSON.parse(item.text);}catch{}}
  }
  throw Error('桌面工具返回格式不兼容');
}

export class DesktopAppTools {
  #endpoint;
  #lookup;
  get modelSelectionSupported(){
    const props=this.#endpoint?.send;
    return props?.model?.type==='string'&&props?.thinking?.type==='string';
  }
  async #discover(){
    const pipes=await readdir(pipeRoot);
    if(pipes.includes('codex-ipc'))throw Error('桌面旧版控制入口仍存在');
    const candidates=pipes.filter(name=>name.startsWith('codex-app-tools-'));
    if(candidates.length!==1)throw Error('未找到唯一的桌面工具入口');
    const path=pipeRoot+candidates[0];
    if(this.#endpoint?.path===path)return this.#endpoint;
    const result=await rpc(path,'tools/list',{threadStartKind:'all'});
    const tools=new Map((result?.tools??[]).filter(tool=>tool.namespace==='codex_app').map(tool=>[tool.name,tool.inputSchema]));
    const read=tools.get('read_thread'),send=tools.get('send_message_to_thread');
    if(read?.properties?.threadId?.type!=='string'||send?.properties?.threadId?.type!=='string'||
       send.properties?.prompt?.type!=='string'||!send.required?.includes('threadId')||
       !send.required.includes('prompt')||send.required.some(key=>!['threadId','prompt'].includes(key))){
      throw Error('当前桌面版不支持按会话 ID 发送');
    }
    this.#endpoint={path,read:read.properties,send:send.properties};
    return this.#endpoint;
  }
  async #call(threadId,tool,params){
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId))throw Error('无效的本机会话 ID');
    this.#lookup??=this.#discover().finally(()=>{this.#lookup=null;});
    const endpoint=await this.#lookup;
    const props=tool==='read_thread'?endpoint.read:endpoint.send;
    const args={threadId,...Object.fromEntries(Object.entries(params).filter(([key])=>Object.hasOwn(props,key)))};
    const callId=randomUUID();
    try {
      return payload(await rpc(endpoint.path,'tools/call',{
        namespace:'codex_app',tool,arguments:args,callerSource:'codex',threadId,callId,turnId:callId,
      }));
    } catch(error){this.#endpoint=undefined;throw error;}
  }
  async status(threadId){
    const {thread}=await this.#call(threadId,'read_thread',{hostId:'local',includeTurns:false,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:1000});
    if(thread?.id!==threadId&&thread?.threadId!==threadId)throw Error('读取回执与目标会话不符');
    return thread.status?.type??thread.status;
  }
  async send(threadId,text,settings){
    const ack=await this.#call(threadId,'send_message_to_thread',{hostId:'local',prompt:text,...settings});
    if(ack?.threadId!==threadId)throw Error('发送回执与目标会话不符');
  }
}
