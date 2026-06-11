// Gemini API 프록시 — 키를 서버에 숨김 (하이브리드: 사용자 키 우선, 없으면 서버 환경변수)
// 환경변수: GEMINI_API_KEY (Vercel Project Settings → Environment Variables)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'POST only' } });
    return;
  }
  try {
    const { action, model, payload, userKey } = req.body || {};
    // 하이브리드: 사용자가 자기 키를 넣었으면 그걸 우선, 없으면 서버 공용 키
    const key = (userKey && String(userKey).trim()) || process.env.GEMINI_API_KEY;
    if (!key) {
      res.status(400).json({ error: {
        message: 'AI 키가 설정되지 않았습니다. 설정에서 개인 Gemini 키를 등록하거나 관리자에게 문의하세요.',
        status: 'NO_KEY'
      } });
      return;
    }

    const base = 'https://generativelanguage.googleapis.com/v1beta';
    let url, opts;
    if (action === 'list') {
      url = `${base}/models?key=${encodeURIComponent(key)}`;
      opts = { method: 'GET' };
    } else if (action === 'generate') {
      if (!model) { res.status(400).json({ error: { message: 'model 파라미터가 필요합니다' } }); return; }
      url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) };
    } else {
      res.status(400).json({ error: { message: 'unknown action' } });
      return;
    }

    // Google 응답의 상태코드·본문을 그대로 통과시켜 기존 에러 파싱과 호환
    const g = await fetch(url, opts);
    const text = await g.text();
    res.status(g.status);
    res.setHeader('content-type', 'application/json');
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: { message: '프록시 오류: ' + e.message } });
  }
}
