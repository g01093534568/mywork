// 에너지 기록의 고지서 파일 보관·열람 — 저장 위치는 api/_lib/storage.js
//
//   GET  /api/bill-file?ids=1,2,3        → { has: [1,3] }  고지서가 보관된 기록
//   GET  /api/bill-file?id=5             → { url }         5분짜리 열람 링크
//   PUT  /api/bill-file?id=5  (파일 본문) → { ok }          고지서 올리기 (같은 기록이면 덮어씀)
//        헤더 X-File-Type: application/pdf | image/jpeg | image/png
//   GET  /api/bill-file?runs=water-bill  → { runs: [...] }  매월 10일 자동 처리 최근 기록

import { requireUser } from './_lib/auth.js';
import { storageEnabled, putObject, listNames, signedUrl, latestRuns } from './_lib/storage.js';

const SB_URL = process.env.SUPABASE_URL || 'https://zbcnfixbkqtrjxvatvss.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

async function recordExists(id) {
  const res = await fetch(`${SB_URL}/rest/v1/energy_records?select=id&id=eq.${id}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return (await res.json()).length > 0;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BYTES) throw Object.assign(new Error('파일이 15MB를 넘습니다'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storageEnabled()) return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY 가 없습니다' });
  if (!(await requireUser(req, res))) return;

  try {
    if (req.method === 'GET' && req.query.runs) {
      if (!/^[a-z-]+$/.test(req.query.runs)) return res.status(400).json({ ok: false, error: '잘못된 작업 이름' });
      return res.status(200).json({ ok: true, runs: await latestRuns(req.query.runs, 5) });
    }

    if (req.method === 'GET' && req.query.ids !== undefined) {
      const want = new Set(String(req.query.ids).split(',').filter(s => /^\d+$/.test(s)));
      const names = want.size ? await listNames('records') : [];
      return res.status(200).json({ ok: true, has: names.filter(n => want.has(n)).map(Number) });
    }

    const id = String(req.query.id || '');
    if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, error: '기록 번호(id)가 필요합니다' });

    if (req.method === 'GET') {
      const url = await signedUrl(`records/${id}`);
      if (!url) return res.status(404).json({ ok: false, error: '보관된 고지서가 없습니다' });
      return res.status(200).json({ ok: true, url });
    }

    if (req.method === 'PUT') {
      const type = String(req.headers['x-file-type'] || '');
      if (!TYPES.includes(type)) return res.status(400).json({ ok: false, error: 'PDF 또는 사진만 올릴 수 있습니다' });
      if (!(await recordExists(id))) return res.status(404).json({ ok: false, error: '없는 기록입니다' });
      const body = await readBody(req);
      if (!body.length) return res.status(400).json({ ok: false, error: '파일이 비어 있습니다' });
      await putObject(`records/${id}`, body, type);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: '지원하지 않는 요청' });
  } catch (e) {
    console.error('bill-file', e);
    return res.status(e.status || 502).json({ ok: false, error: String(e.message || e) });
  }
}
