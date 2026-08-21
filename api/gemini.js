// AI 프록시 — 키를 서버에 숨김.
//  · Gemini: 하이브리드(사용자 키 우선, 없으면 서버 GEMINI_API_KEY)
//  · 우회로: Gemini가 429(무료 한도 초과)면 Claude(Claude_API)로 자동 폴백
// 환경변수: GEMINI_API_KEY, Claude_API (Vercel → Environment Variables)

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const CLAUDE_MODEL = 'claude-sonnet-5';
// effort: 이 앱은 "도구 하나 고르고 한국어 한두 문장" 수준 — medium이면 충분하고 토큰·지연이 줄어든다.
const CLAUDE_EFFORT = 'medium';
const GEMINI_TIMEOUT_MS = 25000;
const CLAUDE_TIMEOUT_MS = 60000;

// 상류가 응답을 안 주면 함수가 최대 실행시간(300s)까지 매달린다 — 항상 타임아웃을 건다.
async function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

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
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    output_config: { effort: CLAUDE_EFFORT },
    messages,
  };
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
  // 안전 분류기가 거절하면 200 + stop_reason:'refusal' 로 내려오고 content가 비어 있다 —
  // 그대로 두면 클라이언트가 "완료했습니다"로 오인하므로 사유를 문장으로 만들어준다.
  if (cl.stop_reason === 'refusal' && !parts.length) {
    parts.push({ text: '이 요청은 답변할 수 없습니다' + (cl.stop_details?.explanation ? ` (${cl.stop_details.explanation})` : '') + '.' });
  }
  if (!parts.length) parts.push({ text: '응답을 생성하지 못했습니다. 다시 시도해 주세요.' });
  return { candidates: [{ content: { parts }, finishReason: cl.stop_reason === 'tool_use' ? 'TOOL_USE' : 'STOP' }] };
}

// 성공 시 Gemini 형식 응답, 실패 시 {__error: '사유'} — 호출부가 원인을 사용자에게 전달할 수 있게 한다.
async function callClaude(payload) {
  const key = claudeKey();
  if (!key) return { __error: 'Claude 키(Claude_API)가 설정되지 않았습니다.' };
  let cr;
  try {
    cr = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(geminiToClaude(payload)),
    }, CLAUDE_TIMEOUT_MS);
  } catch (e) {
    return { __error: e.name === 'AbortError' ? 'Claude 응답 시간 초과' : 'Claude 연결 실패: ' + e.message };
  }
  if (!cr.ok) {
    const t = await cr.text().catch(() => '');
    let detail = '';
    try { detail = JSON.parse(t)?.error?.message || ''; } catch (_) { detail = t.slice(0, 200); }
    return { __error: `Claude 오류 (HTTP ${cr.status})${detail ? ': ' + detail : ''}` };
  }
  const cj = await cr.json();
  return claudeToGemini(cj);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: { message: 'POST only' } }); return; }
  try {
    const { action, model, payload } = req.body || {};
    const key = geminiKey();

    if (action === 'list') {
      if (!key) { res.status(400).json({ error: { message: 'AI 키가 설정되지 않았습니다.', status: 'NO_KEY' } }); return; }
      const g = await fetchWithTimeout(`${GEMINI_BASE}/models?key=${encodeURIComponent(key)}`, {}, GEMINI_TIMEOUT_MS);
      const text = await g.text();
      res.status(g.status); res.setHeader('content-type', 'application/json'); res.send(text); return;
    }

    if (action === 'generate') {
      if (!model) { res.status(400).json({ error: { message: 'model 파라미터가 필요합니다' } }); return; }
      // 1) Gemini 시도 (키가 있으면)
      let g = null, gNetErr = '';
      if (key) {
        try {
          g = await fetchWithTimeout(`${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
          }, GEMINI_TIMEOUT_MS);
        } catch (e) {
          // 타임아웃·연결 실패도 폴백 대상 — g는 null로 남는다.
          gNetErr = e.name === 'AbortError' ? 'Gemini 응답 시간 초과' : 'Gemini 연결 실패: ' + e.message;
        }
        if (g && g.ok) { const text = await g.text(); res.status(200); res.setHeader('content-type', 'application/json'); res.setHeader('x-ai-provider', 'gemini'); res.send(text); return; }
      }
      // 2) Gemini 실패(키 없음·429 한도초과·404 퇴역모델·403·5xx·타임아웃) → Claude 폴백
      //    사유를 가리지 않고 폴백한다(할당량 소진 시 모델 404로도 떨어지므로).
      const claudeRes = await callClaude(payload || {});
      if (claudeRes && !claudeRes.__error) {
        res.status(200); res.setHeader('content-type', 'application/json'); res.setHeader('x-ai-provider', 'claude'); res.send(JSON.stringify(claudeRes)); return;
      }
      // 3) 둘 다 실패 → 양쪽 사유를 함께 알린다(한쪽만 보이면 원인을 못 찾는다).
      let geminiWhy = gNetErr;
      let status = 502;
      if (g) {
        status = g.status;
        const t = await g.text().catch(() => '');
        try { geminiWhy = JSON.parse(t)?.error?.message || `Gemini HTTP ${g.status}`; } catch (_) { geminiWhy = `Gemini HTTP ${g.status}`; }
      } else if (!key) { geminiWhy = 'Gemini 키가 설정되지 않았습니다.'; }
      res.status(status).json({ error: { message: `${geminiWhy} / 폴백도 실패 — ${claudeRes?.__error || 'Claude 응답 없음'}`, status: 'ALL_PROVIDERS_FAILED' } });
      return;
    }

    res.status(400).json({ error: { message: 'unknown action' } });
  } catch (e) {
    res.status(500).json({ error: { message: '프록시 오류: ' + e.message } });
  }
}
