// 공공요금 고지서 글자 → 사용량 입력 값 (규칙 읽기)
//
// 앱(worklog-app.Html 고지서 업로드)과 서버(api/_lib/water-bill.js)가 함께 쓴다.
// 테스트: npm test (tests/bill-rules.test.js — 실제 고지서에서 뽑은 글자로 확인)
//
// 규칙을 고칠 때는 tests/fixtures 의 글자로 먼저 확인할 것. 앱에서 pdf.js 로 뽑히는 글자는
// 다른 도구(대화 첨부 등)로 뽑은 글자와 다를 수 있다 — 복합기 OCR PDF 는 KSC-EUC-H 라
// pdf.js 에 문자표(cMapUrl)가 없으면 글자가 하나도 안 나온다.

// 양식을 확인한 회사만 규칙을 둔다. 맞는 규칙이 없거나 값을 다 못 찾으면 null → AI 로 넘긴다.
// 입력 기준은 기존 기록에 맞췄다: 상수도·전기는 고지(청구) 월, 도시가스는 사용월.
const toNum = s => Number(String(s).replace(/,/g, ''));
const toYM = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

function normalize(text) {
  return text
    // 조합형(NFD) 한글·전각 숫자/쉼표/물결을 보통 글자로 (스캐너 OCR 글자 층에서 나온다)
    .normalize('NFKC')
    .replace(/[　 ]/g, ' ')             // 한전 청구서의 전각 공백("기본　요금")
    .replace(/\s+/g, ' ')
    // 웹폰트로 찍힌 PDF 는 글자마다 공백이 낀다("고 지 금 액"). 한글 사이 공백만 지운다 —
    // 숫자 사이 공백은 표의 칸 구분이라 남겨야 한다.
    .replace(/(?<=[가-힣])\s+(?=[가-힣])/g, '')
    .trim();
}

// 울산 상수도사업본부 — 사이트 조회 결과(서버)와 인쇄 PDF(앱) 둘 다 이 규칙으로 읽는다
function ruleUlsanWater(text) {
  if (!/하수도요금/.test(text) || !/전자수용가번호/.test(text)) return null;
  const ym = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월/);
  const p = text.match(/사용기간\s*(\d{2})\.(\d{2})\.(\d{2})\s*~\s*(\d{2})\.(\d{2})\.(\d{2})/);
  const amt = text.match(/고지금액\s*([\d,]+)\s*원/);
  const cust = text.match(/고객번호\s*(\d{10})/);
  const use = text.match(/전년동월조정량\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/);
  if (!ym || !p || !amt || !use) return null;
  return {
    energy_type: '상하수도',
    customer_number: cust ? cust[1] : '',
    billing_month: toYM(ym[1], ym[2]),
    start_date: `20${p[1]}-${p[2]}-${p[3]}`,
    end_date: `20${p[4]}-${p[5]}-${p[6]}`,
    usage_amount: toNum(use[3]),
    usage_cost: toNum(amt[1]),
  };
}

// 한국전력 전기요금 이메일 청구서 (사이버지점 화면을 PDF 로 인쇄한 것)
function ruleKepco(text) {
  if (!/전기요금/.test(text) || !/전력량요금/.test(text)) return null;
  const ym = text.match(/고객님의\s*(\d{4})\s*년\s*(\d{1,2})\s*월/);
  const cust = text.match(/(?<![\d-])(\d{2})[-\s](\d{4})[-\s](\d{4})(?![\d-])/);
  const p = text.match(/(\d{2})\.(\d{2})\s*~\s*(\d{2})\.(\d{2})\s*일까지/);   // "01.11 ~ 02.10 일까지"
  const use = text.match(/([\d,]+)\s*kWh/);    // 사용량 비교의 첫 값이 당월
  const amt = text.match(/당월요금계\s*([\d,]+)/) || text.match(/청구금액\s*([\d,]+)/);
  if (!ym || !cust || !p || !use || !amt) return null;
  // 사용기간에 연도가 없다 — 청구월 기준으로 붙이고, 해를 넘기면 한 해 뺀다
  const by = Number(ym[1]), bm = Number(ym[2]);
  const ey = Number(p[3]) > bm ? by - 1 : by;
  const sy = Number(p[1]) > Number(p[3]) ? ey - 1 : ey;
  return {
    energy_type: '전기',
    customer_number: `${cust[1]}-${cust[2]}-${cust[3]}`,
    billing_month: toYM(by, bm),
    start_date: `${sy}-${p[1]}-${p[2]}`,
    end_date: `${ey}-${p[3]}-${p[4]}`,
    usage_amount: toNum(use[1]),
    usage_cost: toNum(amt[1]),
  };
}

// 경동도시가스 이메일 요금 명세서
// 기존 기록은 사용월(사용기간 시작 월)과 계량기 사용량(보정 전)으로 들어가 있다.
function ruleKyungdongGas(text) {
  if (!/도시가스요금명세서/.test(text)) return null;
  const billed = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*청구분/);
  const cust = text.match(/납부번호\s*(\d{6,})/);
  const p = text.match(/사용기간\s*(\d{4})-(\d{2})-(\d{2})\s*~\s*(\d{4})-(\d{2})-(\d{2})/);
  const use = text.match(/(?<!조정)사용량\s+([\d,]+(?:\.\d+)?)/);
  const amt = text.match(/당월금액\s*([\d,]+)\s*원/) || text.match(/청구금액\s*([\d,]+)\s*원/)
    || text.match(/입금하실금액은\s*([\d,]+)\s*원/);
  if (!p || !use || !amt) return null;
  return {
    energy_type: '도시가스',
    customer_number: cust ? cust[1] : '',
    billing_month: toYM(p[1], p[2]),
    start_date: `${p[1]}-${p[2]}-${p[3]}`,
    end_date: `${p[4]}-${p[5]}-${p[6]}`,
    usage_amount: Math.round(toNum(use[1]) * 10000) / 10000,
    usage_cost: toNum(amt[1]),
    note: billed ? `사용월 기준 (${toYM(billed[1], billed[2])} 청구분)` : '사용월 기준',
  };
}

// KT 통신요금 명세서 — 스캔본을 "검색 가능한 PDF"로 저장한 것.
// 스캐너 OCR 글자 층은 품질이 낮아(예: 7604084705J, 1,669f140원) 다음처럼 읽는다.
//   금액: 쉼표 숫자 중 가장 여러 번 나온 값 (명세서에 납부금액이 네댓 번 찍힌다)
//   기간: "12월 1일 ~ 12월 31일" / 월: 이용월 다음 달이 명세서 월 / 연도: 20260202 같은 날짜
//   명세서번호: 온전히 읽히지 않으므로 오인식 글자를 숫자로 바꾼 문자열을 만들어 두고,
//              앱(_buResolve)이 등록된 고객번호가 그 안에 있는지 찾는다
const OCR_DIGIT = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', i: '1', '|': '1', Z: '2', z: '2',
  J: '3', 'Ξ': '3', '∃': '3', A: '4', S: '5', s: '5', G: '6', b: '6', T: '7', g: '9', q: '9' };
function ocrBlobs(text) {
  const base = [...text].map(c => OCR_DIGIT[c] ?? c).join('').replace(/[\s\-·.,]/g, '');
  // B 는 3 으로도 8 로도 읽힌다 — 두 가지를 다 만든다
  return [base.replace(/B/g, '8'), base.replace(/B/g, '3')].map(s => s.replace(/\D+/g, ' '));
}
function ruleKtTelecom(text) {
  if (!/\bKT\b|케이티|수납통지서/.test(text)) return null;

  const counts = new Map();
  const fixed = text.replace(/(?<=\d)[fr](?=\d{3})/g, ',');
  for (const m of fixed.matchAll(/(?<![\d,])\d{1,3}(?:,\s?\d{3})+(?![\d,])/g)) {
    const v = toNum(m[0].replace(/\s/g, ''));
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  for (const m of text.matchAll(/(?<!\d)\d{5,9}(?!\d)/g)) {   // 표준OCR 칸의 쉼표 없는 납부금액
    const v = Number(m[0]);
    if (counts.has(v)) counts.set(v, counts.get(v) + 1);
  }
  const [cost, hits] = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] || [];
  if (!cost || hits < 2) return null;

  // 명세서 월: "6월 납부하실 금액은" / "[6월 명세서]" 가 가장 덜 깨진다. 없으면 이용기간 다음 달.
  const p = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*\S{0,3}\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  const head = text.match(/(?<!\d)(\d{1,2})\s*월\s*납부하실/) || text.match(/(?<!\d)(\d{1,2})\s*월\s*명세서/);
  const bm = head ? Number(head[1]) : p ? Number(p[3]) % 12 + 1 : null;
  if (!bm || bm > 12) return null;

  // 연도: 명세서 월이거나 그 다음 달(발송일·납기일)을 가리키는 날짜 단서에서 찾는다.
  //   20260202 / 202606J0(납부자 칸, 뒤가 깨짐) / "2026년 6윔"(월 글자가 깨짐)
  const cands = [
    ...[...text.matchAll(/(?<!\d)(20\d{2})(0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)/g)],
    ...[...text.matchAll(/(?<!\d)(20\d{2})(0[1-9]|1[0-2])(?!\d)/g)],
    ...[...text.matchAll(/(?<!\d)(20\d{2})\s*년\s*(\d{1,2})\s*[가-힣]/g)],
  ].sort((a, b) => a.index - b.index);
  let by = null;
  for (const d of cands) {
    const y = Number(d[1]), m = Number(d[2]);
    if (m < 1 || m > 12) continue;
    by = [y, y - 1].find(Y => { const diff = (y * 12 + m) - (Y * 12 + bm); return diff >= 0 && diff <= 1; }) ?? null;
    if (by) break;
  }
  if (!by) return null;

  // 이용기간: KT 기업요금은 명세서 전달 1일~말일. 기간이 읽혔고 그 달이면 읽힌 날짜를 쓴다.
  const um = bm === 1 ? 12 : bm - 1, uy = bm === 1 ? by - 1 : by;
  const pad = n => String(n).padStart(2, '0');
  const readOk = p && Number(p[3]) === um && Number(p[1]) === um;
  const sd = readOk ? Number(p[2]) : 1;
  const ed = readOk ? Number(p[4]) : new Date(uy, um, 0).getDate();
  return {
    energy_type: '통신',
    customer_number: (text.match(/명세서번호는\s*(\d{11})/) || [])[1] || '',
    _blobs: ocrBlobs(text),
    billing_month: toYM(by, bm),
    start_date: `${uy}-${pad(um)}-${pad(sd)}`,
    end_date: `${uy}-${pad(um)}-${pad(ed)}`,
    usage_amount: 0,
    usage_cost: cost,
    note: '스캔 글자 인식 — 금액·기간을 명세서와 대조하세요' + (readOk ? '' : ' (이용기간은 전달 1일~말일로 채움)'),
  };
}

const RULES = [ruleUlsanWater, ruleKepco, ruleKyungdongGas, ruleKtTelecom];

// 결과: [{ energy_type, customer_number, billing_month, start_date, end_date, usage_amount, usage_cost, note, _blobs? }] 또는 null
export function parseBillText(raw) {
  const text = normalize(raw);
  for (const rule of RULES) {
    const bill = rule(text);
    if (bill) return [{ note: '', ...bill }];
  }
  return null;
}

// ── 기록과 비교 ─────────────────────────────────────────────────────
// 앱(고지서 업로드·상수도 불러오기)과 서버(매월 10일 처리)가 같은 기준으로 표시한다.

// 'YYYY-MM' 에서 n 달 이동
export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return toYM(Math.floor(t / 12), t % 12 + 1);
}

export const ALERT_RATIO = 0.3;   // 이만큼(30%) 넘게 달라지면 알린다

// 전월·전년 같은 달 기록과 견줘 크게 달라진 것. 기록 행은 { usage_amount, usage_cost }.
// 통신은 사용량을 0 으로 넣으므로 금액만 본다.
export function usageAlerts(bill, { prev, lastYear } = {}) {
  const out = [];
  const pct = (now, base) => Math.round((now - base) / base * 100);
  const check = (label, now, base, what) => {
    if (!(base > 0) || !(now >= 0)) return;
    const p = pct(now, base);
    if (Math.abs(p) >= ALERT_RATIO * 100) out.push(`${what} ${label} ${p > 0 ? '+' : ''}${p}%`);
  };
  for (const [label, rec] of [['전월 대비', prev], ['전년 같은 달 대비', lastYear]]) {
    if (!rec) continue;
    if (bill.energy_type !== '통신') check(label, Number(bill.usage_amount), Number(rec.usage_amount), '사용량');
    check(label, Number(bill.usage_cost), Number(rec.usage_cost), '금액');
  }
  return out;
}

// 이미 있는 기록과 고지서 값이 다른 곳. 기록 행은 { start_date, end_date, usage_amount, usage_cost }.
export function recordDiff(rec, bill) {
  const out = [];
  const fmt = (v) => Number(v).toLocaleString('ko-KR');
  const differs = (a, b) => Math.abs(Number(a) - Number(b)) > 0.005;
  if (bill.energy_type !== '통신' && bill.usage_amount != null && differs(rec.usage_amount, bill.usage_amount)) {
    out.push(`사용량 기록 ${fmt(rec.usage_amount)} / 고지서 ${fmt(bill.usage_amount)}`);
  }
  if (bill.usage_cost != null && differs(rec.usage_cost, bill.usage_cost)) {
    out.push(`금액 기록 ${fmt(rec.usage_cost)} / 고지서 ${fmt(bill.usage_cost)}`);
  }
  if (bill.start_date && bill.end_date && (rec.start_date !== bill.start_date || rec.end_date !== bill.end_date)) {
    out.push(`기간 기록 ${rec.start_date || '-'}~${rec.end_date || '-'} / 고지서 ${bill.start_date}~${bill.end_date}`);
  }
  return out;
}
