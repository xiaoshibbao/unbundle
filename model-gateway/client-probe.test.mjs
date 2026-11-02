import test from 'node:test';
import assert from 'node:assert/strict';
import {clientProbe} from './client-probe.mjs';
test('只隔离已观察到的无工具Haiku句点1token启动探测，其他会话不改变路由',()=>{
 const request={model:'claude-haiku-5-5',messages:[{role:'user',content:'.'}]};assert(clientProbe(request,1));
 for(const value of [{...request,model:'claude-opus-5-5'},{...request,tools:[{}]},
  {...request,messages:[{role:'user',content:'genuine task'}]},
  {...request,messages:[...request.messages,{role:'user',content:'.'}]}])assert(!clientProbe(value,1));
 assert(!clientProbe(request,2));assert(!clientProbe(request,1,{key:'sticky-conversation'}));
});
