// 상수도 고지서 조회 — 앱의 에너지관리 > 사용량입력 "상수도 고지서" 패널이 부른다.
//
//   GET /api/water-bill?customer=2015601258&month=2026-09            → 사용량·기간·금액 JSON
//   GET /api/water-bill?customer=2015601258&month=2026-09&format=pdf → 고지서 PDF
//
// 에너지 정보에 상하수도로 등록된 고객번호만 받는다. 상수도 사이트 자체는 공개 조회지만
// PDF 는 크롬을 띄우는 무거운 일이라 아무 번호로나 부르지 못하게 막아 둔다.
//
// 필요한 환경변수: SUPABASE_SERVICE_ROLE_KEY (energy_info 조회)

import { fetchBill, isWaterCustomerNo, launchBrowser, renderPdf, pdfFileName } from './_lib/water-bill.js';

const SB_URL = process.env.SUPABASE_URL || 'https://zbcnfixbkqtrjxvatvss.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function findFacility(customer) {
  const q = new URLSearchParams({
    select: 'facility_name',
    energy_type: 'eq.상하수도',
    customer_number: `eq.${customer}`,
    limit: '1',
  });
  const res = await fetch(`${SB_URL}/rest/v1/energy_info?${q}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0]?.facility_name || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET 만 받습니다' });
  if (!SB_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY 가 없습니다' });

  const customer = String(req.query.customer || '').trim();
  const month = String(req.query.month || '').trim();
  if (!isWaterCustomerNo(customer)) return res.status(400).json({ ok: false, error: '고객번호는 10자리 숫자여야 합니다' });
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ ok: false, error: '월은 YYYY-MM 형식이어야 합니다' });

  try {
    const facilityName = await findFacility(customer);
    if (!facilityName) return res.status(404).json({ ok: false, error: '에너지 정보에 상하수도로 등록된 고객번호가 아닙니다' });

    const r = await fetchBill(customer, month);
    if (!r.ok) return res.status(404).json({ ok: false, error: r.reason });

    if (req.query.format !== 'pdf') {
      return res.status(200).json({ ok: true, facilityName, bill: r.bill });
    }

    const browser = await launchBrowser();
    let pdf;
    try { pdf = await renderPdf(browser, r.printHtml); }
    finally { await browser.close(); }

    const name = pdfFileName(month, facilityName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="water-bill-${month}-${customer}.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`);
    return res.status(200).send(pdf);
  } catch (e) {
    console.error('water-bill', e);
    return res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
}
