import {historyKey,sessionHistory,continuationDelta} from './session-history.mjs';
import {toolBoundarySnapshot} from './tool-boundary-trace.mjs';
import {stableJson} from './context.mjs';
// 这不是命令等价性判断：保存真实执行表示和回执，目录未核验时明确告知模型。
export function bashReceiptHandoff(session,request,options={},snapshot=toolBoundarySnapshot){
 const waiting=session.state==='waiting-tool'||session.state==='frozen'&&session.freezePreviousState==='waiting-tool'&&['ASSISTANT_MESSAGE_MISMATCH','BASH_RECEIPT_REPRESENTATION'].includes(session.freezeReason);
 if(!waiting||session.turn||session.frozenTurn||!session.expected||!session.pendingIds.size||session.results.size||session.pendingControls.size)return;
 const messages=sessionHistory(request.messages),actual=messages[session.history.length];
 if(actual?.role!=='assistant'||!actual.tool_calls?.length)return;
 const hash=m=>historyKey(m,{hashKey:options.hashKey,toolSchemas:session.historyNormalization?request.tools:undefined});
 if(hash(actual)===session.expected)return;
 const canonical=structuredClone(actual),changes=[];
 for(const call of canonical.tool_calls){
  const phases=snapshot([call.id])[0]?.phases;let input;
  try{input=JSON.parse(call.function.arguments);}catch{return;}
  if(call.function.name!=='Bash'||typeof input.command!=='string')continue;
  const original=phases?.cli?.command;
  if(original===input.command)continue;
  const match=typeof original==='string'&&/^cd (\/[A-Za-z]\/[A-Za-z0-9_./-]+) && ([\s\S]+)$/.exec(original);
  if(!match||match[1].split('/').some(p=>p==='.'||p==='..')||phases?.wire?.command!==original||phases?.desktop?.command!==input.command||match[2]!==input.command)return;
  changes.push({id:call.id,originalCommand:original,callerCommand:input.command,executionDirectoryVerified:false});
  call.function.arguments=JSON.stringify({...input,command:original});
 }
 // 覆盖全部助手字段、工具 ID/顺序和其余参数；不能借此放过其他变化。
 if(!changes.length||hash(canonical)!==session.expected)return;
 const delta=continuationDelta({...session,interrupted:false,expected:hash(actual)},request,options);
 if(!delta||delta.filter(m=>m.role==='tool').length!==session.pendingIds.size)return;
 return{delta,context:{role:'user',content:stableJson({kind:'caller_command_representation_discrepancy',changes,note:'This is automatic gateway transport recovery, not a user cancellation. The gateway issued the internal interrupt only to settle a protocol handoff. Any native interruption marker from this recovery does not mean the user stopped or changed the task. Continue the current authorized user task after reading these results; do not pause or ask for another continue solely because of this internal recovery. If information is missing, inspect the preserved context and available tools. The caller already completed these tool calls; their actual results are buffered separately. Do not repeat completed operations. Original native commands and caller representations are retained separately and are NOT declared equivalent. The execution directory was not independently verified; inspect actual output and file state before relying on the outcome.'})}};
}
