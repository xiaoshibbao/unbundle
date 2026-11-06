import test from 'node:test';
import assert from 'node:assert/strict';
import {compactionBoundary,compactionIntent} from './compaction-boundary.mjs';
const system={role:'system',content:'You are a helpful AI assistant tasked with summarizing conversations.'};
const prompt={role:'user',content:'Your task is to create a detailed summary of the conversation so far, paying close attention to the user.'};
const user={role:'user',content:'synthetic task'},assistant={role:'assistant',content:'done'};
const session={state:'idle',request:{model:'model',messages:[{role:'system',content:'original rules'},user],tools:[]},lastAssistant:assistant,pendingIds:new Set()};
const request={model:'model',messages:[system,user,assistant,prompt],tools:[]};
test('摘要系统与工具配置不同仍能严格关联原会话，不修改原历史',()=>{
 const before=JSON.stringify(session);assert.deepEqual(compactionBoundary(session,request),{prompt,receipts:[]});assert.equal(JSON.stringify(session),before);
});
test('普通用户摘要要求、外来历史、模型变化和冻结会话均不能绕过校验',()=>{
 assert.equal(compactionIntent({...request,messages:[user,assistant,{role:'user',content:'summarize the task'}]}),undefined);
 assert.equal(compactionBoundary(session,{...request,messages:[system,{...user,content:'foreign'},assistant,prompt]}),undefined);
 assert.equal(compactionBoundary(session,{...request,model:'other'}),undefined);
 assert.equal(compactionBoundary({...session,state:'frozen'},request),undefined);
});
test('等待工具的摘要请求必须带齐对应真实结果，重复和错配结果拒绝',()=>{
 const s={...session,state:'waiting-tool',pendingIds:new Set(['tool'])};
 const receipt={role:'tool',tool_call_id:'tool',content:'actual receipt'};
 assert.equal(compactionBoundary(s,request),undefined);
 assert.deepEqual(compactionBoundary(s,{...request,messages:[system,user,assistant,receipt,prompt]}),{prompt,receipts:[receipt]});
 assert.equal(compactionBoundary(s,{...request,messages:[system,user,assistant,receipt,receipt,prompt]}),undefined);
 assert.equal(compactionBoundary(s,{...request,messages:[system,user,assistant,{...receipt,tool_call_id:'other'},prompt]}),undefined);
});

test('真实 Desktop 压缩形态保留原系统与工具，末尾状态消息不遮住摘要要求',()=>{
 const original={...session,request:{...session.request,tools:[]}};
 const actual={...request,tools:[],messages:[session.request.messages[0],user,assistant,{role:'user',content:'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far, preserving the task.'},{role:'system',content:'<total_tokens>100 tokens left</total_tokens>'}]};
 assert(compactionBoundary(original,actual));
 assert.equal(compactionBoundary(original,{...actual,messages:[{role:'system',content:'changed rules'},...actual.messages.slice(1)]}),undefined);
});

test('失败的本地 compact 命令记录作为新增用户上下文保留，不当作工具结果',()=>{
 const local={role:'user',content:'<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>'};
 const actual={...request,messages:[...request.messages.slice(0,-1),local,prompt]};
 assert.deepEqual(compactionBoundary(session,actual),{prompt,receipts:[],additionalUsers:[local]});
 assert.equal(compactionBoundary(session,{...actual,messages:[...request.messages.slice(0,-1),{role:'assistant',content:'unverified branch'},prompt]}),undefined);
});

test('手动压缩合并末条用户文本时保留原前缀，仍严格验证历史',()=>{
 const instruction='CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n'+prompt.content;
 const req={model:'test',messages:[system,user,{role:'user',content:'继续\n\n'+instruction}]};
 const intent=compactionIntent(req);assert.deepEqual(intent.messages,[user,{role:'user',content:'继续'}]);assert.equal(intent.prompt.content,instruction);
 const normal=compactionIntent({...req,messages:[system,user,{role:'user',content:instruction}]});assert.deepEqual(normal.messages,[user]);
 assert.equal(compactionIntent({...req,messages:[system,user,{role:'user',content:'继续\n\nYour task is to create a detailed summary of unrelated data'}]}),undefined);
});


test('Desktop 省略旧头部后仅允许唯一完整工具批次至最新回复的严格尾部用于压缩',()=>{
 const call={role:'assistant',content:null,tool_calls:[{id:'known-id',type:'function',function:{name:'Bash',arguments:'{"command":"pwd"}'}}]};
 const receipt={role:'tool',tool_call_id:'known-id',content:'/trusted/path'};
 const s={...session,request:{...session.request,messages:[session.request.messages[0],user,call,receipt]},lastAssistant:assistant};
 const r={...request,messages:[system,call,receipt,assistant,prompt]};
 assert.deepEqual(compactionBoundary(s,r),{prompt,receipts:[]});
 assert.equal(compactionBoundary(s,{...r,messages:[system,call,{...receipt,content:'changed'},assistant,prompt]}),undefined);
 assert.equal(compactionBoundary(s,{...r,messages:[system,{...call,tool_calls:[{...call.tool_calls[0],id:'foreign'}]},receipt,assistant,prompt]}),undefined);
 assert.equal(compactionBoundary(s,{...r,messages:[system,receipt,call,assistant,prompt]}),undefined);
 assert.equal(compactionBoundary(s,{...r,messages:[system,assistant,prompt]}),undefined);
 assert.equal(compactionBoundary(s,{...r,messages:[system,call,receipt,prompt]}),undefined);
 assert.equal(compactionBoundary({...s,state:'waiting-tool'},r),undefined);
 const repeated={...s,request:{...s.request,messages:[...s.request.messages,call,receipt]}};
 assert.equal(compactionBoundary(repeated,r),undefined);
});


import {recordBashPhase} from './tool-boundary-trace.mjs';
import {historyKey} from './session-history.mjs';
test('原生等待工具时压缩采用与普通续接相同的已采样 Bash 往返别名',()=>{
 const id='compact-pending-bash',original='cd /e/ps && echo receipt';
 for(const phase of ['cli','wire','desktop'])recordBashPhase(phase,id,'Bash',{command:phase==='desktop'?'echo receipt':original});
 const native={role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name:'Bash',arguments:JSON.stringify({command:original,description:'test'})}}]};
 const actual={...native,tool_calls:[{...native.tool_calls[0],function:{name:'Bash',arguments:JSON.stringify({command:'echo receipt',description:'test'})}}]};
 const receipt={role:'tool',tool_call_id:id,content:'REAL_RESULT'};
 const s={...session,state:'waiting-tool',lastAssistant:native,expected:historyKey(native),lastCalls:new Map([[id,native.tool_calls[0]]]),pendingIds:new Set([id]),pendingHttp:new Map([[id,{name:'Bash',args:native.tool_calls[0].function.arguments}]]),results:new Map(),pendingControls:new Map()};
 const r={...request,messages:[system,user,actual,receipt,prompt]};
 assert.deepEqual(compactionBoundary(s,r),{prompt,receipts:[receipt]});
 for(const change of [v=>v.messages[2].content='changed',v=>v.messages[2].tool_calls[0].function.arguments='{"command":"echo different","description":"test"}',v=>v.messages[3].tool_call_id='other',v=>v.messages.splice(3,1),v=>v.messages.splice(3,0,receipt)]){
  const v=structuredClone(r);change(v);assert.equal(compactionBoundary(s,v),undefined);
 }
 assert.equal(compactionBoundary({...s,lastCalls:new Map()},r),undefined);
});
