import test from 'node:test';
import assert from 'node:assert/strict';
import {compactionRecord,compactedDelta,SUMMARY_HEADER} from './compaction-boundary.mjs';
const rules={role:'system',content:'original rules'},user={role:'user',content:'old task'},reply={role:'assistant',content:'old reply'};
const prefix='<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of C:\\Users\\caller\\.claude\\projects\\E--\\memory\\MEMORY.md (user\'s auto-memory, persists across conversations):\n\nCALLER_MEMORY\n</system-reminder>';
const summary=SUMMARY_HEADER+'\n\n<tools-used-before-summary>Read</tools-used-before-summary>\nSummary:\nVERIFIED_SUMMARY\nContinue now.';
function setup(){const session={request:{messages:[rules,user]},pendingIds:new Set(),nativeCompactionCommit:{boundaryUuid:'saved'}};session.compaction=compactionRecord(session,{messages:[user,reply,{role:'user',content:'summary request'}]},{content:'<summary>VERIFIED_SUMMARY</summary>'});return session;}
function request(value=prefix+'\n\n'+summary){return{messages:[rules,{role:'user',content:value},reply,{role:'user',content:'continue'}]};}
test('摘要前自动记忆独立保留为用户消息，真实保留回复仍核验，不重放旧历史',()=>{
 const delta=compactedDelta(setup(),request());assert(delta);assert.equal(delta[0].role,'user');assert(delta[0].content.endsWith(prefix));assert.equal(delta.at(-1).content,'continue');assert(!JSON.stringify(delta).includes('old reply'));assert(!JSON.stringify(delta).includes('old task'));
});
test('附加记忆不能绕过摘要、系统规则、保留回复和包装校验',()=>{
 for(const value of [prefix+'\n\n'+summary.replace('VERIFIED_SUMMARY','FORGED'),prefix.replace('MEMORY.md','other.txt')+'\n\n'+summary,'arbitrary prefix\n\n'+summary,prefix+'\nextra\n'+summary])assert.equal(compactedDelta(setup(),request(value)),undefined);
 assert.equal(compactedDelta(setup(),{messages:[{...rules,content:'changed'},...request().messages.slice(1)]}),undefined);
 const changed=request();changed.messages[2]={...reply,content:'changed'};assert.equal(compactedDelta(setup(),changed),undefined);
});

test('保留窗口中的完成工具批次允许已观察的 trim 与自动记忆，真实结果仍严格核对',()=>{
 const call={role:'assistant',content:null,tool_calls:[{id:'completed',type:'function',function:{name:'Bash',arguments:'{"command":"synthetic"}'}}]},receipt={role:'tool',tool_call_id:'completed',content:'  EXACT_RESULT\n'};
 const session={request:{messages:[rules,user]},pendingIds:new Set(),nativeCompactionCommit:{boundaryUuid:'saved'}};
 session.compaction=compactionRecord(session,{messages:[user,call,receipt,reply,{role:'user',content:'summary request'}]},{content:'<summary>VERIFIED_SUMMARY</summary>'});
 const incoming={messages:[rules,{role:'user',content:summary},call,{...receipt,content:'EXACT_RESULT\n\n'+prefix},{role:'user',content:'continue'}]};
 const delta=compactedDelta(session,incoming);assert(delta);assert(delta.some(m=>m.content.endsWith(prefix)));assert.equal(delta.at(-1).content,'continue');assert(!delta.some(m=>m.role==='tool'||m.role==='assistant'));assert(!JSON.stringify(session.compaction).includes('EXACT_RESULT'));
 for(const patch of [{content:'DIFFERENT\n\n'+prefix},{tool_call_id:'another'},{content:'EXACT_RESULT\n\n'+prefix.replace('MEMORY.md','other.txt')}]){
  const bad=structuredClone(incoming);bad.messages[3]={...bad.messages[3],...patch};assert.equal(compactedDelta(session,bad),undefined);
 }
 const bad=structuredClone(incoming);bad.messages[2].tool_calls[0].function.arguments='{"command":"changed"}';assert.equal(compactedDelta(session,bad),undefined);
});

test('原生压缩后刷新 SDK 系统指令只在动态通道开启且摘要/保留历史全部核验时续接',()=>{
 const session=setup(),incoming=request(),updated={role:'system',content:'NEW_REAL_CALLER_SDK_INSTRUCTIONS'};incoming.messages[0]=updated;
 assert.equal(compactedDelta(session,incoming),undefined);
 const delta=compactedDelta(session,incoming,{allowInstructionUpdates:true});assert(delta);assert.equal(delta[0],updated);assert.equal(delta.at(-1).content,'continue');
 const forged=structuredClone(incoming);forged.messages[1].content=forged.messages[1].content.replace('VERIFIED_SUMMARY','FORGED');assert.equal(compactedDelta(session,forged,{allowInstructionUpdates:true}),undefined);
 const branch=structuredClone(incoming);branch.messages[2].content='different retained reply';assert.equal(compactedDelta(session,branch,{allowInstructionUpdates:true}),undefined);
 const more={...incoming,messages:[updated,updated,...incoming.messages.slice(1)]};assert.equal(compactedDelta(session,more,{allowInstructionUpdates:true}),undefined);
 session.compaction.nativeCommitted=false;assert.equal(compactedDelta(session,incoming,{allowInstructionUpdates:true}),undefined);
});
