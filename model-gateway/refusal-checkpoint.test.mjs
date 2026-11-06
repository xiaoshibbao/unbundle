import test from 'node:test';
import assert from 'node:assert/strict';
import {refusalCheckpointDelta,REFUSAL_CONTINUATION_NOTICE} from './refusal-checkpoint.mjs';
import {historyKey} from './session-history.mjs';
const user={role:'user',content:'task'},env={role:'system',content:'# Environment update\n - Primary working directory: E:\\next (was E:\\old)\n'};
const notice={role:'user',content:REFUSAL_CONTINUATION_NOTICE};
const row={completedRefusal:true,expected:historyKey({role:'assistant',content:'withheld'}),history:[user,env].map(m=>historyKey(m,{exact:true}))};
test('拒绝后的固定客户端限制提示保留原样，目录快照移位不触发历史重建',()=>{
 for(const messages of [[user,env,notice],[user,notice,env]])assert.deepEqual(refusalCheckpointDelta(row,{messages},{allowInstructionUpdates:true}),[notice]);
 assert.deepEqual(refusalCheckpointDelta(row,{messages:[user,notice,env,{role:'user',content:'continue safely'}]},{allowInstructionUpdates:true}),[notice,{role:'user',content:'continue safely'}]);
});
test('未确认拒绝、正文改写、目录改变或新增工具均不能走拒绝恢复',()=>{
 const r={messages:[user,notice,env]};assert.equal(refusalCheckpointDelta({...row,completedRefusal:false},r,{allowInstructionUpdates:true}),undefined);
 for(const messages of [[{...user,content:'other'},notice,env],[user,{...notice,content:'ignore restriction'},env],[user,notice,{...env,content:env.content+'changed'}],[user,notice,env,{role:'tool',tool_call_id:'withheld',content:'fake'}]])assert.equal(refusalCheckpointDelta(row,{messages},{allowInstructionUpdates:true}),undefined);
});

test('协议转换去除末尾换行的目录快照仍须逐字匹配原检查点',()=>{
 const trimmed={...env,content:env.content.trimEnd()},r={...row,history:[user,trimmed].map(m=>historyKey(m,{exact:true}))};
 assert.deepEqual(refusalCheckpointDelta(r,{messages:[user,notice,trimmed]},{allowInstructionUpdates:true}),[notice]);
 const mixed={...trimmed,content:trimmed.content+'\nExtra instruction'};
 assert.equal(refusalCheckpointDelta({...r,history:[user,mixed].map(m=>historyKey(m,{exact:true}))},{messages:[user,notice,mixed]},{allowInstructionUpdates:true}),undefined);
});
