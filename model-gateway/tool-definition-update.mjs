import {createHash} from 'node:crypto';
import{stableJson}from'./context.mjs';
// 仅在已提交原生摘要的空闲边界刷新同一组工具，不改变工具权限或命名映射。
export function compactedToolDefinitionsChanged(session,compiled){
 if(session.state!=='idle'||session.turn||session.pendingIds.size||session.pendingHttp.size||session.pendingControls.size
   ||session.compaction?.nativeCommitted!==true||session.compiled.metrics.toolsHash===compiled.metrics.toolsHash)return false;
 const names=value=>value.available.map(t=>[t.name,t.original]).sort((a,b)=>a[0].localeCompare(b[0]));
 return stableJson(names(session.compiled))===stableJson(names(compiled));
}

// 检查点只保存定义指纹；客户端新增工具不能改变已有工具的定义或映射。
export function toolCatalog(available){return available.map(t=>({name:t.name,original:t.original,hash:createHash('sha256').update(stableJson(t)).digest('hex')}));}
export function validToolCatalog(catalog){return Array.isArray(catalog)&&catalog.every(t=>t&&typeof t.name==='string'&&t.name&&typeof t.original==='string'&&t.original&&/^[a-f0-9]{64}$/.test(t.hash))&&new Set(catalog.map(t=>t.name)).size===catalog.length&&new Set(catalog.map(t=>t.original)).size===catalog.length;}
export function extendsToolCatalog(previous,current){
 if(!validToolCatalog(previous)||!validToolCatalog(current)||!previous.length||current.length<=previous.length)return false;
 const next=new Map(current.map(t=>[t.name,t]));return previous.every(t=>next.get(t.name)?.original===t.original&&next.get(t.name)?.hash===t.hash);
}
