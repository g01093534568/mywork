// 고지서 규칙 읽기 테스트 — npm test
//
// fixtures 는 실제 고지서 PDF 에서 앱과 같은 방식(pdf.js + 문자표)으로 뽑은 글자다.
// 계좌번호처럼 규칙에 필요 없는 숫자는 #### 로 가려 두었다.
// 양식이 바뀌어 규칙을 고치면, 그 고지서의 글자를 fixtures 에 추가하고 여기에 기대값을 적는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseBillText, shiftMonth, usageAlerts, recordDiff } from '../bill-rules.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');

function readOne(name) {
  const bills = parseBillText(fixture(name));
  assert.ok(bills, `${name}: 규칙이 읽지 못함`);
  assert.equal(bills.length, 1);
  const { _blobs, note, ...bill } = bills[0];
  return { bill, note, blobs: _blobs };
}

const CASES = [
  ['water-worklog-pdf', {   // WorkLog "고지서 PDF 받기"로 만든 파일
    energy_type: '상하수도', customer_number: '2020600029', billing_month: '2026-09',
    start_date: '2026-07-23', end_date: '2026-08-22', usage_amount: 184, usage_cost: 390990 }],
  ['water-site-print', {    // 상수도 사이트에서 직접 인쇄한 파일 — 글자마다 공백이 낀다
    energy_type: '상하수도', customer_number: '2015601258', billing_month: '2026-09',
    start_date: '2026-07-23', end_date: '2026-08-22', usage_amount: 240, usage_cost: 938970 }],
  ['elec-kepco', {
    energy_type: '전기', customer_number: '04-3963-0865', billing_month: '2026-02',
    start_date: '2026-01-11', end_date: '2026-02-10', usage_amount: 27995, usage_cost: 4883480 }],
  ['gas-kyungdong', {       // 기존 기록 기준: 사용월 + 보정 전 사용량
    energy_type: '도시가스', customer_number: '000062101110', billing_month: '2025-11',
    start_date: '2025-11-01', end_date: '2025-11-30', usage_amount: 901, usage_cost: 724900 }],
];

for (const [name, expected] of CASES) {
  test(name, () => assert.deepEqual(readOne(name).bill, expected));
}

// KT 스캔본(복합기 OCR) — 명세서번호는 글자가 깨져 있어 ocr 문자열 안에 들어 있는지로 확인한다
const KT = '76040847053';
const KT_CASES = [
  ['kt-ocr-jan', { billing_month: '2026-01', start_date: '2025-12-01', end_date: '2025-12-31' }],
  ['kt-ocr-attached', { billing_month: '2026-01', start_date: '2025-12-01', end_date: '2025-12-31' }],
  ['kt-ocr-jun', { billing_month: '2026-06', start_date: '2026-05-01', end_date: '2026-05-31' }],   // 기간이 깨져 전달로 채움
];
for (const [name, expected] of KT_CASES) {
  test(name, () => {
    const { bill, blobs } = readOne(name);
    assert.equal(bill.energy_type, '통신');
    assert.equal(bill.usage_amount, 0);
    assert.equal(bill.usage_cost, 1669140);
    for (const [k, v] of Object.entries(expected)) assert.equal(bill[k], v, k);
    assert.ok(blobs.some(b => b.includes(KT)), '명세서번호를 찾지 못함');
    assert.ok(!blobs.some(b => b.includes('90045227663')), '다른 회선 번호가 잘못 맞음');
  });
}

test('KT: 해가 바뀌는 12월 명세서(11월 이용, 납기 다음 해 1월)', () => {
  const text = fixture('kt-ocr-jan')
    .replace('12월 1일 ˜ 12월 31일', '11월 1일 ˜ 11월 30일')
    .replace('20260107', '20251207').replace('20260202', '20260105')
    .replace('2026년 2윔', '2026년 1윔').replace('2026 넌', '2025 넌');
  const [bill] = parseBillText(text);
  assert.equal(bill.billing_month, '2025-12');
  assert.equal(bill.start_date, '2025-11-01');
  assert.equal(bill.end_date, '2025-11-30');
});

test('전기: 1월 청구서는 사용기간이 전년 12월에 걸친다', () => {
  const text = fixture('elec-kepco').replace('2026년 02월', '2026년 01월').replace('01.11 ~ 02.10', '12.11 ~ 01.10');
  const [bill] = parseBillText(text);
  assert.equal(bill.billing_month, '2026-01');
  assert.equal(bill.start_date, '2025-12-11');
  assert.equal(bill.end_date, '2026-01-10');
});

test('글자가 변형돼도 읽는다 (조합형 한글·전각 물결)', () => {
  assert.equal(parseBillText(fixture('gas-kyungdong').normalize('NFD'))[0].usage_cost, 724900);
  assert.equal(parseBillText(fixture('kt-ocr-attached').replace('˜', '～'))[0].billing_month, '2026-01');
});

test('고지서가 아니면 null', () => {
  assert.equal(parseBillText('[붙임4] 내부심사 심사점검표 2026. 09. 14. 15:00'), null);
  assert.equal(parseBillText(''), null);
});

test('월 이동', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-09', -12), '2025-09');
  assert.equal(shiftMonth('2025-12', 1), '2026-01');
});

test('이상치: 30% 넘게 달라지면 알린다', () => {
  const bill = { energy_type: '상하수도', usage_amount: 3279, usage_cost: 6819990 };
  assert.deepEqual(usageAlerts(bill, { prev: { usage_amount: 521, usage_cost: 1068740 } }),
    ['사용량 전월 대비 +529%', '금액 전월 대비 +538%']);
  assert.deepEqual(usageAlerts(bill, { prev: { usage_amount: 3000, usage_cost: 6500000 } }), []);
  assert.deepEqual(usageAlerts(bill, {}), []);
  // 통신은 금액만 본다 (사용량 0)
  assert.deepEqual(usageAlerts({ energy_type: '통신', usage_amount: 0, usage_cost: 1669140 },
    { prev: { usage_amount: 0, usage_cost: 16619140 } }), ['금액 전월 대비 -90%']);
});

test('값 불일치: 오타난 기록을 잡는다', () => {
  const bill = { energy_type: '통신', usage_amount: 0, usage_cost: 1669140, start_date: '2026-01-01', end_date: '2026-01-31' };
  assert.deepEqual(recordDiff({ usage_amount: 0, usage_cost: 16619140, start_date: '2026-01-01', end_date: '2026-01-31' }, bill),
    ['금액 기록 16,619,140 / 고지서 1,669,140']);
  assert.deepEqual(recordDiff({ usage_amount: 0, usage_cost: 1669140, start_date: '2026-01-01', end_date: '2026-01-31' }, bill), []);
  assert.deepEqual(recordDiff({ usage_amount: 889.6, usage_cost: 724900, start_date: '2025-11-01', end_date: '2025-11-30' },
    { energy_type: '도시가스', usage_amount: 901, usage_cost: 724900, start_date: '2025-11-01', end_date: '2025-11-30' }),
    ['사용량 기록 889.6 / 고지서 901']);
});
