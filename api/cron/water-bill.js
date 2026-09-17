// 매월 10일 상수도 고지서 자동 처리 — Vercel Cron 이 부른다 (vercel.json: 10일 01:00 UTC = 10:00 KST).
//
// 1. 에너지 정보에서 상하수도 고객번호(10자리)를 모두 읽는다
// 2. 이번 달 고지서를 조회해 사용량입력(energy_records)에 넣는다
//    — 같은 시설·상하수도·월 기록이 이미 있으면 건너뛴다 (손으로 먼저 넣었거나 다시 돌린 경우)
// 3. 고지서를 PDF 로 찍어 한 통의 메일에 첨부해 보낸다
//
// 당월 고지서는 9일 이후에 나오므로 10일에 돈다. 아직 안 나온 고객번호는 실패로 메일에 적는다.
//
// 손으로 돌리기 (CRON_SECRET 필요):
//   /api/cron/water-bill?month=2026-09          지정한 월로 실행
//   /api/cron/water-bill?month=2026-09&dry=1    기록·메일 없이 조회와 PDF 만 확인
//   /api/cron/water-bill?month=2026-09&mail=0   메일만 보내지 않음
//
// 필요한 환경변수: CRON_SECRET, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY(메일)
// 선택: WATER_BILL_MAIL_TO(기본 g01093534568@gmail.com), WATER_BILL_MAIL_FROM

import {
  fetchBill, isWaterCustomerNo, seoulMonth, launchBrowser, renderPdf, pdfFileName,
  sendMail, BILL_MAIL_TO,
} from '../_lib/water-bill.js';

const SB_URL = process.env.SUPABASE_URL || 'https://zbcnfixbkqtrjxvatvss.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sb(path, init = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SB_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY 가 없습니다' });

  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : seoulMonth();
  const dry = req.query.dry === '1';
  const mail = !dry && req.query.mail !== '0';

  const infos = await sb(`energy_info?select=facility_name,customer_number&energy_type=eq.${encodeURIComponent('상하수도')}`);
  const targets = infos.filter(i => isWaterCustomerNo(i.customer_number));

  const results = [];
  const attachments = [];
  let browser = null;
  try {
    for (const t of targets) {
      const row = { facility: t.facility_name, customer: t.customer_number.trim() };
      results.push(row);
      try {
        const r = await fetchBill(row.customer, month);
        if (!r.ok) { row.status = 'failed'; row.reason = r.reason; continue; }
        row.bill = r.bill;

        const existing = await sb(`energy_records?select=id&facility_name=eq.${encodeURIComponent(row.facility)}`
          + `&energy_type=eq.${encodeURIComponent('상하수도')}&billing_month=eq.${month}&limit=1`);
        if (existing.length) {
          row.status = 'exists';
        } else if (dry) {
          row.status = 'would-insert';
        } else {
          await sb('energy_records', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              facility_name: row.facility,
              energy_type: '상하수도',
              billing_month: month,
              start_date: r.bill.startDate,
              end_date: r.bill.endDate,
              usage_amount: r.bill.usageAmount,
              usage_cost: r.bill.usageCost,
            }),
          });
          row.status = 'inserted';
        }

        browser ||= await launchBrowser();
        const pdf = await renderPdf(browser, r.printHtml);
        row.pdfBytes = pdf.length;
        attachments.push({ filename: pdfFileName(month, row.facility), content: pdf });
      } catch (e) {
        row.status = 'failed';
        row.reason = String(e?.message || e);
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  let mailResult = { skipped: true };
  if (mail && targets.length) {
    const label = { inserted: '새로 입력', exists: '이미 있음', failed: '실패' };
    const rows = results.map(r => `<tr>
      <td style="padding:6px 10px;border:1px solid #ddd">${esc(r.facility)}</td>
      <td style="padding:6px 10px;border:1px solid #ddd">${r.bill ? `${r.bill.startDate} ~ ${r.bill.endDate}` : '-'}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;text-align:right">${r.bill ? `${r.bill.usageAmount.toLocaleString('ko-KR')}㎥` : '-'}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;text-align:right">${r.bill ? won(r.bill.usageCost) : '-'}</td>
      <td style="padding:6px 10px;border:1px solid #ddd">${label[r.status] || r.status}${r.reason ? `<br><small>${esc(r.reason)}</small>` : ''}</td>
    </tr>`).join('');
    const failed = results.filter(r => r.status === 'failed').length;
    mailResult = await sendMail({
      to: BILL_MAIL_TO,
      subject: `[WorkLog] ${month} 상수도요금 고지서 ${attachments.length}건${failed ? ` (실패 ${failed}건)` : ''}`,
      html: `<p>${month} 울산 상수도요금 고지서를 조회해 WorkLog 에너지 사용량에 입력했습니다.</p>
<table style="border-collapse:collapse;font-size:14px">
<tr style="background:#f3f5f8"><th style="padding:6px 10px;border:1px solid #ddd">시설</th><th style="padding:6px 10px;border:1px solid #ddd">사용기간</th><th style="padding:6px 10px;border:1px solid #ddd">사용량</th><th style="padding:6px 10px;border:1px solid #ddd">고지금액</th><th style="padding:6px 10px;border:1px solid #ddd">입력</th></tr>
${rows}
</table>
<p style="color:#888;font-size:12px">고지서 PDF 는 첨부파일로 붙였습니다. 실패한 시설은 WorkLog 에너지관리 &gt; 사용량 입력의 상수도 고지서 패널에서 다시 불러올 수 있습니다.</p>`,
      attachments,
    });
  }

  console.log('water-bill', month, JSON.stringify(results), JSON.stringify(mailResult));
  return res.status(200).json({ ok: true, month, dry, results, mail: mailResult });
}
