import { getTurns, activeTurn } from './thread-state.mjs';
import { userText } from './turn-timeline.mjs';

export function toolApprovalDetails(request, turnId, threadId) {
  const p = request.params, meta = p?._meta, schema = p?.requestedSchema;
  if ((request.method || request.type) !== 'mcpServer/elicitation/request' ||
      request.completed === true || p?.threadId !== threadId ||
      (p.turnId != null && p.turnId !== turnId) ||
      !['form','openai/form','openaiForm'].includes(p.mode) ||
      meta?.codex_approval_kind !== 'mcp_tool_call' ||
      typeof p.serverName !== 'string' || !p.serverName.trim() || p.serverName.length > 200 ||
      typeof p.message !== 'string' || !p.message.trim() || p.message.length > 8000 ||
      !(schema === null || (schema?.type === 'object' && schema.properties &&
        !Array.isArray(schema.properties) && typeof schema.properties === 'object' &&
        !Object.keys(schema.properties).length && !schema.required?.length))) return null;
  const tool = [meta.tool_title,meta.tool_name].find(value=>typeof value==='string'&&value.trim()&&value.length<=300);
  const fields = Array.isArray(meta.tool_params_display) ? meta.tool_params_display.map(row =>
    [row?.display_name || row?.name, row?.value]).filter(([name])=>typeof name==='string') : [];
  const argumentsText=fields.map(([name,value])=>name+' = '+JSON.stringify(value)).join('\n');
  if(argumentsText.length>12000)return null;
  return { serverName:p.serverName, tool:tool||'', reason:p.message, argumentsText };
}

// Some desktop permission/tool requests have no supported mobile response API.
// Notify without forwarding raw permission payloads or inventing approval choices.
export function pendingAttention(state, canApproveTool = false) {
  const active=activeTurn(state);if(!active)return [];
  const titles={
    'item/permissions/requestApproval':'Codex 需要电脑权限授权',
    'mcpServer/elicitation/request':'Codex 工具需要您确认',
    'item/tool/requestOptionPicker':'Codex 等待您完成选择',
  };
  return (state?.requests||[]).flatMap(request=>{
    const kind=request.method||request.type,title=titles[kind],params=request.params||{},id=request.id??request.requestId;
    if(canApproveTool&&toolApprovalDetails(request,active.turnId,state.id))return [];
    if(!title||request.completed===true||id===undefined||params.turnId&&params.turnId!==active.turnId)return [];
    if(params.itemId&&!(active.items||[]).some(item=>item.id===params.itemId))return [];
    return [{id,kind,turnId:active.turnId,title,message:'请在电脑 Codex 中查看并处理此请求。'}];
  });
}

export function pendingQuestions(state) {
  const turns = getTurns(state), answered = new Set();
  const active=activeTurn(state);
  if(!active)return [];
  const completed=new Set((active.items||[]).filter(item=>item.type==='userInputResponse'&&item.completed===true).map(item=>String(item.requestId)));
  for (const turn of turns) for (const item of turn.items || []) {
    if (!['userMessage', 'steeringUserMessage'].includes(item.type)) continue;
    if (item.type === 'steeringUserMessage' && item.status && item.status !== 'accepted') continue;
    const text = userText(item.content || item.input).trim();
    if (!text.startsWith('<send_user_message_question_reply>') || !text.endsWith('</send_user_message_question_reply>')) continue;
    try {
      const parsed = JSON.parse(text.slice(34, -35));
      for (const reply of Array.isArray(parsed) ? parsed : [parsed]) answered.add(reply.questionItemId);
    } catch { /* Malformed user text is never treated as a response. */ }
  }
  const rows = (state?.requests || []).filter(r => r.completed!==true && /requestUserInput/.test(r.type || r.method || '')
    && (!r.params?.turnId||r.params.turnId===active.turnId) && !completed.has(String(r.id??r.requestId))).map(r => ({
    id: r.id ?? r.requestId, kind: 'native', turnId: r.params?.turnId,
    questions: (r.params?.questions || []).map(q => ({ id: q.id, title: q.question, header: q.header,
      isOther: !!q.isOther, isSecret: !!q.isSecret, options: (q.options || []).map(o => ({ label: o.label, description: o.description || '' })) }))
  }));
  for (const turn of [active]) for (const item of turn.items || []) {
    if (item.type !== 'agentMessage') continue;
    const questions = (item.questions || []).map((q, i) => ({ id: JSON.stringify(['request_user_input_async', item.id, i]),
      title: q.title, isOther: true, options: (q.options || []).map(label => ({ label, description: '' })) })).filter(q => !answered.has(q.id));
    if (questions.length) rows.push({ id: item.id, kind: 'async', turnId: turn.turnId, questions });
  }
  return rows.filter(r => r.questions.length);
}

export function validateAnswers(request, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== request.questions.length) throw Error('请回答全部问题');
  for (const q of request.questions) {
    const values = answers[q.id]?.answers;
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string' || !values[0].trim() || values[0].length > 16000) throw Error('回答不能为空或过长');
    if (q.options.length && !q.isOther && !q.options.some(o => o.label === values[0])) throw Error('回答不在可选项中');
  }
  return Object.fromEntries(request.questions.map(q => [q.id, { answers: [...answers[q.id].answers] }]));
}
