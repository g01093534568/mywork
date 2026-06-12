// AI 프록시 — 키를 서버에 숨김.
//  · Gemini: 하이브리드(사용자 키 우선, 없으면 서버 GEMINI_API_KEY)
//  · 우회로: Gemini가 429(무료 한도 초과)면 Claude(Claude_API)로 자동 폴백
// 환경변수: GEMINI_API_KEY, Claude_API (Vercel → Environment Variables)

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

function claudeKey() {
  return process.env.worklog_claude || process.env.worklogclaude || process.env.Claude_API || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '';
}
function geminiKey() {
  return process.env.GEMINI_API_KEY || process.env.google_api_Key || process.env.GOOGLE_API_KEY || '';
}

// Gemini 스키마(TYPE 대문자) → JSON Schema(소문자) 재귀 변환
function schemaG2C(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = schemaG2C(pv);
    } else if (k === 'items') out.items = schemaG2C(v);
    else out[k] = v;
  }
  return out;
}

// Gemini generate 요청 본문 → Claude Messages 요청 본문
function geminiToClaude(payload) {
  const system = (payload.system_instruction?.parts || [])
    .map(p => p.text).filter(Boolean).join('\n') || undefined;
  const tools = (payload.tools?.[0]?.functionDeclarations || []).map(fd => ({
    name: fd.name,
    description: fd.description || '',
    input_schema: schemaG2C(fd.parameters || { type: 'OBJECT', properties: {} }),
  }));
  const messages = [];
  let toolCounter = 0;
  let lastToolUseIds = [];
  for (const c of (payload.contents || [])) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const content = [];
    let idx = 0;
    for (const part of (c.parts || [])) {
      if (part.text != null) content.push({ type: 'text', text: part.text });
      else if (part.functionCall) {
        content.push({ type: 'tool_use', id: 'call_' + (toolCounter++), name: part.functionCall.name, input: part.functionCall.args || {} });
      } else if (part.functionResponse) {
        const id = lastToolUseIds[idx] || ('call_' + toolCounter);
        const r = part.functionResponse.response;
        const text = typeof r?.result === 'string' ? r.result : JSON.stringify(r);
        content.push({ type: 'tool_result', tool_use_id: id, content: text });
        idx++;
      }
    }
    if (role === 'assistant') lastToolUseIds = content.filter(b => b.type === 'tool_use').map(b => b.id);
    messages.push({ role, content });
  }
  const body = { model: CLAUDE_MODEL, max_tokens: 2048, messages };
  if (system) body.system = system;
  if (tools.length) body.tools = tools;
  return body;
}

// Claude 응답 → Gemini 응답 형식(클라이언트가 그대로 파싱 가능)
function claudeToGemini(cl) {
  const parts = [];
  for (const block of (cl.content || [])) {
    if (block.type === 'text') parts.push({ text: block.text });
    else if (block.type === 'tool_use') parts.push({ functionCall: { name: block.name, args: block.input || {} } });
  }
  return { candidates: [{ content: { parts }, finishReason: cl.stop_reason === 'tool_use' ? 'TOOL_USE' : 'STOP' }] };
}

async function callClaude(payload) {
  const key = claudeKey();
  if (!key) return null;
  const cr = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(geminiToClaude(payload)),
  });
  if (!cr.ok) return null;
  const cj = await cr.json();
  return claudeToGemini(cj);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: { message: 'POST only' } }); return; }
  try {
    const { action, model, payload } = req.body || {};
    const key = geminiKey();

    if (action === 'diag') {
      const gk = geminiKey();
      const out = {
        geminiKey: { present: !!gk, len: gk.length, head: gk.slice(0, 6), tail: gk.slice(-4) },
      };
      if (gk) {
        try {
          const gr = await fetch(`${GEMINI_BASE}/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(gk)}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
          });
          out.geminiStatus = gr.status;
          if (!gr.ok) { const j = await gr.json().catch(() => ({})); out.geminiError = j?.error?.message || j?.error?.status || 'unknown'; }
          else out.geminiOk = true;
        } catch (e) { out.geminiException = e.message; }
      }
      res.status(200).json(out); return;
    }

    if (action === 'list') {
      if (!key) { res.status(400).json({ error: { message: 'AI 키가 설정되지 않았습니다.', status: 'NO_KEY' } }); return; }
      const g = await fetch(`${GEMINI_BASE}/models?key=${encodeURIComponent(key)}`);
      const text = await g.text();
      res.status(g.status); res.setHeader('content-type', 'application/json'); res.send(text); return;
    }

    if (action === 'generate') {
      if (!model) { res.status(400).json({ error: { message: 'model 파라미터가 필요합니다' } }); return; }
      // 1) Gemini 시도 (키가 있으면)
      let g = null;
      if (key) {
        g = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
        });
        if (g.ok) { const text = await g.text(); res.status(200); res.setHeader('content-type', 'application/json'); res.setHeader('x-ai-provider', 'gemini'); res.send(text); return; }
      }
      // 2) Gemini 실패(키 없음·429 한도초과·404 퇴역모델·403·5xx 등) → Claude 폴백
      //    g.ok가 아니면 사유를 가리지 않고 폴백한다(할당량 소진 시 모델 404로도 떨어지므로).
      const geminiFailed = !key || (g && !g.ok);
      if (geminiFailed) {
        const claudeRes = await callClaude(payload || {});
        if (claudeRes) { res.status(200); res.setHeader('content-type', 'application/json'); res.setHeader('x-ai-provider', 'claude'); res.send(JSON.stringify(claudeRes)); return; }
      }
      // 3) 폴백 불가 → 원래 Gemini 응답(또는 키 없음 에러) 반환
      if (g) { const text = await g.text(); res.status(g.status); res.setHeader('content-type', 'application/json'); res.send(text); return; }
      res.status(400).json({ error: { message: 'AI 키가 설정되지 않았습니다.', status: 'NO_KEY' } }); return;
    }

    res.status(400).json({ error: { message: 'unknown action' } });
  } catch (e) {
    res.status(500).json({ error: { message: '프록시 오류: ' + e.message } });
  }
}
