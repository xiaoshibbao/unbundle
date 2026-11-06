import {continuationDelta,sessionHistory,historyKey} from './session-history.mjs';
import {callerRuntimeStatus} from './runtime-status.mjs';

export const REFUSAL_CONTINUATION_NOTICE='Your response above was stopped by a safety classifier — this is not a tool or API error. The rest of it was withheld, and tool calls in it that had not finished did not run. Do not produce that content again, even reworded.';
// 只处理已确认拒绝的原生检查点：保留拒绝和客户端限制，不回放被扣留的工具或伪造助手消息。
export function refusalCheckpointDelta(row,request,{hashKey,allowInstructionUpdates=false}={}) {
 if(row.completedRefusal!==true||row.interrupted||!row.expected||!row.history?.length)return;
 const options={hashKey,exact:allowInstructionUpdates,toolSchemas:row.historyNormalization===true?request.tools:undefined};
 let messages=sessionHistory(request.messages);const index=row.history.length;
 const environment=m=>callerRuntimeStatus(m)?.type==='environment'||typeof m?.content==='string'&&callerRuntimeStatus({...m,content:m.content+'\n'})?.type==='environment';
 const notice=m=>m?.role==='user'&&m.content===REFUSAL_CONTINUATION_NOTICE&&Object.keys(m).every(k=>['role','content'].includes(k));
 // Desktop 将自动限制提示插到原请求末尾的目录快照之前；只重排同一份已核验的纯目录状态。
 if(notice(messages[index-1])&&environment(messages[index])
   &&historyKey(messages[index],options)===row.history.at(-1))messages=[...messages.slice(0,index-1),messages[index],messages[index-1],...messages.slice(index+1)];
 if(!notice(messages[index]))return;
 return continuationDelta({...row,interrupted:true,cancelledReceiptIds:undefined,pendingIds:new Set()}, {...request,messages},{hashKey,allowInstructionUpdates});
}
