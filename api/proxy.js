// 같은 도메인 서버리스 프록시 — 무료 공개 CORS 프록시(corsproxy.io 등)가 전부 차단/사망하여
// 브라우저에서 네이버·야후 시세를 못 가져오던 문제 해결. 서버사이드 fetch라 CORS 없음.
const ALLOW = [
  'finance.naver.com', 'm.stock.naver.com', 'polling.finance.naver.com',
  'fchart.stock.naver.com', 'api.stock.naver.com',
  'query1.finance.yahoo.com', 'query2.finance.yahoo.com',
];

export default async function handler(req, res) {
  const target = req.query.url;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (!target) return res.status(400).json({ error: 'url param required' });

  let host;
  try { host = new URL(target).hostname; }
  catch { return res.status(400).json({ error: 'invalid url' }); }
  if (!ALLOW.some(h => host === h || host.endsWith('.' + h)))
    return res.status(403).json({ error: 'host not allowed: ' + host });

  try {
    const r = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        'Referer': host.includes('naver') ? 'https://m.stock.naver.com/' : 'https://finance.yahoo.com/',
        'Accept': 'application/json, text/plain, */*',
      },
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.text();
    const ct = r.headers.get('content-type') || 'text/plain; charset=utf-8';
    res.setHeader('Content-Type', ct);
    return res.status(r.status).send(body);
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
