// 울산광역시 상수도사업본부 요금 고지서 — 조회·파싱·PDF·메일
//
// 사이트(water.ulsan.go.kr)는 로그인이 없다. 요금조회 페이지를 GET 해서 세션 쿠키와
// CSRF 토큰을 받은 뒤, 같은 쿠키로 고객번호·월을 POST 하면 고지서가 담긴 HTML 이 온다.
// 사이트의 "인쇄하기"는 그 HTML 중 #homeCharge 영역을 사이트 CSS 와 함께 팝업에 띄울
// 뿐이라(jquery.PrintArea), 같은 조각을 헤드리스 크롬으로 PDF 로 찍으면 고지서와 똑같다.
//
// 주의: searchYM 은 반드시 'YYYY-MM' (하이픈 포함). '202609' 로 보내면 결과가 비어 온다.
// 주의: 당월 요금은 9일 이후에 나온다. 그 전에는 요청한 월이 아니라 전월 고지서를 돌려주므로
//       고지서 제목의 월이 요청한 월과 같은지 반드시 확인한다.

import fs from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://water.ulsan.go.kr';
const PAGE = `${SITE}/us/service/homeCharge.do`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export const isWaterCustomerNo = (s) => /^\d{10}$/.test(String(s || '').trim());

// 서울 기준 이번 달 'YYYY-MM' — 서버는 UTC 로 돈다
export function seoulMonth() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
}

// set-cookie 여러 개를 요청용 Cookie 헤더 한 줄로
function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return list.map(c => c.split(';')[0]).join('; ');
}

// <div id="homeCharge"> ... </div> 를 중첩 div 개수를 세어 통째로 잘라낸다
function sliceDiv(html, id) {
  const start = html.indexOf(`<div id="${id}"`);
  if (start < 0) return '';
  const re = /<div\b|<\/div>/gi;
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return '';
}

const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const num = (s) => Number(String(s || '').replace(/[^\d.-]/g, '')) || 0;

// 고지서 조각에서 WorkLog 사용량입력에 넣을 값을 뽑는다
export function parseBill(fragment) {
  const text = strip(fragment);
  const ym = text.match(/(\d{4})년\s*(\d{1,2})월/);
  const period = text.match(/사용기간\s*(\d{2})\.(\d{2})\.(\d{2})\s*~\s*(\d{2})\.(\d{2})\.(\d{2})/);
  const amount = text.match(/고지금액\s*([\d,]+)\s*원/);
  const cust = text.match(/고객번호\s*(\d{10})/);
  const due = text.match(/납부기한\s*(\d{4}-\d{2}-\d{2})/);

  // 사용내역 표: 당월지침, 전월지침, 사용량, 조정량, ... — 세 번째 칸이 사용량
  const tbody = fragment.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  const tds = tbody ? [...tbody[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => strip(m[1])) : [];

  if (!ym || !period || !amount) return null;
  return {
    billingMonth: `${ym[1]}-${ym[2].padStart(2, '0')}`,
    customerNumber: cust ? cust[1] : '',
    startDate: `20${period[1]}-${period[2]}-${period[3]}`,
    endDate: `20${period[4]}-${period[5]}-${period[6]}`,
    usageAmount: tds.length >= 3 ? num(tds[2]) : 0,
    usageCost: num(amount[1]),
    dueDate: due ? due[1] : '',
  };
}

// 고객번호·월로 고지서를 조회한다.
// 반환: { ok:true, bill, printHtml } 또는 { ok:false, reason }
export async function fetchBill(customerNumber, month) {
  const cust = String(customerNumber).trim();
  if (!isWaterCustomerNo(cust)) return { ok: false, reason: '고객번호는 10자리 숫자여야 합니다' };
  if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, reason: '월은 YYYY-MM 형식이어야 합니다' };

  const first = await fetch(PAGE, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!first.ok) return { ok: false, reason: `상수도 사이트 응답 ${first.status}` };
  const cookie = cookieHeader(first);
  const page = await first.text();
  const csrf = (page.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];
  if (!csrf) return { ok: false, reason: '상수도 사이트에서 CSRF 토큰을 찾지 못했습니다' };

  const res = await fetch(PAGE, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: PAGE,
      Cookie: cookie,
    },
    body: new URLSearchParams({ searchCnd: '2', searchMstNo: cust, searchYM: month, _csrf: csrf }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { ok: false, reason: `상수도 사이트 응답 ${res.status}` };
  const html = await res.text();

  const fragment = sliceDiv(html, 'homeCharge');
  if (!fragment) return { ok: false, reason: '조회 결과가 없습니다 (아직 고지서가 나오지 않았거나 고객번호가 틀림)' };
  const bill = parseBill(fragment);
  if (!bill) return { ok: false, reason: '고지서 내용을 읽지 못했습니다' };
  if (bill.billingMonth !== month) {
    return { ok: false, reason: `${month} 고지서가 아직 나오지 않았습니다 (사이트가 ${bill.billingMonth} 고지서를 돌려줌)` };
  }

  // 인쇄 팝업과 같은 문서: 사이트 CSS 를 그대로 걸고 #homeCharge 만 본문에 둔다
  const links = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/gi)].map(m => m[0]).join('\n');
  const printHtml = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<base href="${SITE}/">
${links}
<style>
  body { background:#fff; margin:0; padding:20px; font-family:'NanumGothic', sans-serif; }
  #homeCharge { max-width:980px; margin:0 auto; }
</style>
</head><body>${fragment}</body></html>`;

  return { ok: true, bill, printHtml };
}

// ── PDF ──────────────────────────────────────────────────────────────
// 서버리스 크롬(@sparticuz/chromium)에는 한글 글꼴이 없어 네모로 찍힌다.
// 저장소의 fonts/ 에 넣어 둔 나눔고딕을 크롬 글꼴 폴더로 넣어 준다.
// 로컬에서 시험할 때는 CHROME_PATH 에 설치된 크롬 경로를 주면 그걸 쓴다.

export async function launchBrowser() {
  const puppeteer = (await import('puppeteer-core')).default;
  if (process.env.CHROME_PATH) {
    return puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  }
  const chromium = (await import('@sparticuz/chromium')).default;
  // 이 크롬의 fontconfig 는 /tmp/fonts 를 읽는다 (chromium.font() 는 v14x 에서 없어졌다)
  const src = path.join(process.cwd(), 'fonts');
  await fs.mkdir('/tmp/fonts', { recursive: true });
  for (const f of ['NanumGothic-Regular.ttf', 'NanumGothic-Bold.ttf']) {
    await fs.copyFile(path.join(src, f), path.join('/tmp/fonts', f));
  }
  return puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
    defaultViewport: { width: 1024, height: 768 },
  });
}

export async function renderPdf(browser, printHtml) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1024, height: 768 });
    // 사이트 CSS·로고를 받아와야 하므로 네트워크가 잠잠해질 때까지 기다린다
    await page.setContent(printHtml, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

// 파일 이름: 상수도요금_2026-09_울주군립야영장(별빛).pdf
export function pdfFileName(month, facilityName) {
  const safe = String(facilityName || '').replace(/[\\/:*?"<>|]/g, '_');
  return `상수도요금_${month}_${safe}.pdf`;
}

// ── 메일 (Resend) ────────────────────────────────────────────────────
// RESEND_API_KEY 가 없으면 보내지 않고 이유를 돌려준다. 발신 주소는 도메인 인증 전에는
// Resend 기본 주소(onboarding@resend.dev)만 쓸 수 있고, 그때 받는 사람은 Resend 계정
// 주인 메일로 제한된다.

export const BILL_MAIL_TO = process.env.WATER_BILL_MAIL_TO || 'g01093534568@gmail.com';

export async function sendMail({ to, subject, html, attachments }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'RESEND_API_KEY 가 설정되지 않았습니다' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.WATER_BILL_MAIL_FROM || 'WorkLog <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
      attachments: attachments.map(a => ({ filename: a.filename, content: a.content.toString('base64') })),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: `Resend ${res.status}: ${body.message || JSON.stringify(body)}` };
  return { ok: true, id: body.id };
}
