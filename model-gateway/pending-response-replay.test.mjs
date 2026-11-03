import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingResponseReplay} from './pending-response-replay.mjs';
import {historyKey} from './session-history.mjs';

function fixture(){
 const prefix=[{role:'user',content:'original task'}],call={id:'pending',type:'function',function:{name:'Write',arguments:'{"path":"same"}'}},assistant={role:'assistant',content:null,tool_calls:[call]};
 const session={state:'waiting-tool',history:prefix.map(m=>historyKey(m)),expected:historyKey(assistant),lastAssistant:assistant,
  pendingIds:new Set([call.id]),pendingHttp:new Map([[call.id,{name:'Write',args:call.function.arguments}]]),lastCalls:new Map([[call.id,call]]),results:new Map(),pendingControls:new Map()};
 return{prefix,session,request:{messages:prefix},assistant};
}
test('只接受原请求或纯继续控制；客户端已有助手或收据不能再次交付',()=>{
 const f=fixture();assert(pendingResponseReplay(f.session,f.request));
 assert(pendingResponseReplay(f.session,{messages:[...f.prefix,{role:'user',content:'继续'}]}));
 const instruction={role:'system',content:'Current directory changed; a file changed externally. Preserve it.'};
 const updated=pendingResponseReplay(f.session,{messages:[...f.prefix,{role:'user',content:'继续'},instruction]},{allowInstructionUpdates:true});
 assert.deepEqual(updated.updates,[instruction]);
 for(const messages of [[{role:'user',content:'changed task'}],[...f.prefix,{role:'user',content:'重做文件'}],
  [...f.prefix,f.assistant],[...f.prefix,f.assistant,{role:'tool',tool_call_id:'pending',content:'DONE'}],
  [...f.prefix,{role:'system',content:'changed instructions'}]])assert.equal(pendingResponseReplay(f.session,{messages}),undefined);
});
test('已交回部分结果、MCP断开、原调用变化及其他冻结原因不能用重传恢复',()=>{
 const f=fixture();
 for(const patch of [{results:new Map([['pending',{}]])},{pendingHttp:new Map()},
  {pendingHttp:new Map([['pending',{name:'Write',args:'{}'}]])},
  {pendingHttp:new Map([['pending',{name:'Write',args:'{"path":"same"}',res:{destroyed:true}}]])},
  {pendingControls:new Map([['active',{}]])},{pendingIds:new Set()},
  {state:'frozen',freezePreviousState:'waiting-tool',freezeReason:'CLI_UNREQUESTED_CONTINUATION'},
  {turn:{}},{frozenTurn:{}},{interrupted:true}])assert.equal(pendingResponseReplay({...f.session,...patch},f.request),undefined);
 const frozen={...f.session,state:'frozen',freezePreviousState:'waiting-tool',freezeReason:'ASSISTANT_MESSAGE_MISMATCH'};
 assert(pendingResponseReplay(frozen,f.request));
});

test('蓝屏占位符仅在完整旧历史与原 MCP 等待一致时重传，并保留用户补充',()=>{
 const f=fixture(),marker={role:'assistant',content:'No response requested.'},user={role:'user',content:'请先解释当前状态，然后继续'};
 const request={messages:[...f.prefix,marker,user]};
 const result=pendingResponseReplay(f.session,request);assert.deepEqual(result.userMessages,[user]);
 assert.deepEqual(result.assistant,f.assistant);
 for(const tail of [[marker],[marker,user,{role:'tool',tool_call_id:'pending',content:'DONE'}],[marker,user,marker],
  [{role:'assistant',content:'different'},user]])assert.equal(pendingResponseReplay(f.session,{messages:[...f.prefix,...tail]}),undefined);
 assert.equal(pendingResponseReplay({...f.session,history:[historyKey({role:'user',content:'other'})]},request),undefined);
 assert.equal(pendingResponseReplay({...f.session,pendingHttp:new Map()},request),undefined);
});
