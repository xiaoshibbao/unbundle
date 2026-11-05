import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import{randomUUID,createHash}from'node:crypto';
import{NativeSessionStore}from'./native-session-store.mjs';import{historyKey}from'./session-history.mjs';import{toolCatalog,extendsToolCatalog}from'./tool-definition-update.mjs';
const tool=name=>({name,original:name,description:'same definition',inputSchema:{type:'object',properties:{path:{type:'string'}}}});
const digest=value=>createHash('sha256').update(value).digest('hex');
test('工具目录只允许严格新增，不接受删除、描述/schema/映射变化和重复名称',()=>{
 const original=[tool('Read')],current=[...original,tool('Monitor')];assert(extendsToolCatalog(toolCatalog(original),toolCatalog(current)));
 for(const changed of [original,[tool('Monitor')],[{...original[0],description:'changed'},tool('Monitor')],[{...original[0],inputSchema:{type:'string'}},tool('Monitor')],[{...original[0],original:'Write'},tool('Monitor')],[...original,...original]])assert.equal(extendsToolCatalog(toolCatalog(original),toolCatalog(changed)),false);
});
test('CLI 回收后新增工具仍恢复同一 UUID，持久索引与历史和配置校验保持生效',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-resume-')),config=path.join(home,'config'),id=randomUUID();
 try{
  await fs.mkdir(path.join(config,'projects','synthetic'),{recursive:true});await fs.writeFile(path.join(config,'projects','synthetic',id+'.jsonl'),'{}\n');
  const store=new NativeSessionStore(home,config);await store.ready;
  const user={role:'user',content:'old task'},answer={role:'assistant',content:'done'},next={role:'user',content:'continue'},oldHash=digest('old schema'),newHash=digest('new schema');
  const signatureFor=(cap,tools=newHash)=>digest('same-model|same-policy|medium|'+cap+'|'+tools),request={messages:[user,answer,next]};
  const row={id,signature:signatureFor(128000,oldHash),outputTokens:128000,toolSchemaHash:oldHash,toolCatalog:toolCatalog([tool('Read')]),history:[historyKey(user,{hashKey:store.key})],expected:historyKey(answer,{hashKey:store.key}),snapshot:await store.transcriptSnapshot(id),savedAt:Date.now()};
  store.records.set(id,row);await store.persist();const loaded=new NativeSessionStore(home,config);await loaded.ready;
  const options={consume:false,signatureFor,requestedOutputTokens:64000,keepNativeOutputBudget:true,requestedToolCatalog:toolCatalog([tool('Read'),tool('Monitor')])};
  const restored=await loaded.take(request,signatureFor(64000),true,undefined,options);assert.equal(restored.id,id);assert.equal(restored.outputTokens,128000);assert.equal(restored.toolCatalogExpanded,true);assert.deepEqual(restored.delta,[next]);assert(loaded.records.has(id));
  assert.equal(await loaded.take({...request,messages:[{...user,content:'fork'},answer,next]},signatureFor(64000),true,undefined,options),undefined);
  assert.equal(await loaded.take(request,signatureFor(64000),true,undefined,{...options,signatureFor:(cap,tools)=>digest('different-model|'+cap+'|'+tools)}),undefined);
  assert.equal(await loaded.take(request,signatureFor(64000),true,undefined,{...options,requestedToolCatalog:toolCatalog([{...tool('Read'),description:'changed'},tool('Monitor')])}),undefined);
  delete loaded.records.get(id).toolCatalog;assert.equal(await loaded.take(request,signatureFor(64000),true,undefined,options),undefined);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
