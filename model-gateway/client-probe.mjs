// 已观察到的 Desktop 启动检测：Haiku、单条句点、1 token、无工具。
// 使用真实 CLI 校验可用性，但不进入或挤占用户会话池。
export function clientProbe(request,outputTokens,affinity){
 const messages=request.messages.filter(m=>!['system','developer'].includes(m.role));
 return !affinity&&request.model==='claude-haiku-5-5'&&outputTokens===1&&!request.tools?.length
  &&messages.length===1&&messages[0].role==='user'&&messages[0].content==='.'
  &&Object.keys(messages[0]).every(k=>['role','content'].includes(k));
}
