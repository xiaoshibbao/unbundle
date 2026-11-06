import {historyKey,sessionHistory,assistantHistoryMatches} from './session-history.mjs';
import {compactMemoryAliases,compactMemoryContext,splitCompactMemory} from './compact-memory-alias.mjs';

export const SUMMARY_SYSTEM='You are a helpful AI assistant tasked with summarizing conversations.';
const CLI_IDENTIFIERS=["You are Claude Code, Anthropic's official CLI for Claude.","You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.","You are a Claude agent, built on Anthropic's Claude Agent SDK."];
export function summarySystem(value){
 if(typeof value!=='string')return false;
 const lines=value.trim().split(/\r?\n/).filter(line=>line.trim());
 return lines.length===1&&lines[0]===SUMMARY_SYSTEM||lines.length===2&&CLI_IDENTIFIERS.includes(lines[0])&&lines[1]===SUMMARY_SYSTEM;
}
export const SUMMARY_HEADER='This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.';
// 只去掉官方已观察到的工具名元数据，不接受任意 system-reminder 正文。
export function stripSummaryTools(value){
 return value.replace(/^<system-reminder>\n<tools-used-before-summary>[A-Za-z0-9_, .:-]*<\/tools-used-before-summary>\n<\/system-reminder>\n/,'')
  .replace(/^<(tools-used(?:-before-summary)?)>[A-Za-z0-9_, .:-]*<\/\1>\n/,'')
  .replace(/^Tools called before this summary: [A-Za-z0-9_, .:-]*\n/,'');
}
const conversation=messages=>sessionHistory(messages).filter(m=>!['system','developer'].includes(m.role));
const leading=messages=>messages.slice(0,messages.findIndex(m=>!['system','developer'].includes(m.role))<0?messages.length:messages.findIndex(m=>!['system','developer'].includes(m.role)));
const text=m=>typeof m?.content==='string'?m.content:Array.isArray(m?.content)&&m.content.every(b=>b.type==='text')?m.content.map(b=>b.text).join('\n'):undefined;

// 摘要身份只用于选择已核验的会话，不能授权导入历史或跳过工具交接。
export function compactionIntent(request) {
 const systems=request.messages.filter(m=>m.role==='system');
 const summaryIndex=systems.findIndex(m=>summarySystem(m.content));
 if(systems.filter(m=>summarySystem(m.content)).length>1)return;
 if(request.tool_choice&&request.tool_choice!=='none'&&request.tool_choice!=='auto')return;
 const messages=conversation(request.messages),prompt=messages.at(-1);let content=text(prompt),prefix;
 // CLI 手动压缩会与末条用户文本合并；分离固定摘要指令，原用户前缀仍参与历史匹配。
 if(typeof content==='string'&&!content.startsWith('CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n')&&!content.startsWith('Your task is to create a detailed summary of ')){
  const markers=['CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n','Your task is to create a detailed summary of '];
  const cuts=markers.map(marker=>content.indexOf('\n\n'+marker)).filter(at=>at>=0);
  if(cuts.length){const at=Math.min(...cuts);prefix={role:'user',content:content.slice(0,at)};content=content.slice(at+2);}
 }
 if(prompt?.role!=='user'||typeof content!=='string'
  ||!(content.startsWith('Your task is to create a detailed summary of ')||content.startsWith('CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n'))
  ||!/(?:^|\n)Your task is to create a detailed summary of (?:the conversation so far,|this conversation\.)/.test(content))return;
 return {messages:[...messages.slice(0,-1),...(prefix?[prefix]:[])],prompt:{...prompt,content},rules:summaryIndex>=0?systems.slice(0,summaryIndex):leading(request.messages),ordinary:summaryIndex<0};
}
export function compactionBoundary(session,request,{hashKey,onReject}={}) {
 const reject=reason=>{onReject?.(reason);return undefined;};
 const intent=compactionIntent(request);
 if(!intent||!['idle','waiting-tool'].includes(session.state)||!session.request||!session.lastAssistant)return reject('not_summary_boundary');
 if(session.request.model!==request.model)return reject('model_changed');
 // 摘要禁止调用工具；本轮工具声明不参与会话身份，历史仍按原工具 schema 校验。
 const initial=leading(session.request.messages);
 if(intent.rules.length>initial.length||intent.ordinary&&intent.rules.length!==initial.length)return reject('leading_instruction_count');
 if(intent.rules.some((m,i)=>historyKey(m,{hashKey,exact:true})!==historyKey(initial[i],{hashKey,exact:true})))return reject('leading_instructions_changed');
 const original=conversation(session.request.messages);
 const expected=[...original,session.lastAssistant],actual=intent.messages;
 const options={hashKey,toolSchemas:session.request.tools};
 const aliases=compactMemoryAliases(session.request.messages,options);let alias;
 const same=(m,i)=>actual[i]&&(historyKey(m,options)===historyKey(actual[i],options)
   ||i===expected.length-1&&assistantHistoryMatches(session,actual[i],options)
   ||(alias=aliases.find(a=>a.index===i&&a.hash===historyKey(actual[i],options))));
 let length=expected.length;
 if(actual.length<expected.length||!expected.every(same)){
  alias=undefined;
  // Desktop 压缩可复用最后一次 API 输入；原生 CLI 已完成的末条回复仍在原会话中。
  if(session.state==='idle'&&!session.pendingIds.size&&actual.length>=original.length&&original.every(same)
    &&actual.slice(original.length).every(m=>m.role==='user'))length=original.length;
  else {
   alias=undefined;
   // Desktop 可丢弃旧窗口头部。只接受以唯一真实工具批次开头、完整匹配至原生最新回复的尾部；不重放旧消息。
   const first=actual[0],calls=first?.tool_calls;
   if(session.state!=='idle'||session.pendingIds.size||first?.role!=='assistant'||!calls?.length
     ||new Set(calls.map(c=>c.id)).size!==calls.length)return reject('source_history_mismatch');
   const starts=expected.map((m,i)=>i>0&&historyKey(m,options)===historyKey(first,options)?i:-1).filter(i=>i>=0);
   if(starts.length!==1)return reject('source_history_mismatch');
   const start=starts[0],count=expected.length-start;
   if(count<=calls.length||actual.length<count||!expected.slice(start).every((m,i)=>historyKey(m,options)===historyKey(actual[i],options))
     ||calls.some((c,i)=>actual[i+1]?.role!=='tool'||actual[i+1].tool_call_id!==c.id)
     ||actual.slice(count).some(m=>m.role!=='user'))return reject('source_history_mismatch');
   length=count;
  }
 }
 const appended=actual.slice(length),receipts=appended.filter(m=>m.role==='tool'),additionalUsers=appended.filter(m=>m.role==='user');
 if(alias){const context=compactMemoryContext(actual[alias.index]);if(!context)return reject('memory_alias_invalid');additionalUsers.push(context);}
 const ids=new Set(receipts.map(m=>m.tool_call_id));
 if(appended.some(m=>!['tool','user'].includes(m.role))||additionalUsers.some(m=>text(m)===undefined))return reject('unexpected_summary_append');
 if(receipts.length!==session.pendingIds.size||ids.size!==receipts.length
  ||receipts.some(m=>m.role!=='tool'||!session.pendingIds.has(m.tool_call_id)))return reject('tool_receipt_boundary');
 return {prompt:intent.prompt,receipts,...(additionalUsers.length?{additionalUsers}:{} )};
}
// 与已核对的官方 CLI 摘要清洗规则相同，只用于计算往返身份。
export function desktopSummary(value) {
 return value.replace(/<analysis>[\s\S]*?<\/analysis>/,'').replace(/<summary>([\s\S]*?)<\/summary>/,(_,body)=>`Summary:\n${body.trim()}`).replace(/\n\n+/g,'\n\n').trim();
}
// 仅登记已进入真实压缩源的工具批次；索引保存 HMAC，不保存工具输出正文。
export function retainedToolPairs(messages,options={}){
 const source=conversation(messages),pairs=[];
 for(let i=0;i<source.length;i++){
  const a=source[i],calls=a.tool_calls;if(a.role!=='assistant'||!calls?.length||calls.length>32)continue;
  const tools=source.slice(i+1,i+1+calls.length);
  if(tools.length!==calls.length||new Set(calls.map(c=>c.id)).size!==calls.length||tools.some((m,j)=>m.role!=='tool'||m.tool_call_id!==calls[j].id||typeof m.content!=='string'))continue;
  pairs.push({assistant:historyKey(a,options),tools:tools.map(m=>({id:m.tool_call_id,hash:historyKey({...m,content:m.content.trim()},options)}))});
 }
 return pairs.slice(-32);
}
function retainedReceipt(message,options){
 if(message?.role!=='tool'||typeof message.content!=='string')return;
 let content=message.content,memory;
 const at=content.lastIndexOf('\n\n<system-reminder>\nCodebase and user instructions are shown below.');
 if(at>=0){
  const extra=content.slice(at+2),parsed=splitCompactMemory(extra+'\n\n'+SUMMARY_HEADER+'\n\nx',SUMMARY_HEADER);
  if(!parsed?.memory)return;memory=parsed.memory;content=content.slice(0,at);
 }
 return{hash:historyKey({...message,content:content.trim()},options),memory};
}
export function compactionRecord(session,request,result,{hashKey,sourceAssistantHash}={}) {
 if(typeof result.content!=='string'||!result.content.trim()||result.tool_calls?.length)return;
 const payload=desktopSummary(result.content);if(!payload)return;
 const options={hashKey,toolSchemas:session.request.tools};
 const source=conversation(request.messages).slice(0,-1).map(m=>historyKey(m,options));
 if(sourceAssistantHash&&source.at(-1)!==sourceAssistantHash)source.push(sourceAssistantHash);
 return {retainedToolPairs:retainedToolPairs(request.messages.slice(0,-1),options),version:1,nativeCommitted:Boolean(session.nativeCompactionCommit?.boundaryUuid),nativeBoundaryUuid:session.nativeCompactionCommit?.boundaryUuid,summaryHash:historyKey({role:'user',content:payload},{hashKey,exact:true}),summaryLength:payload.length,
  source,...(sourceAssistantHash?{sourceAssistantHash}:{}),
  systems:leading(session.request.messages).map(m=>historyKey(m,{hashKey,exact:true}))};
}
export function compactedDelta(session,request,{hashKey,allowInstructionUpdates=false}={}) {
 const record=session.compaction;
 if(!record||record.version!==1||!Number.isSafeInteger(record.summaryLength)||record.summaryLength<1
  ||!Array.isArray(record.source)||!Array.isArray(record.systems)||session.pendingIds?.size)return;
 const systems=leading(request.messages);
 if(systems.length!==record.systems.length)return;
 const changedSystems=systems.filter((m,i)=>historyKey(m,{hashKey,exact:true})!==record.systems[i]);
 // 原生摘要与保留消息全部核验后，真实新指令经既有 MCP 控制通道确认；不开启候选仍严格拒绝。
 if(changedSystems.length&&!(allowInstructionUpdates&&record.nativeCommitted))return;
 const messages=conversation(request.messages),wrapper=messages[0],split=splitCompactMemory(text(wrapper),SUMMARY_HEADER),content=split?.summary;
 if(wrapper?.role!=='user'||!content?.startsWith(SUMMARY_HEADER+'\n\n'))return;
 let start=SUMMARY_HEADER.length+2;
 start=content.length-stripSummaryTools(content.slice(start)).length;
 const candidate=content.slice(start,start+record.summaryLength);
 if(candidate.length!==record.summaryLength||historyKey({role:'user',content:candidate},{hashKey,exact:true})!==record.summaryHash)return;
 if(content.length>start+record.summaryLength&&!/^\s/.test(content.slice(start+record.summaryLength)))return;
 const remaining=messages.slice(1),options={hashKey,toolSchemas:request.tools};let retained=0;
 for(let n=Math.min(record.source.length,remaining.length);n>0;n--){
  if(record.source.slice(-n).every((h,i)=>h===historyKey(remaining[i],options))){retained=n;break;}
 }
 const retainedMemory=[];
 // Desktop 保留窗口可落在摘要源中间，且会 trim 旧结果、重附自动记忆。
 // 只消化已登记、同 ID 同顺序同正文的完整批次，记忆单独交给原生 CLI。
 while(retained<remaining.length){
  const assistant=remaining[retained],hash=historyKey(assistant,options),pair=(record.retainedToolPairs||[]).find(p=>p.assistant===hash);
  if(!pair)break;
  const receipts=remaining.slice(retained+1,retained+1+pair.tools.length),parsed=receipts.map(m=>retainedReceipt(m,options));
  if(receipts.length!==pair.tools.length||receipts.some((m,i)=>m.tool_call_id!==pair.tools[i].id||parsed[i]?.hash!==pair.tools[i].hash))break;
  for(const r of parsed)if(r.memory)retainedMemory.push({role:'user',content:'Caller auto-memory snapshot attached to a retained completed tool result during compaction (caller context):\n'+r.memory});
  retained+=pair.tools.length+1;
 }
 const fresh=remaining.slice(retained);
 if(fresh.some(m=>m.role!=='user'))return;
 // 摘要包装自身的继续要求仍作为真实用户输入交给 CLI；旧工具和保留尾部不重放。
 const suffix=content.slice(start+record.summaryLength).trim();
 const head=record.nativeCommitted?(suffix?[{role:'user',content:'Caller continuation metadata after compaction:\n'+suffix}]:[]):[wrapper];
 const memory=split.memory?[{role:'user',content:'Caller auto-memory snapshot supplied with the compacted conversation (caller context):\n'+split.memory}]:[];
 const delta=[...changedSystems,...memory,...head,...retainedMemory,...fresh,...request.messages.filter(m=>['system','developer'].includes(m.role)&&!systems.includes(m))];
 return delta.length?delta:record.nativeCommitted?[{role:'user',content:'Continue the current task from the preserved native context.'}]:[wrapper];
}
