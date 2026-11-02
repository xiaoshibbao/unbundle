import {toolBoundarySnapshot} from './tool-boundary-trace.mjs';
import {callerRuntimeStatus} from './runtime-status.mjs';
import {stableJson} from './context.mjs';

// 历史往返别名，不改写执行命令、不声明 cwd 等价。仅用于仍在等待的原生调用；
// 完整助手哈希和回执集合仍由 continuationDelta 校验，结果仍回到原 MCP。
export function mappedPendingBashAssistant(message, session, snapshot=toolBoundarySnapshot) {
 if(!['waiting-tool','frozen'].includes(session.state)||session.turn||!session.pendingIds?.size
   ||session.results?.size||session.pendingControls?.size||!message?.tool_calls?.length)return message;
 if(session.state==='frozen'&&(session.freezePreviousState!=='waiting-tool'
   ||!['ASSISTANT_MESSAGE_MISMATCH','BASH_RECEIPT_REPRESENTATION'].includes(session.freezeReason)))return message;
 let changed=false;
 const calls=message.tool_calls.map(call=>{
  if(call.function?.name!=='Bash'||!session.pendingIds.has(call.id))return call;
  const native=session.lastCalls?.get(call.id),pending=session.pendingHttp?.get(call.id);
  if(native?.function?.name!=='Bash')return call;
  let input,originalInput;try{input=JSON.parse(call.function.arguments);originalInput=JSON.parse(native.function.arguments);}catch{return call;}
  if(pending&&(pending.name!=='Bash'||pending.args!==native.function.arguments))return call;
  const phases=snapshot([call.id])[0]?.phases,original=originalInput.command;
  if(typeof original!=='string'||phases?.cli?.command!==original||phases?.wire?.command!==original
    ||phases?.desktop?.command!==input.command)return call;
  const match=/^cd (\/[A-Za-z]\/[A-Za-z0-9_./-]+) && ([\s\S]+)$/.exec(original);
  if(!match||match[1].split('/').some(p=>p==='.'||p==='..')||match[2]!==input.command
    ||stableJson({...input,command:original})!==stableJson(originalInput))return call;
  changed=true;
  return {...call,function:{...call.function,arguments:native.function.arguments}};
 });
 return changed?{...message,tool_calls:calls}:message;
}

// 仅使用调用前已收到的目录更新与同 ID 的三点采样，不推测执行目录。
export function mappedBashAssistant(message, precedingMessages, snapshot=toolBoundarySnapshot) {
 let cwd;
 for(const entry of precedingMessages){
  const status=callerRuntimeStatus(entry);
  if(status?.type==='environment'){cwd=status.cwd;continue;}
  // Desktop 会把目录更新和进展提醒合并。这里只读取可信 system 消息开头的
  // 固定目录字段；整条消息仍是行为指令，不能按纯状态过滤或从指令通道移除。
  const text=Array.isArray(entry.content)&&entry.content.length===1?entry.content[0]?.text:entry.content;
  if(entry.role!=='system'||typeof text!=='string')continue;
  const update=/^\s*(?:<total_tokens>\d+ tokens left<\/total_tokens>\s*)*# Environment update\r?\n - Primary working directory: ([^\r\n]+) \(was ([^\r\n]+)\)(?:\r?\n|$)/.exec(text);
  if(!update)continue;
  // 多个目录声明不能挑一个相信，也不能退回更早目录证明本次命令等价。
  const absolute=value=>/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value)&&!/[\x00-\x1f<>]/.test(value);
  cwd=absolute(update[1])&&absolute(update[2])
    && !/(?:^|\n)\s*(?:# Environment|[- ]*Primary working directory:)/.test(text.slice(update[0].length))?update[1]:undefined;
 }
 if(!cwd||!Array.isArray(message?.tool_calls))return message;
 const pathKey=value=>{
  const win=/^([A-Za-z]):[\\/](.*)$/.exec(value);
  const bash=/^\/([A-Za-z])\/(.*)$/.exec(value);
  if(!win&&!bash)return undefined;
  const [,drive,tail]=win||bash;
  // 拒绝 shell 表达式、相对跳转与路径别名；不假设 Windows 路径大小写等价。
  if(!/^[A-Za-z0-9_./\\ -]+$/.test(tail)||tail.split(/[\\/]/).some(p=>p==='.'||p==='..'))return undefined;
  return drive.toLowerCase()+':/'+tail.replace(/\\/g,'/').replace(/\/$/,'');
 };
 const cwdKey=pathKey(cwd);if(!cwdKey)return message;
 let changed=false;
 const calls=message.tool_calls.map(call=>{
  if(call.function?.name!=='Bash')return call;
  let input;try{input=JSON.parse(call.function.arguments);}catch{return call;}
  const row=snapshot([call.id])[0],phases=row?.phases;
  const original=phases?.cli?.command;
  if(typeof original!=='string'||original!==phases?.wire?.command||input.command!==phases?.desktop?.command)return call;
  // 仅匹配一个无引号、无展开、无其他 shell 操作符的绝对 cd 前缀。
  const match=/^cd (\/[A-Za-z]\/[A-Za-z0-9_./-]+) && ([\s\S]+)$/.exec(original);
  if(!match||pathKey(match[1])!==cwdKey||match[2]!==input.command)return call;
  changed=true;
  return {...call,function:{...call.function,arguments:JSON.stringify({...input,command:original})}};
 });
 return changed?{...message,tool_calls:calls}:message;
}
