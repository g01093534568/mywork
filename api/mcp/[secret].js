// MCP 서버 — claude.ai / Claude Desktop / Claude Code에서 이 앱의 데이터를 읽고 쓴다.
//
// 주소:  https://<도메인>/api/mcp/<MCP_SECRET>
//        비밀값을 경로에 두는 방식이라 별도 로그인 화면이 없다. 주소를 아는 쪽이 곧 권한이므로
//        URL이 새면 MCP_SECRET을 새로 발급해 무효화한다.
//
// 환경변수 (Vercel → Environment Variables)
//   MCP_SECRET       필수. 경로에 들어갈 추측 불가능한 문자열
//   MCP_EMPNO        필수. 이 비밀값이 대신할 사원번호 (6자리)
//   MCP_FACILITY     같은 사원번호가 여러 시설에 있을 때 필수. 로그인할 때 쓰는 시설명
//   SUPABASE_URL     선택. 기본값은 앱이 쓰는 것과 동일
//   SUPABASE_SERVICE_ROLE_KEY  이 키로 조회한다 (RLS 를 닫은 뒤에는 anon 으로는 아무것도 안 보인다)
//   SUPABASE_KEY     선택. 따로 줄 때만. 둘 다 없으면 앱의 anon 키를 쓴다
//
// 할 일·업무일지·시설목표·에너지 기록은 전용 도구로, 그 밖의 앱 데이터(개인·연간목표, 독서, 운동, 주식·펀드,
// 에너지 고객정보, 차량, AI 지식자료, 조직목표)는 공통 도구(list/get/add/update/delete_record)로 다룬다.
// 인사 데이터(hr_*·placement)와 로그인 계정(users)은 다루지 않는다.
//
// 삭제 도구(delete_todo, delete_daily_log, delete_facility_goal, delete_energy_record, delete_record)는 confirm:true 를 줘야만 지운다. 지운 항목의 원래 값을 결과에 그대로 돌려주어
// 실수로 지웠을 때 다시 넣을 수 있게 한다. 부르는 쪽(비서)은 지우기 전에 사용자 확인을 받는다.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SB_URL = process.env.SUPABASE_URL || 'https://zbcnfixbkqtrjxvatvss.supabase.co';
// 앱 HTML에 이미 공개돼 있는 anon 키 — 서버 키가 없을 때의 마지막 기본값
const SB_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpiY25maXhia3F0cmp4dmF0dnNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzODM1MjYsImV4cCI6MjA5NTk1OTUyNn0.r2W70mUhk0EaCVJaVZDHE3Yop_S66aLjPknWdpvdlDY';

const SB_TIMEOUT_MS = 15000;

/* ── Supabase REST ───────────────────────────────────────────── */

// 인사배치·인사관리 데이터(hr_* 테이블)는 MCP로 절대 읽거나 쓰지 않는다 — 비서(AI)에게 인사 정보를 주지 않기 위해
// 나중에 도구를 추가하더라도 여기서 막힌다.
const BLOCKED_TABLES = /^(hr_|placement)/i;

async function sb(path, opts = {}) {
  if (BLOCKED_TABLES.test(path)) throw new Error('인사 데이터는 MCP로 접근할 수 없습니다');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SB_TIMEOUT_MS);
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
      ...opts,
      signal: ac.signal,
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status} — ${(await res.text()).slice(0, 200)}`);
    const body = await res.text();
    return body ? JSON.parse(body) : null;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Supabase 응답 시간 초과');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const q = (v) => encodeURIComponent(v);

/* ── 날짜 (앱과 같은 한국 시간 기준) ─────────────────────────── */

// Vercel 함수는 UTC로 돈다. 그냥 new Date()를 쓰면 한국 자정~오전 9시 사이에 하루가 어긋난다.
function todayKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}
function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── 앱과 같은 판정 규칙 ─────────────────────────────────────── */

function isDoneOnDate(t, date) {
  if (t.is_recurring) return (t.completed_dates || []).includes(date);
  return t.status === 'done' && t.completed_date === date;
}
function isRecurringOnDate(t, date) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  return (t.recurring_days || []).includes(dow);
}
// 앱의 todayVisible과 동일: 시작했으면 마감이 미래여도 오늘 할 일로 본다
function visibleOnDate(t, date) {
  if (t.is_recurring) return isRecurringOnDate(t, date);
  if (t.status === 'todo') return !t.start_date || t.start_date <= date;
  return t.completed_date === date;
}

const PRIORITY_LABEL = { high: '높음', mid: '중간', low: '낮음' };

// 할 일 id 는 UUID 라 목록에는 앞 8자리만 보인다. 수정 도구는 이 #id(앞자리)로도 찾는다
const todoShortId = (t) => String(t.id || '').slice(0, 8);

function formatTodo(t, date) {
  const done = isDoneOnDate(t, date);
  const bits = [t.category || '업무', PRIORITY_LABEL[t.priority] || '중간'];
  if (t.time_range) bits.push(t.time_range);
  if (t.due_date) bits.push(`마감 ${t.due_date}`);
  if (t.is_recurring) bits.push('반복');
  return `#${todoShortId(t)} ${done ? '[완료]' : '[ ]'} ${t.title} (${bits.join(' · ')})`;
}

/* ── 사용자 ──────────────────────────────────────────────────── */

// 사원번호는 유일하지 않다 — 같은 번호가 여러 시설에 걸쳐 있다(앱 로그인도 시설명+사원번호로 구분).
// 시설명이 틀리면 시설 경영목표·에너지가 엉뚱한 시설 것으로 나오므로, 애매하면 그냥 실패시킨다.
let _userCache = null;
async function getUser(empno, facility) {
  if (_userCache) return _userCache;
  let path = `users?사원번호=eq.${q(empno)}&select=id,사원번호,성명,시설명,role`;
  if (facility) path += `&시설명=eq.${q(facility)}`;
  const rows = await sb(path);
  if (!rows || !rows.length) {
    throw new Error(`사원번호 ${empno}${facility ? ` · 시설명 ${facility}` : ''} 에 해당하는 사용자가 없습니다`);
  }
  if (rows.length > 1) {
    throw new Error(
      `사원번호 ${empno} 가 여러 시설에 있습니다. MCP_FACILITY 환경변수로 시설명을 지정하세요: ` +
      rows.map(r => r.시설명).join(' / ')
    );
  }
  _userCache = rows[0];
  return _userCache;
}

// 시설 관리자가 볼 수 있는 시설 = 본인 시설 + 그 시설을 상위로 둔 하위 시설
// 통신 회선 이름이 붙은 시설명 → 조직도 시설명 (앱 worklog-app.Html 의 EM_FACILITY_ALIAS 와 같게 유지)
const EM_FACILITY_ALIAS = {
  '대운산야영장(ip이용료)': '대운산야영장',
  '대운산야영장(IP이용료)': '대운산야영장',
  '대운산야영장(인터넷)': '대운산야영장',
};
const withAliases = (names) => {
  const out = new Set(names);
  for (const [alias, target] of Object.entries(EM_FACILITY_ALIAS)) if (out.has(target)) out.add(alias);
  return [...out];
};
const inList = (names) => `in.(${names.map(n => `"${n.replace(/"/g, '""')}"`).join(',')})`;

// 자신 + 모든 하위(손자 이하 포함) — 앱의 _getManagedFacilityNames 와 같다.
// 조직도가 4~5단계라 직계 1단계만 보면 아래가 통째로 빠진다.
async function managedFacilities(facility) {
  const all = (await sb('users?select=시설명,parent_facility')) || [];
  const out = new Set([facility]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of all) {
      if (u.시설명 && u.parent_facility && out.has(u.parent_facility) && !out.has(u.시설명)) {
        out.add(u.시설명); grew = true;
      }
    }
  }
  return [...out].filter(Boolean);
}

// 에너지 기록을 볼 수 있는 범위 — 앱 _emEnergyQuery 와 같다: admin 전체, facility-admin 관리 시설, user 본인 시설.
// 조회·수정·삭제가 모두 이 필터를 거치므로 범위 밖 기록은 id를 알아도 건드릴 수 없다.
async function energyScope(user) {
  if (user.role === 'admin') return { filter: '', label: '전체 시설' };
  if (user.role === 'facility-admin') {
    const names = await managedFacilities(user.시설명);
    return { filter: `&facility_name=${inList(withAliases(names))}`, label: `${user.시설명} 외 ${names.length - 1}곳` };
  }
  return { filter: `&facility_name=${inList(withAliases([user.시설명]))}`, label: user.시설명 };
}

const ENERGY_TYPES = ['전기', '상하수도', '도시가스', '통신'];
const MONTH_RE = /^\d{4}-\d{2}$/;
const ENERGY_UNIT = { 전기: 'kWh', 상하수도: '㎥', 도시가스: '㎥' };

// 옛 이관 자료는 '전기료'처럼 '료'가 붙어 있다
const energyTypeOf = (raw) => (raw || '기타').replace(/료$/, '');
const energyTypeFilter = (t) => {
  const base = energyTypeOf(t);
  return `&energy_type=in.(${[base, base + '료'].map(v => `"${v}"`).join(',')})`;
};

function formatEnergyRecord(r) {
  const type = energyTypeOf(r.energy_type);
  const unit = ENERGY_UNIT[type] || '';
  const usage = r.usage_amount === null ? '-' : Number(r.usage_amount).toLocaleString('ko-KR');
  const cost = r.usage_cost === null ? '-' : Math.round(Number(r.usage_cost)).toLocaleString('ko-KR');
  const period = r.start_date || r.end_date ? ` · ${r.start_date || '?'}~${r.end_date || '?'}` : '';
  return `#${r.id} ${r.billing_month || '월 미상'} ${r.facility_name} ${type}${period} · 사용량 ${usage}${unit ? ' ' + unit : ''} · 요금 ${cost}원`;
}

async function findEnergyRecord(user, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return { error: 'id 는 list_energy_records 에 나오는 기록 번호(숫자)여야 합니다' };
  const scope = await energyScope(user);
  const rows = await sb(`energy_records?id=eq.${n}${scope.filter}&select=*`);
  if (!rows || !rows.length) return { error: `#${n} 에너지 기록이 없거나 볼 수 있는 시설 범위 밖입니다` };
  return { record: rows[0], scope };
}

/* ── 그 밖의 앱 데이터: 공통 도구(list/get/add/update/delete_record)로 다룬다 ─────────
 * 전용 도구가 있는 할 일·업무일지·시설목표·에너지 기록은 앱 규칙(반복 완료·달성률 계산 등)이 있어
 * 여기 넣지 않는다. 인사(hr_*·placement)는 BLOCKED_TABLES 에서, 로그인 계정(users: 비밀번호 포함)은
 * 여기 없다는 것으로 막힌다 — 이 표에 없는 테이블은 공통 도구로 손댈 수 없다.
 *
 * scope  owner    본인(users.id) 것만. 추가할 때 owner_id·사원번호를 채운다
 *        facility 에너지 기록과 같은 시설 범위(energyScope)
 *        global   모두 같은 데이터
 * read/write  앱 CAPS 와 같은 역할 제한 (없으면 누구나)
 * cols   type: text·number·int·date·enum(values)·strarr(문자열 배열 jsonb)·json·jsonarr(배열을 JSON 문자열로 저장)
 */
const ENERGY_MANAGE = ['admin', 'facility-admin'];   // 앱 CAPS 'energy.manage'
const DATASETS = {
  personal_goals: {
    label: '개인 성과목표', table: 'personal_goals', scope: 'owner', id: 'text', order: 'created_at.asc',
    cols: {
      goal: { type: 'text', label: '목표', required: true },
      kpis: { type: 'strarr', label: 'KPI' },
      progress: { type: 'int', label: '진행률(%)' },
      linked: { type: 'text', label: '연계 시설목표' },
    },
    show: ['goal', 'progress', 'kpis', 'linked'], search: ['goal', 'linked'],
  },
  annual_goals: {
    label: '연간 개인목표', table: 'annual_goals', scope: 'owner', id: 'uuid', order: 'year.desc,category.asc',
    cols: {
      year: { type: 'int', label: '연도', required: true },
      category: { type: 'text', label: '분류(건강·자기계발 등)', required: true },
      title: { type: 'text', label: '제목', required: true },
      description: { type: 'text', label: '설명' },
      target: { type: 'jsonarr', label: '목표치 목록' },
      progress: { type: 'int', label: '진행률(%)' },
      status: { type: 'enum', values: ['진행중', '완료', '보류'], label: '상태' },
    },
    show: ['year', 'category', 'title', 'status', 'progress', 'target'], search: ['title', 'description', 'category'],
    defaults: { status: '진행중', progress: 0, target: '[]' }, touch: true,
  },
  books: {
    label: '독서기록', table: 'books', scope: 'owner', id: 'uuid', order: 'created_at.desc',
    cols: {
      title: { type: 'text', label: '제목', required: true },
      author: { type: 'text', label: '저자' },
      status: { type: 'enum', values: ['읽을예정', '읽는중', '완독'], label: '상태' },
      start_date: { type: 'date', label: '시작일' },
      end_date: { type: 'date', label: '완독일' },
      rating: { type: 'int', label: '별점(1~5)' },
      memo: { type: 'text', label: '메모' },
      cover_url: { type: 'text', label: '표지 주소' },
    },
    show: ['title', 'author', 'status', 'start_date', 'end_date', 'rating'], search: ['title', 'author', 'memo'],
    defaults: { status: '읽는중' }, touch: true,
  },
  exercises: {
    label: '운동기록(골프·러닝)', table: 'exercises', scope: 'owner', id: 'text', order: 'date.desc', read: ['admin'],
    cols: {
      type: { type: 'enum', values: ['golf', 'running', 'running_race'], label: '종류(golf 골프 / running 러닝 / running_race 대회)', required: true },
      date: { type: 'date', label: '날짜', required: true },
      location: { type: 'text', label: '장소' },
      score: { type: 'int', label: '골프 타수' },
      distance: { type: 'number', label: '거리(km)' },
      duration: { type: 'int', label: '시간(분)' },
      memo: { type: 'text', label: '메모' },
    },
    show: ['date', 'type', 'location', 'score', 'distance', 'duration'], search: ['location', 'memo'], touch: true,
  },
  stocks: {
    label: '보유 종목', table: 'stocks', scope: 'owner', id: 'text', order: 'created_at.asc',
    cols: {
      name: { type: 'text', label: '종목명', required: true },
      ticker: { type: 'text', label: '종목코드' },
      current_price: { type: 'number', label: '현재가' },
      prev_close: { type: 'number', label: '전일 종가' },
    },
    show: ['name', 'ticker', 'current_price', 'prev_close'], search: ['name', 'ticker'],
  },
  trades: {
    label: '주식 매매기록', table: 'trades', scope: 'owner', id: 'text', order: 'trade_date.desc',
    cols: {
      stock_id: { type: 'text', label: '보유 종목 id(stocks)' },
      stock_name: { type: 'text', label: '종목명', required: true },
      ticker: { type: 'text', label: '종목코드' },
      trade_date: { type: 'date', label: '거래일', required: true },
      type: { type: 'enum', values: ['buy', 'sell'], label: '매수 buy / 매도 sell', required: true },
      qty: { type: 'number', label: '수량', required: true },
      price: { type: 'number', label: '단가', required: true },
      fee: { type: 'number', label: '수수료' },
      memo: { type: 'text', label: '메모' },
    },
    show: ['trade_date', 'type', 'stock_name', 'qty', 'price', 'fee'], search: ['stock_name', 'ticker', 'memo'],
    defaults: { fee: 0, memo: '' },
  },
  funds: {
    label: '펀드', table: 'funds', scope: 'owner', id: 'text', order: 'created_at.asc',
    cols: {
      name: { type: 'text', label: '펀드명', required: true },
      fund_type: { type: 'text', label: '유형(ETF·주식혼합 등)' },
      principal: { type: 'number', label: '원금' },
      valuation: { type: 'number', label: '평가금액' },
      start_date: { type: 'date', label: '가입일' },
      memo: { type: 'text', label: '메모' },
    },
    show: ['name', 'fund_type', 'principal', 'valuation', 'start_date'], search: ['name', 'memo'],
  },
  energy_info: {
    label: '에너지 고객정보(고객번호·납부계좌)', table: 'energy_info', scope: 'facility', id: 'int', order: 'facility_name.asc,energy_type.asc',
    write: ENERGY_MANAGE,
    cols: {
      facility_name: { type: 'text', label: '시설명', required: true },
      energy_type: { type: 'enum', values: ENERGY_TYPES, label: '종류', required: true },
      customer_number: { type: 'text', label: '고객번호' },
      bank_name: { type: 'text', label: '은행' },
      account_number: { type: 'text', label: '납부 계좌' },
    },
    show: ['facility_name', 'energy_type', 'customer_number', 'bank_name', 'account_number'], search: ['facility_name', 'customer_number'],
    mask: ['customer_number', 'account_number'],   // 목록·수정 결과에서는 뒤 4자리만. 전체 값은 get_record 로
  },
  vehicle_info: {
    label: '차량정보', table: 'vehicle_info', scope: 'facility', id: 'int', order: 'facility_name.asc',
    write: ENERGY_MANAGE,
    cols: {
      facility_name: { type: 'text', label: '시설명', required: true },
      vehicle_number: { type: 'text', label: '차량번호', required: true },
      fuel: { type: 'text', label: '연료' },
      model_year: { type: 'text', label: '연식' },
      vehicle_type: { type: 'text', label: '차종' },
    },
    show: ['facility_name', 'vehicle_number', 'vehicle_type', 'fuel', 'model_year'], search: ['facility_name', 'vehicle_number', 'vehicle_type'],
  },
  knowledge: {
    label: 'AI 지식자료', table: 'knowledge_sources', scope: 'global', id: 'uuid', order: 'created_at.asc',
    write: ['admin', 'facility-admin'],   // 앱 CAPS 'knowledge.manage'
    cols: {
      title: { type: 'text', label: '제목', required: true },
      src_type: { type: 'enum', values: ['text', 'url', 'file', 'pdf'], label: '자료 형태' },
      content: { type: 'text', label: '본문', required: true },
    },
    show: ['title', 'src_type', 'content', 'created_at'], search: ['title', 'content'],
    defaults: { src_type: 'text' }, longText: 'content',
  },
  org_goals: {
    label: '조직목표(미션·비전·전략목표·전략과제)', table: 'org_goals', scope: 'global', id: 'int', order: 'id.asc',
    write: ['admin'], noAdd: true, noDelete: true,   // 앱 CAPS 'goals.org'. 한 줄(id 1)뿐이라 추가·삭제는 막는다
    confirmUpdate: true,   // 공단 전체에 보이는 내용이라 수정도 미리보기 → confirm:true 로 확정
    cols: {
      mission: { type: 'text', label: '미션' },
      vision: { type: 'text', label: '비전' },
      전략목표: { type: 'json', label: '전략목표 배열(문자열)' },
      전략과제: { type: 'json', label: '전략과제 배열 [{과제, 목표idx, 경영목표[]}]' },
    },
    show: ['mission', 'vision', '전략목표', '전략과제'], search: ['mission', 'vision'], touch: true,
  },
};
const DATASET_KEYS = Object.keys(DATASETS);
const DATASET_HELP = DATASET_KEYS.map(k => {
  const d = DATASETS[k];
  return `${k}=${d.label} [${Object.entries(d.cols).map(([c, m]) => `${c}${m.required ? '*' : ''}: ${m.label}${m.values ? ` (${m.values.join('/')})` : ''}`).join(', ')}]`;
}).join('\n');

function dsRoleOk(ds, user, mode) {
  const roles = mode === 'write' ? (ds.write || ds.read) : ds.read;
  return !roles || roles.includes(user.role);
}

// 공통 도구에서 쓸 범위 필터 — 조회·수정·삭제가 모두 이것을 거친다
async function dsScope(ds, user) {
  if (ds.scope === 'owner') return `&owner_id=eq.${q(user.id)}`;
  if (ds.scope === 'facility') return (await energyScope(user)).filter;
  return '';
}

// 들어온 값을 컬럼 형식에 맞춰 바꾼다. 문제가 있으면 { error } 를 돌려준다.
function dsCoerce(ds, values) {
  const out = {};
  for (const [k, raw] of Object.entries(values || {})) {
    const m = ds.cols[k];
    if (!m) return { error: `${k} 는 ${ds.label}에 없는 항목입니다. 쓸 수 있는 항목: ${Object.keys(ds.cols).join(', ')}` };
    if (raw === null || raw === '') {
      if (m.required) return { error: `${m.label}(${k}) 은(는) 비울 수 없습니다` };
      out[k] = m.type === 'strarr' ? [] : m.type === 'jsonarr' ? '[]' : null;
      continue;
    }
    switch (m.type) {
      case 'text': out[k] = String(raw); break;
      case 'number': case 'int': {
        const n = fgNum(raw);
        if (n === null) return { error: `${m.label}(${k}) 은(는) 숫자여야 합니다` };
        out[k] = m.type === 'int' ? Math.round(n) : n;
        break;
      }
      case 'date':
        if (!DATE_RE.test(String(raw))) return { error: `${m.label}(${k}) 은(는) YYYY-MM-DD 형식이어야 합니다` };
        out[k] = String(raw); break;
      case 'enum':
        if (!m.values.includes(String(raw))) return { error: `${m.label}(${k}) 은(는) ${m.values.join('/')} 중 하나여야 합니다` };
        out[k] = String(raw); break;
      case 'strarr': case 'jsonarr': {
        const arr = Array.isArray(raw) ? raw.map(String) : [String(raw)];
        out[k] = m.type === 'jsonarr' ? JSON.stringify(arr) : arr;
        break;
      }
      case 'json':
        if (typeof raw === 'string') {
          try { out[k] = JSON.parse(raw); } catch { return { error: `${m.label}(${k}) 은(는) JSON 이어야 합니다` }; }
        } else out[k] = raw;
        break;
    }
  }
  return { values: out };
}

// 계좌·고객번호: 숫자·문자 뒤 4자리만 남기고 가린다
function maskTail(v) {
  const s = String(v);
  let keep = 4;
  return s.split('').reverse().map(ch => (/[0-9A-Za-z]/.test(ch) ? (keep-- > 0 ? ch : '*') : ch)).reverse().join('');
}

function dsShowValue(ds, col, v, full) {
  if (v === null || v === undefined || v === '') return '-';
  if (!full && ds.mask?.includes(col)) return maskTail(v);
  const m = ds.cols[col];
  if (m?.type === 'jsonarr') { try { const a = JSON.parse(v); return Array.isArray(a) ? a.join(', ') || '-' : String(v); } catch { return String(v); } }
  if (Array.isArray(v) && v.every(x => typeof x !== 'object')) return v.join(', ') || '-';
  if (typeof v === 'object') return JSON.stringify(v);
  if (col === ds.longText && !full) return `(${String(v).length.toLocaleString('ko-KR')}자) ${String(v).slice(0, 60).replace(/\s+/g, ' ')}…`;
  if (typeof v === 'number' && m?.type === 'number') return v.toLocaleString('ko-KR');   // 연도·별점 같은 정수는 그대로
  return String(v);
}

function dsFormat(ds, row, full = false) {
  const cols = full ? Object.keys(ds.cols) : ds.show;
  const label = (c) => (ds.cols[c]?.label || c).replace(/\(.*\)$/, '');
  const parts = cols.map(c => `${label(c)}: ${dsShowValue(ds, c, row[c], full)}`);
  if (full) return `#${row.id}\n` + parts.map(p => `  ${p}`).join('\n');
  return `#${row.id} · ${parts.join(' · ')}`;
}

async function dsFind(ds, user, id) {
  if (id === undefined || id === null || id === '') return { error: 'id 가 필요합니다. list_records 로 먼저 찾으세요' };
  const sid = String(id).replace(/^#/, '');
  if (ds.id === 'int' && !/^\d+$/.test(sid)) return { error: 'id 는 숫자여야 합니다' };
  const scope = await dsScope(ds, user);
  const rows = await sb(`${ds.table}?id=eq.${q(sid)}${scope}&select=*`);
  if (!rows || !rows.length) return { error: `${ds.label} #${sid} 이(가) 없거나 볼 수 있는 범위 밖입니다` };
  return { row: rows[0], scope };
}

// 시설 범위 데이터는 범위 안 시설명으로만 넣고 옮길 수 있다(오타·범위 밖 시설이면 다시 찾을 수 없게 된다)
async function dsCheckFacility(ds, user, name) {
  if (ds.scope !== 'facility' || name === undefined) return null;
  const names = user.role === 'admin'
    ? [...new Set(((await sb('users?select=시설명')) || []).map(u => u.시설명).filter(Boolean))]
    : user.role === 'facility-admin' ? await managedFacilities(user.시설명) : [user.시설명];
  if (withAliases(names).includes(name)) return null;
  return user.role === 'admin' ? `"${name}" 이라는 시설이 없습니다. 시설명을 정확히 주세요` : `"${name}" 은(는) 관리 범위 밖 시설입니다`;
}

/* ── 도구 정의 ───────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'list_todos',
    description: '할 일 목록을 조회합니다. 정리·집계 등 복합 작업 전에 먼저 호출하세요.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['todo', 'done', 'all'], description: '기본 all' },
        onlyToday: { type: 'boolean', description: 'true면 오늘 해야 할 항목만' },
      },
    },
  },
  {
    name: 'search_todos',
    description: '할 일을 키워드로 검색합니다. 제목과 메모를 함께 봅니다.',
    inputSchema: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '검색어' } },
      required: ['keyword'],
    },
  },
  {
    name: 'add_todo',
    description: '새 할 일을 추가합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '할 일 제목' },
        category: { type: 'string', description: '업무/개인/기타 중 하나, 기본 업무' },
        priority: { type: 'string', enum: ['high', 'mid', 'low'], description: '기본 mid' },
        startDate: { type: 'string', description: 'YYYY-MM-DD 시작일' },
        dueDate: { type: 'string', description: 'YYYY-MM-DD 마감일' },
        startTime: { type: 'string', description: '시작 시각 HH:MM (예: 09:00)' },
        endTime: { type: 'string', description: '종료 시각 HH:MM (예: 10:30)' },
        memo: { type: 'string', description: '메모' },
      },
      required: ['title'],
    },
  },
  {
    name: 'complete_todo',
    description: '#id 또는 키워드로 할 일을 찾아 완료 처리합니다. 후보가 여럿이면 목록만 돌려주고 아무것도 바꾸지 않습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'list_todos 의 #id (주면 keyword 대신 이것으로 찾음)' },
        keyword: { type: 'string', description: '할 일 제목 키워드' },
        date: { type: 'string', description: '완료일 YYYY-MM-DD, 생략 시 오늘' },
      },
    },
  },
  {
    name: 'update_todo_due',
    description: '#id 또는 키워드로 할 일을 찾아 마감일을 바꿉니다(연기·당기기). 후보가 여럿이면 목록만 돌려줍니다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'list_todos 의 #id (주면 keyword 대신 이것으로 찾음)' },
        keyword: { type: 'string', description: '할 일 제목 키워드' },
        dueDate: { type: 'string', description: '새 마감일 YYYY-MM-DD' },
      },
      required: ['dueDate'],
    },
  },
  {
    name: 'update_todo',
    description: '#id 또는 키워드로 할 일을 찾아 내용을 고칩니다. 준 항목만 바뀝니다. 후보가 여럿이면 목록만 돌려주고 아무것도 바꾸지 않습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'list_todos 의 #id (주면 keyword 대신 이것으로 찾음)' },
        keyword: { type: 'string', description: '고칠 할 일 제목 키워드' },
        title: { type: 'string', description: '새 제목' },
        category: { type: 'string', description: '업무/개인/기타' },
        priority: { type: 'string', enum: ['high', 'mid', 'low'] },
        startDate: { type: 'string', description: 'YYYY-MM-DD, 빈 문자열이면 지움' },
        dueDate: { type: 'string', description: 'YYYY-MM-DD, 빈 문자열이면 지움' },
        startTime: { type: 'string', description: 'HH:MM' },
        endTime: { type: 'string', description: 'HH:MM' },
        memo: { type: 'string', description: '새 메모 (기존 메모를 대체)' },
        status: { type: 'string', enum: ['todo', 'done'], description: 'todo 로 주면 완료 취소' },
      },
    },
  },
  {
    name: 'delete_todo',
    description: '#id 또는 키워드로 할 일을 찾아 삭제합니다. 되돌리기 어려우므로 사용자 확인을 받은 뒤 confirm:true 로 부르세요. ' +
      '후보가 여럿이면 목록만 돌려줍니다. 결과에 지운 항목의 원래 값이 담깁니다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'list_todos 의 #id (주면 keyword 대신 이것으로 찾음)' },
        keyword: { type: 'string', description: '지울 할 일 제목 키워드' },
        confirm: { type: 'boolean', description: '사용자가 삭제를 확인했으면 true' },
      },
      required: ['confirm'],
    },
  },
  {
    name: 'get_daily_logs',
    description: '특정 날짜의 업무일지를 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD, 생략 시 오늘' } },
    },
  },
  {
    name: 'add_daily_log',
    description: '업무일지에 활동을 기록합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '활동 제목' },
        content: { type: 'string', description: '활동 내용' },
        time: { type: 'string', description: '시간대 예: 09:00~10:00' },
        date: { type: 'string', description: 'YYYY-MM-DD, 생략 시 오늘' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_daily_log',
    description: '특정 날짜 업무일지에서 제목 키워드로 활동을 찾아 고칩니다. 준 항목만 바뀝니다. 후보가 여럿이면 목록만 돌려줍니다.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '고칠 활동 제목 키워드' },
        date: { type: 'string', description: 'YYYY-MM-DD, 생략 시 오늘' },
        title: { type: 'string', description: '새 제목' },
        content: { type: 'string', description: '새 내용 (기존 내용을 대체)' },
        time: { type: 'string', description: '새 시간대 예: 09:00~10:00' },
        reflection: { type: 'string', description: '새 성찰' },
        newDate: { type: 'string', description: '다른 날짜로 옮길 때 YYYY-MM-DD' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'delete_daily_log',
    description: '특정 날짜 업무일지에서 제목 키워드로 활동을 찾아 삭제합니다. 사용자 확인을 받은 뒤 confirm:true 로 부르세요. ' +
      '후보가 여럿이면 목록만 돌려줍니다. 결과에 지운 항목의 원래 값이 담깁니다.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '지울 활동 제목 키워드' },
        date: { type: 'string', description: 'YYYY-MM-DD, 생략 시 오늘' },
        confirm: { type: 'boolean', description: '사용자가 삭제를 확인했으면 true' },
      },
      required: ['keyword', 'confirm'],
    },
  },
  {
    name: 'get_goal_progress',
    description: '개인 성과목표·시설 경영목표와 진행률을 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string', enum: ['personal', 'facility', 'all'], description: '기본 all' } },
    },
  },
  {
    name: 'add_facility_goal',
    description: '시설 경영목표를 새로 추가합니다. 달성률은 KPI 목표·실적으로 앱과 같은 방식으로 계산합니다. 시설목표 관리 권한(admin·facility-admin)이 있어야 합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '시설목표 제목' },
        kpis: {
          type: 'array',
          description: 'KPI 목록',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '지표 이름' },
              target: { type: 'number', description: '목표값' },
              actual: { type: 'number', description: '실적' },
              unit: { type: 'string', description: '단위 (예: 천원, 건, kwh)' },
              dir: { type: 'string', enum: ['up', 'down'], description: 'up=높을수록 좋음(기본), down=낮을수록 좋음' },
            },
            required: ['name'],
          },
        },
      },
      required: ['goal'],
    },
  },
  {
    name: 'update_facility_kpi',
    description: '시설 경영목표의 KPI 하나를 고칩니다(실적 입력·목표값 변경 등). 준 항목만 바뀌고 달성률은 다시 계산합니다. ' +
      '새 KPI를 넣으려면 add:true 와 함께 kpi 에 새 이름을 줍니다. 목표·KPI 키워드에 여러 건이 걸리면 목록만 돌려줍니다.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '시설목표 제목 키워드' },
        kpi: { type: 'string', description: 'KPI 이름 키워드. 목표에 KPI가 하나뿐이면 생략 가능' },
        name: { type: 'string', description: 'KPI 새 이름' },
        target: { type: ['number', 'null'], description: '새 목표값 (숫자만, 단위는 unit 에). null 이면 지움' },
        actual: { type: ['number', 'null'], description: '새 실적 (숫자만, 단위는 unit 에). null 이면 지움' },
        unit: { type: 'string', description: '단위' },
        dir: { type: 'string', enum: ['up', 'down'], description: 'up=높을수록 좋음, down=낮을수록 좋음' },
        add: { type: 'boolean', description: 'true면 kpi 이름으로 새 KPI를 추가' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'update_facility_goal',
    description: '시설 경영목표의 제목을 바꾸거나, KPI로 달성률을 계산할 수 없는 목표의 달성률(%)을 직접 고칩니다. KPI 수정은 update_facility_kpi 를 쓰세요.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '고칠 시설목표 제목 키워드' },
        goal: { type: 'string', description: '새 제목' },
        progress: { type: 'number', description: '달성률 % (KPI 실적으로 계산되는 목표에는 적용되지 않음)' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'delete_facility_goal',
    description: '시설 경영목표를 삭제합니다. kpi 를 주면 그 KPI 하나만 지웁니다. 사용자 확인을 받은 뒤 confirm:true 로 부르세요. ' +
      '후보가 여럿이면 목록만 돌려줍니다. 결과에 지운 항목의 원래 값이 담깁니다.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '시설목표 제목 키워드' },
        kpi: { type: 'string', description: '이 KPI만 지울 때 KPI 이름 키워드' },
        confirm: { type: 'boolean', description: '사용자가 삭제를 확인했으면 true' },
      },
      required: ['keyword', 'confirm'],
    },
  },
  {
    name: 'weekly_report',
    description: '이번 주(월~일) 할 일 완료·마감 통계를 집계합니다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'query_energy',
    description: '에너지(전기/가스/수도 등) 사용량과 요금을 조회·집계합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        energyType: { type: 'string', description: '에너지 종류, 생략 시 전체' },
        month: { type: 'string', description: '조회 월 YYYY-MM, 생략 시 전체 기간' },
      },
    },
  },
  {
    name: 'list_energy_records',
    description: '에너지 기록을 한 건씩 보여 줍니다(기록 번호 #id 포함). 수정·삭제 전에 이 도구로 대상 기록 번호를 확인하세요. 최근 청구월부터 나옵니다.',
    inputSchema: {
      type: 'object',
      properties: {
        energyType: { type: 'string', description: '전기/상하수도/도시가스/통신, 생략 시 전체' },
        month: { type: 'string', description: '청구월 YYYY-MM' },
        fromMonth: { type: 'string', description: '이 청구월부터 YYYY-MM' },
        toMonth: { type: 'string', description: '이 청구월까지 YYYY-MM' },
        facility: { type: 'string', description: '시설명 일부' },
        limit: { type: 'number', description: '최대 건수, 기본 30 · 최대 100' },
      },
    },
  },
  {
    name: 'update_energy_record',
    description: '에너지 기록 하나를 기록 번호(id)로 찾아 고칩니다. 준 항목만 바뀝니다. 결과에 바뀌기 전 값이 담깁니다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'list_energy_records 의 기록 번호(#뒤 숫자)' },
        facilityName: { type: 'string', description: '시설명' },
        energyType: { type: 'string', enum: ENERGY_TYPES },
        billingMonth: { type: 'string', description: '청구월 YYYY-MM' },
        startDate: { type: 'string', description: '사용 시작일 YYYY-MM-DD' },
        endDate: { type: 'string', description: '사용 종료일 YYYY-MM-DD' },
        usageAmount: { type: 'number', description: '사용량' },
        usageCost: { type: 'number', description: '요금(원)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_energy_record',
    description: '에너지 기록 하나를 기록 번호(id)로 삭제합니다. 되돌리기 어려우므로 사용자 확인을 받은 뒤 confirm:true 로 부르세요. ' +
      '결과에 지운 기록의 원래 값이 담깁니다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'list_energy_records 의 기록 번호(#뒤 숫자)' },
        confirm: { type: 'boolean', description: '사용자가 삭제를 확인했으면 true' },
      },
      required: ['id', 'confirm'],
    },
  },
  {
    name: 'list_records',
    description: '할 일·업무일지·시설목표·에너지 기록을 뺀 나머지 앱 데이터를 조회합니다. 각 줄 맨 앞 #id 로 get/update/delete_record 를 부릅니다.\n' +
      'dataset 과 항목(*는 추가할 때 필수):\n' + DATASET_HELP,
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', enum: DATASET_KEYS },
        keyword: { type: 'string', description: '제목·이름 등에서 찾을 말' },
        filter: { type: 'object', description: '항목=값 이 정확히 같은 것만 (예: {"type":"golf"}, {"year":2026})' },
        limit: { type: 'number', description: '기본 30 · 최대 200' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'get_record',
    description: 'list_records 의 #id 로 한 건의 모든 항목(긴 본문 포함)을 봅니다.',
    inputSchema: {
      type: 'object',
      properties: { dataset: { type: 'string', enum: DATASET_KEYS }, id: { type: ['string', 'number'] } },
      required: ['dataset', 'id'],
    },
  },
  {
    name: 'add_record',
    description: 'list_records 에 있는 dataset 에 새 항목을 추가합니다. values 에 항목 이름(list_records 설명 참고)과 값을 줍니다.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', enum: DATASET_KEYS },
        values: { type: 'object', description: '예: {"title":"총, 균, 쇠","author":"재레드 다이아몬드","status":"읽는중"}' },
      },
      required: ['dataset', 'values'],
    },
  },
  {
    name: 'update_record',
    description: 'list_records 의 #id 로 한 건을 찾아 values 에 준 항목만 고칩니다. 결과에 바뀌기 전 값이 담깁니다. ' +
      'org_goals(조직목표)는 공단 전체에 보이므로 먼저 미리보기만 돌려주고, 사용자 확인을 받은 뒤 같은 값과 confirm:true 로 다시 불러야 저장됩니다.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', enum: DATASET_KEYS },
        id: { type: ['string', 'number'] },
        values: { type: 'object', description: '바꿀 항목과 새 값. 빈 문자열이면 지움' },
        confirm: { type: 'boolean', description: 'org_goals 수정을 사용자가 확인했으면 true' },
      },
      required: ['dataset', 'id', 'values'],
    },
  },
  {
    name: 'delete_record',
    description: 'list_records 의 #id 로 한 건을 삭제합니다. 되돌리기 어려우므로 사용자 확인을 받은 뒤 confirm:true 로 부르세요. 결과에 지운 항목의 원래 값이 담깁니다.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', enum: DATASET_KEYS },
        id: { type: ['string', 'number'] },
        confirm: { type: 'boolean', description: '사용자가 삭제를 확인했으면 true' },
      },
      required: ['dataset', 'id', 'confirm'],
    },
  },
];

/* ── 도구 실행 ───────────────────────────────────────────────── */

// #id(앞자리) 또는 키워드로 할 일 찾기 — 정확히 하나여야 수정한다.
async function findTodoByKeyword(user, keyword, id) {
  const rows = await sb(`todos?owner_id=eq.${q(user.id)}&select=*`);
  if (id !== undefined && id !== null && id !== '') {
    const sid = String(id).replace(/^#/, '').toLowerCase();
    const hits = sid.length >= 4 ? (rows || []).filter(t => String(t.id).toLowerCase().startsWith(sid)) : [];
    if (hits.length !== 1) return { error: `할 일 #${sid} 을(를) ${hits.length ? '하나로 고를 수 없습니다' : '찾을 수 없습니다'}. list_todos 로 #id 를 확인하세요` };
    return { todo: hits[0] };
  }
  if (!keyword) return { error: 'id(list_todos 의 #id) 또는 keyword 가 필요합니다' };
  const kw = keyword.toLowerCase();
  const hits = (rows || []).filter(t => (t.title || '').toLowerCase().includes(kw));
  if (!hits.length) return { error: `"${keyword}"에 해당하는 할 일이 없습니다` };
  if (hits.length > 1) {
    return {
      error: `"${keyword}"에 ${hits.length}건이 걸립니다. 더 구체적인 키워드로 다시 시도하세요.\n` +
        hits.map(t => `• #${todoShortId(t)} ${t.title}`).join('\n') + '\n#id 로 다시 부르면 바로 고릅니다',
    };
  }
  return { todo: hits[0] };
}

// 날짜 + 제목 키워드로 업무일지 활동 찾기 — 정확히 하나여야 수정·삭제한다.
async function findLogByKeyword(user, date, keyword) {
  const rows = await sb(`daily_logs?owner_id=eq.${q(user.id)}&log_date=eq.${q(date)}&select=*`);
  const kw = (keyword || '').toLowerCase();
  const hits = (rows || []).filter(a => (a.title || '').toLowerCase().includes(kw));
  if (!hits.length) return { error: `${date} 일지에 "${keyword}"에 해당하는 활동이 없습니다` };
  if (hits.length > 1) {
    return {
      error: `${date} 일지에서 "${keyword}"에 ${hits.length}건이 걸립니다. 더 구체적인 키워드로 다시 시도하세요.\n` +
        hits.map(a => `• ${a.time_range ? a.time_range + ' ' : ''}${a.title}`).join('\n'),
    };
  }
  return { log: hits[0] };
}

/* ── 시설 경영목표 (앱 worklog-app.Html 의 _fgNum·_fgKpi·fgKpiRate·fgProgressOf 와 같게 유지) ── */

// 앱 권한표의 'goals.facility' 와 같다
const FACILITY_GOAL_ROLES = ['admin', 'facility-admin'];

function fgNum(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
// KPI는 예전 문자열과 지금의 {name,target,actual,unit,dir} 객체가 섞여 있다
function fgKpi(k) {
  if (typeof k === 'string') return { name: k, target: null, actual: null, unit: '', dir: 'up' };
  return { name: k?.name || '', target: fgNum(k?.target), actual: fgNum(k?.actual), unit: k?.unit || '', dir: k?.dir === 'down' ? 'down' : 'up' };
}
// 낮을수록 좋은 지표는 (2 - 실적/목표)로 뒤집는다. 목표가 0이면 달성/미달로만 가른다.
function fgKpiRate(k) {
  const { target, actual, dir } = fgKpi(k);
  if (target === null || actual === null) return null;
  if (dir === 'down') {
    if (target === 0) return actual <= 0 ? 100 : 0;
    return Math.max(0, Math.round((2 - actual / target) * 100));
  }
  if (target === 0) return actual >= 0 ? 100 : 0;
  return Math.max(0, Math.round(actual / target * 100));
}
// 시설목표 달성률 = 계산 가능한 KPI들의 평균. 하나도 없으면 null(손으로 넣은 값을 그대로 둔다)
function fgProgressOf(kpis) {
  const rates = (kpis || []).map(fgKpiRate).filter(r => r !== null);
  if (!rates.length) return null;
  return Math.round(rates.reduce((a, b) => a + b, 0) / rates.length);
}
function fgKpiText(k) {
  const { name, target, actual, unit, dir } = fgKpi(k);
  if (target === null && actual === null) return name;
  const rate = fgKpiRate(k);
  return `${name} (목표 ${target ?? '-'} / 실적 ${actual ?? '-'}${unit ? ' ' + unit : ''}` +
    `${rate !== null ? ` · ${rate}%` : ''}${dir === 'down' ? ' · 낮을수록 좋음' : ''})`;
}

function canEditFacilityGoals(user) {
  return FACILITY_GOAL_ROLES.includes(user.role);
}

async function findFacilityGoal(user, keyword) {
  const rows = await sb(`facility_goals?시설명=eq.${q(user.시설명)}&select=*`);
  const kw = (keyword || '').toLowerCase();
  const hits = (rows || []).filter(g => (g.goal || '').toLowerCase().includes(kw));
  if (!hits.length) return { error: `"${keyword}"에 해당하는 시설목표가 없습니다` };
  if (hits.length > 1) {
    return {
      error: `"${keyword}"에 시설목표 ${hits.length}건이 걸립니다. 더 구체적인 키워드로 다시 시도하세요.\n` +
        hits.map(g => `• ${g.goal}`).join('\n'),
    };
  }
  return { goal: hits[0] };
}

// 목표 안에서 KPI 찾기 — 키워드가 없으면 KPI가 하나뿐일 때만 그것을 고른다
function findKpiIndex(kpis, keyword) {
  if (!keyword) {
    if (kpis.length === 1) return { idx: 0 };
    return { error: `이 목표에는 KPI가 ${kpis.length}개 있습니다. kpi 로 지표 이름을 지정하세요.\n` + kpis.map(k => `• ${k.name}`).join('\n') };
  }
  const kw = keyword.toLowerCase();
  const hits = kpis.map((k, i) => [k, i]).filter(([k]) => k.name.toLowerCase().includes(kw));
  if (!hits.length) return { idx: -1 };
  if (hits.length > 1) {
    return { error: `"${keyword}"에 KPI ${hits.length}개가 걸립니다. 더 구체적으로 지정하세요.\n` + hits.map(([k]) => `• ${k.name}`).join('\n') };
  }
  return { idx: hits[0][1] };
}

// KPI 목표·실적은 숫자만 받는다 ("1,500"·"1500천원" 같은 문자열은 단위 혼동이 생겨 거절)
function kpiNumberError(key, v, allowEmpty) {
  if (allowEmpty && (v === null || v === '')) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return `${key} 는 숫자만 넣습니다 (받은 값: ${JSON.stringify(v)}). 쉼표·단위 없이 숫자로 주고 단위는 unit 에 적으세요`;
  }
  return null;
}

function cleanKpi(raw) {
  const k = fgKpi(raw);
  return { ...k, name: k.name.trim(), unit: (k.unit || '').trim() };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

async function runRecordTool(name, ds, input, ctx) {
  const { empno, user } = ctx;
  switch (name) {
    case 'list_records': {
      let path = `${ds.table}?select=*${await dsScope(ds, user)}`;
      for (const [k, v] of Object.entries(input.filter || {})) {
        if (!ds.cols[k]) return `${k} 는 ${ds.label}에 없는 항목입니다. 쓸 수 있는 항목: ${Object.keys(ds.cols).join(', ')}`;
        path += `&${encodeURIComponent(k)}=eq.${q(String(v))}`;
      }
      if (input.keyword) {
        const kw = String(input.keyword).replace(/[*,()"]/g, '');
        path += `&or=(${ds.search.map(c => `${encodeURIComponent(c)}.ilike.${q(`*${kw}*`)}`).join(',')})`;
      }
      const limit = Math.min(Math.max(Math.floor(Number(input.limit) || 30), 1), 200);
      path += `&order=${ds.order}&limit=${limit + 1}`;
      const rows = (await sb(path)) || [];
      if (!rows.length) return `조건에 맞는 ${ds.label}이(가) 없습니다`;
      const more = rows.length > limit;
      return `[${ds.label} ${more ? `${limit}건 이상` : `${rows.length}건`}]\n` +
        rows.slice(0, limit).map(r => dsFormat(ds, r)).join('\n') +
        (more ? '\n…더 있습니다. 조건을 좁히거나 limit 을 늘리세요' : '');
    }

    case 'get_record': {
      const found = await dsFind(ds, user, input.id);
      if (found.error) return found.error;
      const text = dsFormat(ds, found.row, true);
      // 지식자료 본문은 수만 자가 될 수 있다 — 대화 창을 다 먹지 않게 자른다
      return text.length > 12000 ? text.slice(0, 12000) + `\n…(이하 ${text.length - 12000}자 생략)` : text;
    }

    case 'add_record': {
      if (ds.noAdd) return `${ds.label}은(는) 추가하지 않고 update_record 로 고칩니다`;
      const c = dsCoerce(ds, input.values);
      if (c.error) return c.error;
      const values = { ...(ds.defaults || {}), ...c.values };
      const missing = Object.entries(ds.cols).filter(([k, m]) => m.required && (values[k] === undefined || values[k] === null));
      if (missing.length) return `필수 항목이 빠졌습니다: ${missing.map(([k, m]) => `${k}(${m.label})`).join(', ')}`;
      const facErr = await dsCheckFacility(ds, user, values.facility_name);
      if (facErr) return facErr;
      const row = { ...values };
      if (ds.id === 'text') row.id = crypto.randomUUID();
      if (ds.scope === 'owner') { row.owner_id = user.id; row.사원번호 = empno; }
      if (ds.table === 'knowledge_sources') row.uploaded_by = empno;
      if (ds.touch) row.updated_at = new Date().toISOString();
      const saved = await sb(ds.table, { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=representation' } });
      return `${ds.label}에 추가했습니다\n${dsFormat(ds, saved?.[0] || row)}`;
    }

    case 'update_record': {
      const found = await dsFind(ds, user, input.id);
      if (found.error) return found.error;
      const c = dsCoerce(ds, input.values);
      if (c.error) return c.error;
      const patch = c.values;
      if (!Object.keys(patch).length) return '바꿀 항목이 없습니다';
      const facErr = await dsCheckFacility(ds, user, patch.facility_name);
      if (facErr) return facErr;
      const before = found.row;
      if (ds.confirmUpdate && input.confirm !== true) {
        return `[미리보기 — 아직 저장하지 않았습니다] ${ds.label} #${before.id}\n` +
          Object.keys(patch).map(k => `• ${ds.cols[k].label}: ${dsShowValue(ds, k, before[k], true)} → ${dsShowValue(ds, k, patch[k], true)}`).join('\n') +
          '\n공단 전체에 보이는 내용입니다. 사용자 확인을 받은 뒤 같은 values 와 confirm:true 로 다시 부르세요';
      }
      const body = ds.touch ? { ...patch, updated_at: new Date().toISOString() } : patch;
      const updated = await sb(`${ds.table}?id=eq.${q(String(before.id))}${found.scope}`, {
        method: 'PATCH', body: JSON.stringify(body), headers: { Prefer: 'return=representation' },
      });
      if (!updated || !updated.length) return `#${before.id} 을(를) 고치지 못했습니다 (그 사이 지워졌을 수 있습니다)`;
      const after = updated[0];
      return `${ds.label}을(를) 고쳤습니다 — #${before.id}\n` +
        Object.keys(patch).map(k => `• ${ds.cols[k].label}: ${dsShowValue(ds, k, before[k])} → ${dsShowValue(ds, k, after[k])}`).join('\n') +
        `\n[복구용 원래 값] ${JSON.stringify(Object.fromEntries(Object.keys(patch).map(k => [k, before[k]])))}`;
    }

    case 'delete_record': {
      if (ds.noDelete) return `${ds.label}은(는) 삭제할 수 없습니다. 내용을 비우려면 update_record 를 쓰세요`;
      if (input.confirm !== true) return '삭제하려면 사용자 확인을 받은 뒤 confirm:true 로 다시 부르세요';
      const found = await dsFind(ds, user, input.id);
      if (found.error) return found.error;
      const r = found.row;
      const deleted = await sb(`${ds.table}?id=eq.${q(String(r.id))}${found.scope}`, {
        method: 'DELETE', headers: { Prefer: 'return=representation' },
      });
      if (!deleted || !deleted.length) return `#${r.id} 을(를) 지우지 못했습니다 (이미 지워졌을 수 있습니다)`;
      return `${ds.label}에서 삭제했습니다 — ${dsFormat(ds, r)}\n[복구용 원래 값] ${JSON.stringify(r)}`;
    }
  }
}

async function runTool(name, input, ctx) {
  const { empno, user } = ctx;

  switch (name) {
    case 'list_todos': {
      const status = input.status || 'all';
      const rows = (await sb(`todos?owner_id=eq.${q(user.id)}&select=*`)) || [];
      const date = todayKST();
      let list = rows;
      if (input.onlyToday) list = list.filter(t => visibleOnDate(t, date));
      if (status === 'todo') list = list.filter(t => !isDoneOnDate(t, date) && t.status !== 'done');
      else if (status === 'done') list = list.filter(t => t.status === 'done' || isDoneOnDate(t, date));
      if (!list.length) return '조건에 맞는 할 일이 없습니다';
      list.sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
      return `할 일 ${list.length}건\n` + list.map(t => formatTodo(t, date)).join('\n');
    }

    case 'search_todos': {
      const rows = (await sb(`todos?owner_id=eq.${q(user.id)}&select=*`)) || [];
      const kw = (input.keyword || '').toLowerCase();
      const date = todayKST();
      const hits = rows.filter(t =>
        (t.title || '').toLowerCase().includes(kw) || (t.memo || '').toLowerCase().includes(kw));
      if (!hits.length) return `"${input.keyword}" 검색 결과가 없습니다`;
      return `검색 결과 ${hits.length}건\n` + hits.map(t => formatTodo(t, date)).join('\n');
    }

    case 'add_todo': {
      if (!input.title) return '할 일 제목이 필요합니다';
      const row = {
        id: crypto.randomUUID(),
        사원번호: empno,
        owner_id: user.id,
        title: input.title,
        category: input.category || '업무',
        priority: input.priority || 'mid',
        status: 'todo',
        start_date: input.startDate || null,
        due_date: input.dueDate || null,
        time_range: [input.startTime, input.endTime].filter(Boolean).join('~'),
        memo: input.memo || '',
        is_recurring: false,
        recurring_days: [],
        completed_dates: [],
        completed_date: null,
      };
      await sb('todos', { method: 'POST', body: JSON.stringify(row) });
      const detail = [row.time_range, row.due_date && `마감 ${row.due_date}`].filter(Boolean).join(' · ');
      return `추가했습니다 — ${row.title}` + (detail ? ` (${detail})` : '');
    }

    case 'complete_todo': {
      const found = await findTodoByKeyword(user, input.keyword, input.id);
      if (found.error) return found.error;
      const t = found.todo;
      const date = input.date || todayKST();
      const patch = t.is_recurring
        ? { completed_dates: [...new Set([...(t.completed_dates || []), date])] }
        : { status: 'done', completed_date: date };
      await sb(`todos?id=eq.${q(t.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return `완료 처리했습니다 — ${t.title} (${date})`;
    }

    case 'update_todo_due': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate || '')) return '마감일은 YYYY-MM-DD 형식이어야 합니다';
      const found = await findTodoByKeyword(user, input.keyword, input.id);
      if (found.error) return found.error;
      const t = found.todo;
      await sb(`todos?id=eq.${q(t.id)}`, { method: 'PATCH', body: JSON.stringify({ due_date: input.dueDate }) });
      return `마감일을 바꿨습니다 — ${t.title}: ${t.due_date || '없음'} → ${input.dueDate}`;
    }

    case 'update_todo': {
      const found = await findTodoByKeyword(user, input.keyword, input.id);
      if (found.error) return found.error;
      const t = found.todo;
      const patch = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.category !== undefined) patch.category = input.category;
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.memo !== undefined) patch.memo = input.memo;
      for (const [key, col] of [['startDate', 'start_date'], ['dueDate', 'due_date']]) {
        if (input[key] === undefined) continue;
        if (input[key] && !DATE_RE.test(input[key])) return `${key} 는 YYYY-MM-DD 형식이어야 합니다`;
        patch[col] = input[key] || null;
      }
      if (input.startTime !== undefined || input.endTime !== undefined) {
        const [s0 = '', e0 = ''] = (t.time_range || '').split('~');
        const st = input.startTime ?? s0, et = input.endTime ?? e0;
        if ((st && !TIME_RE.test(st)) || (et && !TIME_RE.test(et))) return '시각은 HH:MM 형식이어야 합니다';
        patch.time_range = [st, et].filter(Boolean).join('~');
      }
      if (input.status === 'todo') {
        if (t.is_recurring) patch.completed_dates = (t.completed_dates || []).filter(d => d !== todayKST());
        else { patch.status = 'todo'; patch.completed_date = null; }
      } else if (input.status === 'done') {
        if (t.is_recurring) patch.completed_dates = [...new Set([...(t.completed_dates || []), todayKST()])];
        else { patch.status = 'done'; patch.completed_date = todayKST(); }
      }
      if (!Object.keys(patch).length) return '바꿀 항목이 없습니다';
      await sb(`todos?id=eq.${q(t.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return `고쳤습니다 — ${t.title}\n바뀐 항목: ${Object.keys(patch).join(', ')}`;
    }

    case 'delete_todo': {
      if (input.confirm !== true) return '삭제하려면 사용자 확인을 받은 뒤 confirm:true 로 다시 부르세요';
      const found = await findTodoByKeyword(user, input.keyword, input.id);
      if (found.error) return found.error;
      const t = found.todo;
      await sb(`todos?id=eq.${q(t.id)}&owner_id=eq.${q(user.id)}`, { method: 'DELETE' });
      return `삭제했습니다 — ${t.title}\n[복구용 원래 값] ${JSON.stringify(t)}`;
    }

    case 'update_daily_log': {
      const date = input.date || todayKST();
      if (!DATE_RE.test(date)) return '날짜는 YYYY-MM-DD 형식이어야 합니다';
      const found = await findLogByKeyword(user, date, input.keyword);
      if (found.error) return found.error;
      const a = found.log;
      const patch = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.content !== undefined) patch.content = input.content;
      if (input.time !== undefined) patch.time_range = input.time;
      if (input.reflection !== undefined) patch.reflection = input.reflection;
      if (input.newDate !== undefined) {
        if (!DATE_RE.test(input.newDate)) return 'newDate 는 YYYY-MM-DD 형식이어야 합니다';
        patch.log_date = input.newDate;
      }
      if (!Object.keys(patch).length) return '바꿀 항목이 없습니다';
      await sb(`daily_logs?id=eq.${q(a.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return `${date} 일지를 고쳤습니다 — ${a.title}\n바뀐 항목: ${Object.keys(patch).join(', ')}`;
    }

    case 'delete_daily_log': {
      if (input.confirm !== true) return '삭제하려면 사용자 확인을 받은 뒤 confirm:true 로 다시 부르세요';
      const date = input.date || todayKST();
      if (!DATE_RE.test(date)) return '날짜는 YYYY-MM-DD 형식이어야 합니다';
      const found = await findLogByKeyword(user, date, input.keyword);
      if (found.error) return found.error;
      const a = found.log;
      await sb(`daily_logs?id=eq.${q(a.id)}&owner_id=eq.${q(user.id)}`, { method: 'DELETE' });
      return `${date} 일지에서 삭제했습니다 — ${a.title}\n[복구용 원래 값] ${JSON.stringify(a)}`;
    }

    case 'get_daily_logs': {
      const date = input.date || todayKST();
      const rows = (await sb(
        `daily_logs?owner_id=eq.${q(user.id)}&log_date=eq.${q(date)}&select=*`)) || [];
      if (!rows.length) return `${date} 에 기록된 일지가 없습니다`;
      return `[${date} 업무일지 ${rows.length}건]\n` + rows.map(a =>
        `• ${a.time_range ? a.time_range + ' ' : ''}${a.title}` +
        (a.content ? `\n    ${a.content}` : '') +
        (a.reflection ? `\n    성찰: ${a.reflection}` : '')).join('\n');
    }

    case 'add_daily_log': {
      if (!input.title) return '활동 제목이 필요합니다';
      const date = input.date || todayKST();
      const row = {
        id: crypto.randomUUID(),
        사원번호: empno,
        owner_id: user.id,
        log_date: date,
        title: input.title,
        time_range: input.time || '',
        linked_task: '',
        content: input.content || '',
        reflection: '',
      };
      await sb('daily_logs', { method: 'POST', body: JSON.stringify(row) });
      return `${date} 일지에 기록했습니다 — ${row.title}`;
    }

    case 'get_goal_progress': {
      const scope = input.scope || 'all';
      const out = [];
      if (scope === 'all' || scope === 'personal') {
        const rows = (await sb(`personal_goals?owner_id=eq.${q(user.id)}&select=*`)) || [];
        out.push(rows.length
          ? '[개인 성과목표]\n' + rows.map(g =>
              `• ${g.goal} — ${g.progress || 0}%` +
              ((g.kpis || []).length ? `\n    KPI: ${(g.kpis || []).join(', ')}` : '') +
              (g.linked ? `\n    연계: ${g.linked}` : '')).join('\n')
          : '[개인 성과목표] 등록된 목표가 없습니다');
      }
      if (scope === 'all' || scope === 'facility') {
        const rows = (await sb(`facility_goals?시설명=eq.${q(user.시설명)}&select=*`)) || [];
        out.push(rows.length
          ? '[시설 경영목표]\n' + rows.map(g =>
              `• ${g.goal} — ${g.progress || 0}%` +
              ((g.kpis || []).length ? `\n    KPI: ${(g.kpis || []).map(fgKpiText).join(', ')}` : '')).join('\n')
          : '[시설 경영목표] 등록된 목표가 없습니다');
      }
      return out.join('\n\n');
    }

    case 'add_facility_goal': {
      if (!canEditFacilityGoals(user)) return '시설목표 관리 권한(admin·facility-admin)이 없습니다';
      const goal = (input.goal || '').trim();
      if (!goal) return '시설목표 제목이 필요합니다';
      for (const [i, raw] of (Array.isArray(input.kpis) ? input.kpis : []).entries()) {
        for (const key of ['target', 'actual']) {
          const err = raw && typeof raw === 'object' && raw[key] !== undefined && kpiNumberError(`kpis[${i}].${key}`, raw[key], true);
          if (err) return err;
        }
      }
      const kpis = (Array.isArray(input.kpis) ? input.kpis : []).map(cleanKpi).filter(k => k.name);
      const row = {
        id: crypto.randomUUID(),
        시설명: user.시설명,
        goal,
        kpis,
        progress: fgProgressOf(kpis) ?? 0,
        linked_strategy_goal: '',
        linked_strategy_task: '',
      };
      await sb('facility_goals', { method: 'POST', body: JSON.stringify(row) });
      return `시설목표를 추가했습니다 — ${goal} (${row.progress}%)` +
        (kpis.length ? '\n' + kpis.map(k => `• ${fgKpiText(k)}`).join('\n') : '');
    }

    case 'update_facility_kpi': {
      if (!canEditFacilityGoals(user)) return '시설목표 관리 권한(admin·facility-admin)이 없습니다';
      const found = await findFacilityGoal(user, input.goal);
      if (found.error) return found.error;
      const g = found.goal;
      const kpis = (g.kpis || []).map(fgKpi);
      let idx, added = false;
      if (input.add === true) {
        if (!(input.kpi || '').trim()) return '새 KPI 이름(kpi)이 필요합니다';
        if (kpis.some(k => k.name === input.kpi.trim())) return `${g.goal} 에 이미 "${input.kpi.trim()}" KPI가 있습니다`;
        idx = -1;
      } else {
        const pick = findKpiIndex(kpis, input.kpi);
        if (pick.error) return pick.error;
        if (pick.idx === -1) {
          return `${g.goal} 에 "${input.kpi}" KPI가 없습니다. 새로 넣으려면 add:true 로 부르세요.\n` + kpis.map(k => `• ${k.name}`).join('\n');
        }
        idx = pick.idx;
      }
      if (idx === -1) {
        kpis.push({ name: input.kpi.trim(), target: null, actual: null, unit: '', dir: 'up' });
        idx = kpis.length - 1;
        added = true;
      }
      const k = kpis[idx];
      const before = fgKpiText(k);
      for (const key of ['target', 'actual']) {
        if (input[key] === undefined) continue;
        const err = kpiNumberError(key, input[key], true);
        if (err) return err;
        k[key] = input[key] === null || input[key] === '' ? null : input[key];
      }
      if (input.name !== undefined && input.name.trim()) k.name = input.name.trim();
      if (input.unit !== undefined) k.unit = input.unit.trim();
      if (input.dir !== undefined) k.dir = input.dir === 'down' ? 'down' : 'up';
      const progress = fgProgressOf(kpis) ?? (g.progress || 0);
      await sb(`facility_goals?id=eq.${q(g.id)}&시설명=eq.${q(user.시설명)}`, {
        method: 'PATCH', body: JSON.stringify({ kpis, progress }),
      });
      return `${g.goal} — KPI를 ${added ? '추가했' : '고쳤'}습니다\n` +
        (added ? '' : `이전: ${before}\n`) + `지금: ${fgKpiText(k)}\n` +
        `목표 달성률: ${g.progress || 0}% → ${progress}%`;
    }

    case 'update_facility_goal': {
      if (!canEditFacilityGoals(user)) return '시설목표 관리 권한(admin·facility-admin)이 없습니다';
      const found = await findFacilityGoal(user, input.keyword);
      if (found.error) return found.error;
      const g = found.goal;
      const patch = {};
      if (input.goal !== undefined && input.goal.trim()) patch.goal = input.goal.trim();
      if (input.progress !== undefined) {
        if (fgProgressOf(g.kpis) !== null) return '이 목표의 달성률은 KPI 실적으로 계산됩니다. update_facility_kpi 로 실적을 고치세요';
        const p = fgNum(input.progress);
        if (p === null || p < 0) return '달성률은 0 이상의 숫자여야 합니다';
        patch.progress = Math.round(p);
      }
      if (!Object.keys(patch).length) return '바꿀 항목이 없습니다';
      await sb(`facility_goals?id=eq.${q(g.id)}&시설명=eq.${q(user.시설명)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return `시설목표를 고쳤습니다 — ${g.goal}` +
        (patch.goal ? `\n제목: ${g.goal} → ${patch.goal}` : '') +
        (patch.progress !== undefined ? `\n달성률: ${g.progress || 0}% → ${patch.progress}%` : '');
    }

    case 'delete_facility_goal': {
      if (!canEditFacilityGoals(user)) return '시설목표 관리 권한(admin·facility-admin)이 없습니다';
      if (input.confirm !== true) return '삭제하려면 사용자 확인을 받은 뒤 confirm:true 로 다시 부르세요';
      const found = await findFacilityGoal(user, input.keyword);
      if (found.error) return found.error;
      const g = found.goal;
      if (input.kpi) {
        const kpis = (g.kpis || []).map(fgKpi);
        const pick = findKpiIndex(kpis, input.kpi);
        if (pick.error) return pick.error;
        if (pick.idx === -1) return `${g.goal} 에 "${input.kpi}" KPI가 없습니다`;
        const [removed] = kpis.splice(pick.idx, 1);
        const progress = fgProgressOf(kpis) ?? (g.progress || 0);
        await sb(`facility_goals?id=eq.${q(g.id)}&시설명=eq.${q(user.시설명)}`, {
          method: 'PATCH', body: JSON.stringify({ kpis, progress }),
        });
        return `${g.goal} 에서 KPI를 삭제했습니다 — ${removed.name}\n목표 달성률: ${g.progress || 0}% → ${progress}%\n` +
          `[복구용 원래 값] ${JSON.stringify(removed)}`;
      }
      await sb(`facility_goals?id=eq.${q(g.id)}&시설명=eq.${q(user.시설명)}`, { method: 'DELETE' });
      return `시설목표를 삭제했습니다 — ${g.goal}\n[복구용 원래 값] ${JSON.stringify(g)}`;
    }

    case 'weekly_report': {
      const rows = (await sb(`todos?owner_id=eq.${q(user.id)}&select=*`)) || [];
      const base = todayKST();
      const dow = (new Date(base + 'T00:00:00Z').getUTCDay() + 6) % 7;   // 월요일=0
      const monday = shiftDate(base, -dow);
      let done = 0, due = 0;
      const days = [];
      for (let i = 0; i < 7; i++) {
        const ds = shiftDate(monday, i);
        const dn = rows.filter(t => isDoneOnDate(t, ds)).length;
        done += dn;
        due += rows.filter(t => t.due_date === ds).length;
        days.push(`${ds.slice(5)} ${dn}건`);
      }
      const open = rows.filter(t => t.status === 'todo' && !t.is_recurring).length;
      return `이번 주(${monday} ~ ${shiftDate(monday, 6)})\n` +
        `완료 ${done}건 · 마감 예정 ${due}건 · 미완료 누적 ${open}건\n` +
        `일별 완료: ${days.join(' / ')}`;
    }

    case 'query_energy': {
      const scope = await energyScope(user);
      const scopeLabel = scope.label;
      let path = 'energy_records?select=*' + scope.filter;
      if (input.energyType) path += energyTypeFilter(input.energyType);
      if (input.month) path += `&billing_month=eq.${q(input.month)}`;
      const rows = (await sb(path)) || [];
      if (!rows.length) return '해당 조건의 에너지 기록이 없습니다';
      const byType = {};
      for (const r of rows) {
        const k = energyTypeOf(r.energy_type);
        byType[k] = byType[k] || { usage: 0, cost: 0, n: 0 };
        byType[k].usage += parseFloat(r.usage_amount) || 0;
        byType[k].cost += parseFloat(r.usage_cost) || 0;
        byType[k].n++;
      }
      const period = input.month ? input.month : '전체 기간';
      return `[${scopeLabel} 에너지 — ${period}]\n` + Object.entries(byType).map(([k, v]) =>
        `• ${k}: 사용량 ${v.usage.toLocaleString('ko-KR')} · 요금 ${Math.round(v.cost).toLocaleString('ko-KR')}원 (${v.n}건)`
      ).join('\n');
    }

    case 'list_energy_records': {
      const scope = await energyScope(user);
      let path = 'energy_records?select=*' + scope.filter;
      for (const key of ['month', 'fromMonth', 'toMonth']) {
        if (input[key] && !MONTH_RE.test(input[key])) return `${key} 는 YYYY-MM 형식이어야 합니다`;
      }
      if (input.energyType) path += energyTypeFilter(input.energyType);
      if (input.month) path += `&billing_month=eq.${q(input.month)}`;
      if (input.fromMonth) path += `&billing_month=gte.${q(input.fromMonth)}`;
      if (input.toMonth) path += `&billing_month=lte.${q(input.toMonth)}`;
      if (input.facility) path += `&facility_name=ilike.${q(`*${input.facility.replace(/[*,()]/g, '')}*`)}`;
      const limit = Math.min(Math.max(Math.floor(Number(input.limit) || 30), 1), 100);
      path += `&order=billing_month.desc.nullslast,facility_name.asc,id.desc&limit=${limit + 1}`;
      const rows = (await sb(path)) || [];
      if (!rows.length) return '해당 조건의 에너지 기록이 없습니다';
      const more = rows.length > limit;
      return `[${scope.label} 에너지 기록 ${more ? `${limit}건 이상` : `${rows.length}건`}]\n` +
        rows.slice(0, limit).map(formatEnergyRecord).join('\n') +
        (more ? `\n…더 있습니다. 조건을 좁히거나 limit 을 늘리세요` : '');
    }

    case 'update_energy_record': {
      const found = await findEnergyRecord(user, input.id);
      if (found.error) return found.error;
      const r = found.record;
      const patch = {};
      if (input.facilityName !== undefined) {
        const f = input.facilityName.trim();
        if (!f) return '시설명은 비울 수 없습니다';
        // 없는 시설명(오타)이나 범위 밖 시설로 옮기면 그 뒤로는 다시 볼 수도 고칠 수도 없게 된다
        const names = user.role === 'admin'
          ? [...new Set(((await sb('users?select=시설명')) || []).map(u => u.시설명).filter(Boolean))]
          : user.role === 'facility-admin' ? await managedFacilities(user.시설명) : [user.시설명];
        if (!withAliases(names).includes(f)) {
          return user.role === 'admin'
            ? `"${f}" 이라는 시설이 없습니다. 시설명을 정확히 주세요`
            : `"${f}" 은(는) 관리 범위 밖 시설이라 옮길 수 없습니다`;
        }
        patch.facility_name = f;
      }
      if (input.energyType !== undefined) {
        const t = energyTypeOf(input.energyType.trim());
        if (!ENERGY_TYPES.includes(t)) return `에너지 종류는 ${ENERGY_TYPES.join('/')} 중 하나여야 합니다`;
        patch.energy_type = t;
      }
      if (input.billingMonth !== undefined) {
        if (!MONTH_RE.test(input.billingMonth)) return 'billingMonth 는 YYYY-MM 형식이어야 합니다';
        patch.billing_month = input.billingMonth;
      }
      for (const [key, col] of [['startDate', 'start_date'], ['endDate', 'end_date']]) {
        if (input[key] === undefined) continue;
        if (!DATE_RE.test(input[key])) return `${key} 는 YYYY-MM-DD 형식이어야 합니다`;
        patch[col] = input[key];
      }
      const start = patch.start_date ?? r.start_date, end = patch.end_date ?? r.end_date;
      if (start && end && start > end) return `사용 기간이 거꾸로입니다 (${start} ~ ${end})`;
      for (const [key, col] of [['usageAmount', 'usage_amount'], ['usageCost', 'usage_cost']]) {
        if (input[key] === undefined) continue;
        const v = fgNum(input[key]);
        if (v === null || v < 0) return `${key} 는 0 이상의 숫자여야 합니다`;
        patch[col] = v;
      }
      if (!Object.keys(patch).length) return '바꿀 항목이 없습니다';
      const updated = await sb(`energy_records?id=eq.${r.id}${found.scope.filter}`, {
        method: 'PATCH', body: JSON.stringify(patch), headers: { Prefer: 'return=representation' },
      });
      if (!updated || !updated.length) return `#${r.id} 기록을 고치지 못했습니다 (그 사이 지워졌을 수 있습니다)`;
      const LABEL = { facility_name: '시설', energy_type: '종류', billing_month: '청구월', start_date: '시작일', end_date: '종료일', usage_amount: '사용량', usage_cost: '요금' };
      return `에너지 기록을 고쳤습니다\n이전: ${formatEnergyRecord(r)}\n지금: ${formatEnergyRecord(updated[0])}\n` +
        Object.keys(patch).map(c => `• ${LABEL[c]}: ${r[c] ?? '-'} → ${updated[0][c] ?? '-'}`).join('\n') +
        `\n[복구용 원래 값] ${JSON.stringify(r)}`;
    }

    case 'delete_energy_record': {
      if (input.confirm !== true) return '삭제하려면 사용자 확인을 받은 뒤 confirm:true 로 다시 부르세요';
      const found = await findEnergyRecord(user, input.id);
      if (found.error) return found.error;
      const r = found.record;
      const deleted = await sb(`energy_records?id=eq.${r.id}${found.scope.filter}`, {
        method: 'DELETE', headers: { Prefer: 'return=representation' },
      });
      if (!deleted || !deleted.length) return `#${r.id} 기록을 지우지 못했습니다 (이미 지워졌을 수 있습니다)`;
      return `에너지 기록을 삭제했습니다 — ${formatEnergyRecord(r)}\n[복구용 원래 값] ${JSON.stringify(r)}`;
    }

    case 'list_records':
    case 'get_record':
    case 'add_record':
    case 'update_record':
    case 'delete_record': {
      const ds = DATASETS[input.dataset];
      if (!ds) return `dataset 은 ${DATASET_KEYS.join('/')} 중 하나여야 합니다`;
      const writing = !['list_records', 'get_record'].includes(name);
      if (!dsRoleOk(ds, user, writing ? 'write' : 'read')) {
        return `${ds.label}을(를) ${writing ? '고칠' : '볼'} 권한이 없습니다 (${(writing ? ds.write || ds.read : ds.read).join('·')} 전용)`;
      }
      return runRecordTool(name, ds, input, ctx);
    }

    default:
      return `알 수 없는 도구입니다: ${name}`;
  }
}

/* ── MCP 서버 ────────────────────────────────────────────────── */

function buildServer(ctx) {
  const server = new Server(
    { name: 'worklog', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const text = await runTool(name, args || {}, ctx);
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      // 도구 실패는 프로토콜 오류가 아니라 결과로 돌려줘야 모델이 상황을 읽고 대응한다
      return { content: [{ type: 'text', text: `오류: ${e.message}` }], isError: true };
    }
  });

  return server;
}

export default async function handler(req, res) {
  const secret = process.env.MCP_SECRET;
  const empno = process.env.MCP_EMPNO;
  const facility = process.env.MCP_FACILITY;

  if (!secret || !empno) {
    res.status(500).json({ error: 'MCP_SECRET / MCP_EMPNO 환경변수가 설정되지 않았습니다' });
    return;
  }
  // 경로의 비밀값이 곧 인증 — 길이가 같을 때만 비교가 의미 있으므로 단순 비교로 충분하다
  if (req.query.secret !== secret) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  // 이 개정판 이전 클라이언트가 쓰던 GET(SSE)·DELETE(세션 종료)는 지원하지 않는다
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let transport;
  try {
    const user = await getUser(empno, facility);
    const server = buildServer({ empno, user });
    // 서버리스는 요청마다 새 인스턴스 → 세션 없는 무상태 모드 + SSE 대신 단일 JSON 응답
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[mcp]', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  } finally {
    try { await transport?.close(); } catch (_) {}
  }
}
