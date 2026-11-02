import {historyKey,sessionHistory} from './session-history.mjs';

// 重传已生成的工具回复，不重新推理。只接受完整原请求或其后的纯“继续”控制；
// 回传过助手/工具结果、参数或旧历史有变化时，不用重传掩盖执行状态差异。
export function pendingResponseReplay(session,request,{hashKey,allowInstructionUpdates=false}={}){
 const frozen=session.state==='frozen'&&session.freezePreviousState==='waiting-tool'
  &&session.freezeReason==='ASSISTANT_MESSAGE_MISMATCH';
 if(session.state!=='waiting-tool'&&!frozen||session.turn||session.frozenTurn||session.interrupted
  ||!session.expected||!session.pendingIds?.size||!session.pendingHttp?.size||session.results?.size||session.pendingControls?.size)return;
 const assistant=session.lastAssistant,calls=assistant?.tool_calls,toolSchemas=session.historyNormalization?request.tools:undefined;
 if(!calls?.length||calls.length!==session.pendingIds.size||new Set(calls.map(c=>c.id)).size!==calls.length
  ||calls.some(c=>!session.pendingIds.has(c.id))||historyKey(assistant,{hashKey,toolSchemas})!==session.expected)return;
 for(const [id,pending]of session.pendingHttp){const call=session.lastCalls?.get(id);
  if(!call||pending.res?.destroyed||pending.name!==call.function.name||pending.args!==call.function.arguments)return;
 }
 const base=session.pendingReplyBase?.expected===session.expected?session.pendingReplyBase.history:session.history;
 const messages=sessionHistory(request.messages);
 if(!base.length||messages.length<base.length||!base.every((h,i)=>historyKey(messages[i],{hashKey,exact:allowInstructionUpdates,toolSchemas})===h))return;
 const tail=messages.slice(base.length);
 if(tail.length>16||tail.some(m=>!(allowInstructionUpdates&&['system','developer'].includes(m.role))
  &&(m.role!=='user'||typeof m.content!=='string'||! /^(?:继续\s*){1,8}$/.test(m.content.trim())
    ||Object.keys(m).some(k=>!['role','content'].includes(k)))))return;
 // 真实追加指令必须经原生控制通道确认，不能因重传而丢掉目录、文件变化提醒。
 const updates=tail.filter(m=>['system','developer'].includes(m.role));
 return {assistant:structuredClone(assistant),updates,base:[...base],history:messages.map(m=>historyKey(m,{hashKey,exact:allowInstructionUpdates,toolSchemas})),frozen};
}
