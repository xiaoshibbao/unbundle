import test from 'node:test';
import assert from 'node:assert/strict';
import {recordBashPhase} from './tool-boundary-trace.mjs';
import {mappedBashAssistant,mappedPendingBashAssistant} from './bash-roundtrip.mjs';
import {continuationDelta,historyKey} from './session-history.mjs';
import {recoveryDelta} from './session-recovery.mjs';
import {callerRuntimeStatus} from './runtime-status.mjs';
import {compileContext} from './context.mjs';
const env=cwd=>({role:'system',content:`# Environment update\n - Primary working directory: ${cwd} (was E:\\)\n`});

test('原生等待边界使用独立历史别名，不猜测目录，不放宽其他字段或回执',()=>{
 const {expected,actual}=fixture('pending-alias');
 const native=expected.tool_calls[0],receipt={role:'tool',tool_call_id:native.id,content:'REAL'};
 const session={state:'waiting-tool',request:{messages:[]},history:[],expected:historyKey(expected),
  lastCalls:new Map([[native.id,native]]),pendingIds:new Set([native.id]),
  pendingHttp:new Map([[native.id,{name:'Bash',args:native.function.arguments}]]),results:new Map(),pendingControls:new Map()};
 const request={messages:[actual,receipt]};
 assert.deepEqual(continuationDelta(session,request),[receipt]);
 assert.deepEqual(recoveryDelta({...session,state:'frozen',freezePreviousState:'waiting-tool',freezeReason:'ASSISTANT_MESSAGE_MISMATCH'},request),[receipt]);
 assert.equal(JSON.parse(actual.tool_calls[0].function.arguments).command,'python promo/build.py');
 for(const mutate of [r=>r.messages[0].content='changed',r=>r.messages[0].tool_calls[0].id='other',
  r=>r.messages[0].tool_calls[0].function.arguments='{"command":"python other.py","description":"build"}',
  r=>r.messages[0].tool_calls[0].function.arguments='{"command":"python promo/build.py","description":"changed"}',
  r=>r.messages[1].tool_call_id='other',r=>r.messages.push(receipt)]){
  const changed=structuredClone(request);mutate(changed);assert.equal(continuationDelta(session,changed),undefined);
 }
 assert.strictEqual(mappedPendingBashAssistant(actual,{...session,lastCalls:new Map()}),actual);
 assert.strictEqual(mappedPendingBashAssistant(actual,{...session,pendingHttp:new Map([[native.id,{name:'Bash',args:'{}'}]])}),actual);
 assert.strictEqual(mappedPendingBashAssistant(actual,session,()=>[]),actual);
});
function fixture(id,original='cd /e/sr/Poem && python promo/build.py',returned='python promo/build.py',wire=original){
 for(const [phase,command] of [['cli',original],['wire',wire],['desktop',returned]])recordBashPhase(phase,id,'Bash',{command});
 const make=command=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name:'Bash',arguments:JSON.stringify({command,description:'build'})}}]});
 return {expected:make(original),actual:make(returned)};
}
test('仅三点证据与调用前目录均一致时接受；原历史和结果不被改写',()=>{
 const {expected,actual}=fixture('verified');const prefix=[env('E:\\sr\\Poem')];
 assert.equal(historyKey(mappedBashAssistant(actual,prefix)),historyKey(expected));
 const result={role:'tool',tool_call_id:'verified',content:'failed',is_error:true};
 const delta=continuationDelta({request:{messages:prefix},history:prefix.map(m=>historyKey(m)),expected:historyKey(expected),pendingIds:new Set(['verified'])},{messages:[...prefix,actual,result]});
 assert.deepEqual(delta,[result]);assert.equal(JSON.parse(actual.tool_calls[0].function.arguments).command,'python promo/build.py');
});
test('执行后 cwd 不能证明调用前目录；结果 ID 不匹配仍拒绝',()=>{
 const {expected,actual}=fixture('timing');const prefix=[env('E:\\other')];
 const session={request:{messages:prefix},history:prefix.map(m=>historyKey(m)),expected:historyKey(expected),pendingIds:new Set(['timing'])};
 assert.equal(continuationDelta(session,{messages:[...prefix,actual,{role:'tool',tool_call_id:'timing',content:'ok'},env('E:\\sr\\Poem')]}),undefined);
 const correct=[env('E:\\sr\\Poem')];session.request={messages:correct};session.history=correct.map(m=>historyKey(m));
 assert.equal(continuationDelta(session,{messages:[...correct,actual,{role:'tool',tool_call_id:'different',content:'ok'}]}),undefined);
});
test('调用前带数值前缀的新目录优先于更早目录，不能沿用旧cwd误判等价',()=>{
 const {actual}=fixture('directory-prefix');
 const prefix=[env('E:\\sr\\Poem'),{role:'system',content:'<total_tokens>123 tokens left</total_tokens>\n\n# Environment update\n - Primary working directory: E:\\ (was E:\\sr\\Poem)\n\n<total_tokens>456 tokens left</total_tokens>'}];
 assert.strictEqual(mappedBashAssistant(actual,prefix),actual);
});
test('冻结恢复使用相同的受限映射，并保留错误工具结果',()=>{
 const {expected,actual}=fixture('recover');const prefix=[env('E:\\sr\\Poem')];
 const receipt={role:'tool',tool_call_id:'recover',content:'original error',is_error:true};
 const session={request:{messages:prefix},freezePreviousState:'waiting-tool',pendingControls:new Map(),pendingHttp:new Map(),history:prefix.map(m=>historyKey(m)),expected:historyKey(expected),pendingIds:new Set(['recover'])};
 assert.deepEqual(recoveryDelta(session,{messages:[...prefix,actual,receipt]}),[receipt]);
});
test('目录不符、缺少目录、出站不同、主体变化、shell展开均拒绝映射',()=>{
 for(const [id,original,returned,wire,prefix] of [
  ['wrong','cd /e/other && python promo/build.py','python promo/build.py',undefined,[env('E:\\sr\\Poem')]],
  ['missing','cd /e/sr/Poem && python promo/build.py','python promo/build.py',undefined,[]],
  ['wire','cd /e/sr/Poem && python promo/build.py','python promo/build.py','echo changed',[env('E:\\sr\\Poem')]],
  ['body','cd /e/sr/Poem && python promo/build.py','python other.py',undefined,[env('E:\\sr\\Poem')]],
  ['expand','cd /e/$(pwd) && python promo/build.py','python promo/build.py',undefined,[env('E:\\sr\\Poem')]],
 ]){const {actual}=fixture(id,original,returned,wire);assert.strictEqual(mappedBashAssistant(actual,prefix),actual);}
});

test('混合目录更新与进展提醒只提供调用前目录事实，原行为指令完整保留',()=>{
 const {expected,actual}=fixture('mixed','cd /e/mad_ilwm && python build.py','python build.py');
 const update={role:'system',content:'# Environment update\n - Primary working directory: E:\\mad_ilwm (was E:\\)\n\nThe user has not heard from you in a while. Keep them updated.\n\n<total_tokens>12345 tokens left</total_tokens>'};
 const prefix=[{role:'user',content:'build'},update],before=JSON.stringify(prefix);
 assert.equal(historyKey(mappedBashAssistant(actual,prefix)),historyKey(expected));
 assert.equal(callerRuntimeStatus(update),undefined);
 const compiled=compileContext({messages:prefix});
 assert.equal(compiled.metrics.instructionUpdates,1);
 assert(compiled.systemPrompt.includes('Keep them updated.'));
 assert.equal(JSON.stringify(prefix),before);
 assert.equal(JSON.parse(actual.tool_calls[0].function.arguments).command,'python build.py');
 const receipt={role:'tool',tool_call_id:'mixed',content:'ORIGINAL_RESULT'};
 const session={request:{messages:prefix},freezePreviousState:'waiting-tool',pendingControls:new Map(),pendingHttp:new Map(),history:prefix.map(m=>historyKey(m)),expected:historyKey(expected),pendingIds:new Set(['mixed'])};
 assert.deepEqual(recoveryDelta(session,{messages:[...prefix,actual,receipt]}),[receipt]);
});

test('混合消息仍只信任调用前 system 固定开头，冲突或不匹配的新目录不能沿用旧目录',()=>{
 const {actual}=fixture('mixed-negative');
 const mixed={...env('E:\\sr\\Poem'),content:env('E:\\sr\\Poem').content+'\nKeep them updated.'};
 for(const item of [{...mixed,role:'user'},{...mixed,role:'tool'},
  {...mixed,content:'quoted:\n'+mixed.content},
  {...mixed,content:mixed.content+'\n# Environment update\n - Primary working directory: E:\\other (was E:\\)\n'},
  {...mixed,content:mixed.content.replace('E:\\sr\\Poem','E:\\other')},
  {...mixed,content:mixed.content.replace('E:\\sr\\Poem','relative')},
 ])assert.strictEqual(mappedBashAssistant(actual,[item]),actual);
 assert.strictEqual(mappedBashAssistant(actual,[env('E:\\sr\\Poem'),{...mixed,content:mixed.content+'\n# Environment update\n'}]),actual);
});

// 深路径也须有调用前目录事实；缺少或错误的 cwd 不能靠三点字符串采样放行。
test('深层 cd 只在执行目录等价时映射，其他参数及未知调用仍拒绝',()=>{
 const cwd='E:/ps/output/4.6.54-delivery-v1/Resources/JSON/BakedConfig/Config/Level/Mission/8047115';
 const original='cd /e/'+cwd.slice(3)+' && python inspect.py';
 const {expected,actual}=fixture('deep-cd',original,'python inspect.py');
 const prefix=[env(cwd)];
 assert.equal(historyKey(mappedBashAssistant(actual,prefix)),historyKey(expected));
 assert.strictEqual(mappedBashAssistant(actual,[]),actual);
 assert.strictEqual(mappedBashAssistant(actual,[env('E:/other')]),actual);
 const changed=structuredClone(actual);changed.tool_calls[0].function.arguments=JSON.stringify({command:'python inspect.py',description:'changed'});
 assert.notEqual(historyKey(mappedBashAssistant(changed,prefix)),historyKey(expected));
 for(const command of ['cd /e/../other && python inspect.py','cd /e/$HOME && python inspect.py','cd /e/a; python inspect.py']){
  const sample=fixture(command,command,'python inspect.py');assert.strictEqual(mappedBashAssistant(sample.actual,prefix),sample.actual);
 }
 const unknown=structuredClone(actual);unknown.tool_calls[0].id='no-trace';assert.strictEqual(mappedBashAssistant(unknown,prefix),unknown);
});
