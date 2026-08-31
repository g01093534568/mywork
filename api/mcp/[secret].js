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
//   SUPABASE_KEY     선택. 없으면 앱의 anon 키를 쓴다. RLS를 정리한 뒤에는 service_role 키를 넣는다
//
// 삭제 도구는 일부러 없다 — 되돌리기 어려운 작업은 앱에서 직접 하도록 남겨둔다.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SB_URL = process.env.SUPABASE_URL || 'https://zbcnfixbkqtrjxvatvss.supabase.co';
// 앱 HTML에 이미 공개돼 있는 anon 키 — service_role로 올리기 전까지의 기본값
const SB_KEY = process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpiY25maXhia3F0cmp4dmF0dnNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzODM1MjYsImV4cCI6MjA5NTk1OTUyNn0.r2W70mUhk0EaCVJaVZDHE3Yop_S66aLjPknWdpvdlDY';

const SB_TIMEOUT_MS = 15000;

/* ── Supabase REST ───────────────────────────────────────────── */

async function sb(path, opts = {}) {
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

function formatTodo(t, date) {
  const done = isDoneOnDate(t, date);
  const bits = [t.category || '업무', PRIORITY_LABEL[t.priority] || '중간'];
  if (t.time_range) bits.push(t.time_range);
  if (t.due_date) bits.push(`마감 ${t.due_date}`);
  if (t.is_recurring) bits.push('반복');
  return `${done ? '[완료]' : '[ ]'} ${t.title} (${bits.join(' · ')})`;
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
async function managedFacilities(facility) {
  const [own, child] = await Promise.all([
    sb(`users?시설명=eq.${q(facility)}&select=시설명`),
    sb(`users?parent_facility=eq.${q(facility)}&select=시설명`),
  ]);
  return [...new Set([...(own || []), ...(child || [])].map(u => u.시설명).filter(Boolean))];
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
    description: '키워드로 할 일을 찾아 완료 처리합니다. 후보가 여럿이면 목록만 돌려주고 아무것도 바꾸지 않습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '할 일 제목 키워드' },
        date: { type: 'string', description: '완료일 YYYY-MM-DD, 생략 시 오늘' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'update_todo_due',
    description: '키워드로 할 일을 찾아 마감일을 바꿉니다(연기·당기기). 후보가 여럿이면 목록만 돌려줍니다.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '할 일 제목 키워드' },
        dueDate: { type: 'string', description: '새 마감일 YYYY-MM-DD' },
      },
      required: ['keyword', 'dueDate'],
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
    name: 'get_goal_progress',
    description: '개인 성과목표·시설 경영목표와 진행률을 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string', enum: ['personal', 'facility', 'all'], description: '기본 all' } },
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
];

/* ── 도구 실행 ───────────────────────────────────────────────── */

// 키워드로 할 일 찾기 — 정확히 하나여야 수정한다.
async function findTodoByKeyword(user, keyword) {
  const rows = await sb(`todos?owner_id=eq.${q(user.id)}&select=*`);
  const kw = keyword.toLowerCase();
  const hits = (rows || []).filter(t => (t.title || '').toLowerCase().includes(kw));
  if (!hits.length) return { error: `"${keyword}"에 해당하는 할 일이 없습니다` };
  if (hits.length > 1) {
    return {
      error: `"${keyword}"에 ${hits.length}건이 걸립니다. 더 구체적인 키워드로 다시 시도하세요.\n` +
        hits.map(t => `• ${t.title}`).join('\n'),
    };
  }
  return { todo: hits[0] };
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
      const found = await findTodoByKeyword(user, input.keyword);
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
      const found = await findTodoByKeyword(user, input.keyword);
      if (found.error) return found.error;
      const t = found.todo;
      await sb(`todos?id=eq.${q(t.id)}`, { method: 'PATCH', body: JSON.stringify({ due_date: input.dueDate }) });
      return `마감일을 바꿨습니다 — ${t.title}: ${t.due_date || '없음'} → ${input.dueDate}`;
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
              ((g.kpis || []).length ? `\n    KPI: ${(g.kpis || []).join(', ')}` : '')).join('\n')
          : '[시설 경영목표] 등록된 목표가 없습니다');
      }
      return out.join('\n\n');
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
      // 앱과 같은 역할별 범위: admin은 전체, facility-admin은 관리 시설, user는 본인 시설
      let path = 'energy_records?select=*';
      let scopeLabel = user.시설명;
      if (user.role === 'admin') {
        scopeLabel = '전체 시설';
      } else if (user.role === 'facility-admin') {
        const names = await managedFacilities(user.시설명);
        if (!names.length) return '관리 중인 시설이 없습니다';
        path += `&facility_name=in.(${names.map(n => `"${n.replace(/"/g, '""')}"`).join(',')})`;
        scopeLabel = `${user.시설명} 외 ${names.length - 1}곳`;
      } else {
        path += `&facility_name=eq.${q(user.시설명)}`;
      }
      if (input.energyType) path += `&energy_type=eq.${q(input.energyType)}`;
      if (input.month) path += `&billing_month=eq.${q(input.month)}`;
      const rows = (await sb(path)) || [];
      if (!rows.length) return '해당 조건의 에너지 기록이 없습니다';
      const byType = {};
      for (const r of rows) {
        const k = r.energy_type || '기타';
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
