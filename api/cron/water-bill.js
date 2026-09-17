// 매월 10일 상수도 고지서 자동 처리 — Vercel Cron 이 부른다 (vercel.json: 10일 01:00 UTC = 10:00 KST).
//
// 1. 에너지 정보에서 상하수도 고객번호(10자리)를 모두 읽는다
// 2. 이번 달 고지서를 조회해 사용량입력(energy_records)에 넣는다
//    — 같은 시설·상하수도·월 기록이 이미 있으면 넣지 않고, 값이 다르면 "값 다름"으로 알린다
// 3. 전월·전년 같은 달과 30% 넘게 차이 나면 알린다
// 4. 고지서를 PDF 로 찍어 그 기록의 고지서로 보관하고, 한 통의 메일에 첨부해 보낸다
// 5. 처리 결과를 실행 기록으로 남긴다 (앱의 상수도 고지서 패널에서 본다)
//
// 당월 고지서는 9일 이후에 나오므로 10일에 돈다. 아직 안 나온 고객번호는 실패로 메일에 적는다.
//
// 손으로 돌리기 (CRON_SECRET 필요):
//   /api/cron/water-bill?month=2026-09          지정한 월로 실행
//   /api/cron/water-bill?month=2026-09&dry=1    기록·보관·메일·실행 기록 없이 조회와 PDF 만 확인
//   /api/cron/water-bill?month=2026-09&mail=0   메일만 보내지 않음
//
// 필요한 환경변수: CRON_SECRET, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY(메일)
// 선택: WATER_BILL_MAIL_TO(기본 g01093534568@gmail.com), WATER_BILL_MAIL_FROM

import {
  fetchBill, isWaterCustomerNo, seoulMonth, launchBrowser, renderPdf, pdfFileName,
  sendMail, BILL_MAIL_TO,
} from '../_lib/water-bill.js';
import { putObject, saveRun } from '../_lib/storage.js';
import { shiftMonth, usageAlerts, recordDiff } from '../../bill-rules.js';

const SB_URL = process.env.SUPABASE_URL || 'https://zbcnfixbkqtrjxvatvss.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TYPE = '상하수도';

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

const enc = encodeURIComponent;
const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 이 시설의 이번 달·전월·전년 같은 달 상하수도 기록
async function monthRecords(facility, month) {
  const months = [month, shiftMonth(month, -1), shiftMonth(month, -12)];
  const rows = await sb(`energy_records?select=id,billing_month,start_date,end_date,usage_amount,usage_cost`
    + `&facility_name=eq.${enc(facility)}&energy_type=in.(${enc(TYPE)},${enc(TYPE + '료')})&billing_month=in.(${months.join(',')})&order=id`);
  const pick = (m) => rows.find(r => r.billing_month === m);
  return { current: pick(months[0]), prev: pick(months[1]), lastYear: pick(months[2]) };
}

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SB_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY 가 없습니다' });

  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : seoulMonth();
  const dry = req.query.dry === '1';
  const mail = !dry && req.query.mail !== '0';

  const infos = await sb(`energy_info?select=facility_name,customer_number&energy_type=eq.${enc(TYPE)}`);
  const targets = infos.filter(i => isWaterCustomerNo(i.customer_number));

  const results = [];
  const attachments = [];
  let browser = null;
  try {
    for (const t of targets) {
      const row = { facility: t.facility_name, customer: t.customer_number.trim(), alerts: [], diff: [] };
      results.push(row);
      try {
        const r = await fetchBill(row.customer, month);
        if (!r.ok) { row.status = 'failed'; row.reason = r.reason; continue; }
        row.bill = r.bill;
        const bill = {
          energy_type: TYPE, billing_month: month, start_date: r.bill.startDate, end_date: r.bill.endDate,
          usage_amount: r.bill.usageAmount, usage_cost: r.bill.usageCost,
        };

        const { current, prev, lastYear } = await monthRecords(row.facility, month);
        row.alerts = usageAlerts(bill, { prev, lastYear });
        let recordId = current?.id ?? null;
        if (current) {
          row.diff = recordDiff(current, bill);
          row.status = row.diff.length ? 'mismatch' : 'exists';
        } else if (dry) {
          row.status = 'would-insert';
        } else {
          const [inserted] = await sb('energy_records', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              facility_name: row.facility, energy_type: TYPE, billing_month: month,
              start_date: bill.start_date, end_date: bill.end_date,
              usage_amount: bill.usage_amount, usage_cost: bill.usage_cost,
            }),
          });
          recordId = inserted.id;
          row.status = 'inserted';
        }
        row.recordId = recordId;

        browser ||= await launchBrowser();
        const pdf = await renderPdf(browser, r.printHtml);
        row.pdfBytes = pdf.length;
        attachments.push({ filename: pdfFileName(month, row.facility), content: pdf });
        // 값이 다른 기록에는 붙이지 않는다 — 사람이 확인하고 고칠 때 앱에서 올린다
        if (!dry && recordId && row.status !== 'mismatch') {
          try { await putObject(`records/${recordId}`, pdf, 'application/pdf'); row.stored = true; }
          catch (e) { row.storeError = String(e.message || e); }
        }
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
    const label = { inserted: '새로 입력', exists: '이미 있음', mismatch: '값 다름 — 확인 필요', failed: '실패' };
    const td = (v, right) => `<td style="padding:6px 10px;border:1px solid #ddd${right ? ';text-align:right' : ''}">${v}</td>`;
    const rows = results.map(r => {
      const notes = [...r.diff, ...r.alerts, r.reason].filter(Boolean).map(esc).join('<br>');
      return `<tr>${td(esc(r.facility))}${td(r.bill ? `${r.bill.startDate} ~ ${r.bill.endDate}` : '-')}`
        + `${td(r.bill ? `${r.bill.usageAmount.toLocaleString('ko-KR')}㎥` : '-', true)}${td(r.bill ? won(r.bill.usageCost) : '-', true)}`
        + `${td(`${label[r.status] || r.status}${notes ? `<br><small style="color:#b54708">${notes}</small>` : ''}`)}</tr>`;
    }).join('');
    const count = (s) => results.filter(r => r.status === s).length;
    const flags = [count('failed') && `실패 ${count('failed')}`, count('mismatch') && `값 다름 ${count('mismatch')}`,
      results.some(r => r.alerts.length) && '사용량 변동'].filter(Boolean);
    const th = (v) => `<th style="padding:6px 10px;border:1px solid #ddd">${v}</th>`;
    mailResult = await sendMail({
      to: BILL_MAIL_TO,
      subject: `[WorkLog] ${month} 상수도요금 고지서 ${attachments.length}건${flags.length ? ` (${flags.join(', ')})` : ''}`,
      html: `<p>${month} 울산 상수도요금 고지서를 조회해 WorkLog 에너지 사용량에 입력했습니다.</p>
<table style="border-collapse:collapse;font-size:14px">
<tr style="background:#f3f5f8">${th('시설')}${th('사용기간')}${th('사용량')}${th('고지금액')}${th('처리')}</tr>
${rows}
</table>
<p style="color:#888;font-size:12px">고지서 PDF 는 첨부했고, 입력한 기록에도 보관했습니다. 변동 표시는 전월·전년 같은 달보다 30% 넘게 달라진 항목입니다.
실패하거나 값이 다른 시설은 WorkLog 에너지관리 &gt; 사용량 입력에서 확인하세요.</p>`,
      attachments,
    });
  }

  const summary = { ok: true, month, dry, results, mail: mailResult };
  console.log('water-bill', month, JSON.stringify(results), JSON.stringify(mailResult));
  if (!dry) {
    try { await saveRun('water-bill', { month, results, mail: mailResult }); }
    catch (e) { console.error('water-bill run log', e); summary.runLogError = String(e.message || e); }
  }
  return res.status(200).json(summary);
}
