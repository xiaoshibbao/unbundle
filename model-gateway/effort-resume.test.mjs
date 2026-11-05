import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import{spawn}from'node:child_process';
import{sessionRelay}from'./session-relay.mjs';import{assistantMessage}from'./session-history.mjs';
const fake=`import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
const args=JSON.parse(process.argv[1]),value=n=>args[args.indexOf(n)+1],id=args.includes('--resume')?value('--resume'):value('--session-id'),effort=args.includes('--effort')?value('--effort'):'auto';
const folder=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','offline');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,id+'.jsonl');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
readline.createInterface({input:process.stdin}).on('line',line=>{const frame=JSON.parse(line);if(frame.type!=='user')throw Error('unexpected control');fs.appendFileSync(file,JSON.stringify({type:'user',message:frame.message})+'\\n');
const text=JSON.stringify({id,effort,input:JSON.stringify(frame.message)});console.log(JSON.stringify({type:'result',is_error:false,result:text}));});`;
const base={model:'claude-opus-5-5',max_tokens:1024,reasoning_effort:'medium',messages:[{role:'user',content:'FIRST'}]};
async function setup(){const home=await fs.mkdtemp(path.join(os.tmpdir(),'effort-resume-')),sessions=new Set();let spawns=0;const relay=sessionRelay({home,cli:'offline',modelFor:m=>m,maxOutputTokens:1024,persistentSessions:true,timeoutMs:3000,spawnProcess:(_cli,args,options)=>{spawns++;return spawn(process.execPath,['--input-type=module','-e',fake,JSON.stringify(args)],options);}},{sessions});return{relay,sessions,spawns:()=>spawns,async close(){await relay.close({discardFrozen:true});await fs.rm(home,{recursive:true,force:true});}};}
test('空闲切换 Medium/High 保存并恢复同一原生 UUID，只提交新消息且真实应用新档位',async()=>{
 const state=await setup();try{
  const first=await state.relay.infer(base),old=[...state.sessions][0],id=old.nativeSessionId;
  const secondRequest={...base,reasoning_effort:'high',messages:[...base.messages,assistantMessage(first),{role:'user',content:'SECOND'}]},second=await state.relay.infer(secondRequest),data=JSON.parse(second.content);
  assert.equal(data.id,id);assert.equal(data.effort,'high');assert(data.input.includes('SECOND'));assert(!data.input.includes('FIRST'));assert.equal(old.processAlive(),false);assert.equal(state.spawns(),2);
  const third=await state.relay.infer({...base,messages:[...secondRequest.messages,assistantMessage(second),{role:'user',content:'THIRD'}]}),last=JSON.parse(third.content);assert.equal(last.id,id);assert.equal(last.effort,'medium');assert(last.input.includes('THIRD'));assert(!last.input.includes('SECOND'));assert.equal(state.spawns(),3);
 }finally{await state.close();}
});
test('历史或模型有变化不能借档位切换关闭原 CLI 或恢复错误会话',async()=>{
 for(const change of ['history','model']){const state=await setup();try{const first=await state.relay.infer(base),original=[...state.sessions][0];
 const request={...base,reasoning_effort:'high',model:change==='model'?'claude-sonnet-5-5':base.model,messages:[change==='history'?{role:'user',content:'FORK'}:base.messages[0],assistantMessage(first),{role:'user',content:'SECOND'}]};
 await assert.rejects(state.relay.infer(request),{code:'NATIVE_RESUME_REQUIRED'});assert.equal(state.spawns(),1);assert(original.processAlive());
 }finally{await state.close();}}
});
