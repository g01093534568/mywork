// 고지서 파일·실행 기록 보관 — Supabase Storage 의 비공개 버킷 'bills'
//
// 브라우저는 이 버킷에 직접 닿지 않는다(anon 정책 없음). 서버 함수가 service_role 키로 올리고,
// 볼 때는 5분짜리 서명 URL 을 내준다. 버킷은 처음 쓸 때 서버가 만든다 — SQL 이 필요 없다.
//
//   records/{energy_records.id}          그 기록의 고지서 원본 (PDF·사진)
//   runs/water-bill/{시각}.json          매월 10일 자동 처리 결과

const SB_URL = process.env.SUPABASE_URL || 'https://zbcnfixbkqtrjxvatvss.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = 'bills';
const API = `${SB_URL}/storage/v1`;
const auth = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

export const storageEnabled = () => !!SB_KEY;

let bucketOk = false;
async function ensureBucket() {
  if (bucketOk) return;
  const res = await fetch(`${API}/bucket`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 15 * 1024 * 1024 }),
  });
  // 이미 있으면 400/409 (메시지: already exists)
  if (!res.ok) {
    const t = await res.text();
    if (!/exists|Duplicate/i.test(t)) throw new Error(`버킷 생성 실패 ${res.status}: ${t.slice(0, 200)}`);
  }
  bucketOk = true;
}

export async function putObject(path, body, contentType) {
  await ensureBucket();
  const res = await fetch(`${API}/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': contentType, 'x-upsert': 'true' },
    body,
  });
  if (!res.ok) throw new Error(`파일 저장 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function getObject(path) {
  const res = await fetch(`${API}/object/${BUCKET}/${path}`, { headers: auth });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`파일 읽기 실패 ${res.status}`);
  return res;
}

// prefix 아래 파일 이름 전부 (1000개씩 넘겨 가며)
export async function listNames(prefix, { newestFirst = false, max = Infinity } = {}) {
  await ensureBucket();
  const names = [];
  for (let offset = 0; names.length < max; offset += 1000) {
    const res = await fetch(`${API}/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: prefix.replace(/\/$/, ''), limit: Math.min(1000, max - names.length), offset,
        sortBy: { column: 'name', order: newestFirst ? 'desc' : 'asc' } }),
    });
    if (!res.ok) throw new Error(`목록 읽기 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    names.push(...page.filter(o => o.id).map(o => o.name));   // id 없는 항목은 하위 폴더
    if (page.length < 1000) break;
  }
  return names;
}

export async function signedUrl(path, expiresIn = 300) {
  const res = await fetch(`${API}/object/sign/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`링크 만들기 실패 ${res.status}`);
  const { signedURL } = await res.json();
  return `${API}${signedURL}`;
}

// ── 실행 기록 ──
const runPath = (job, at = new Date()) => `runs/${job}/${at.toISOString().replace(/[:.]/g, '-')}.json`;

export async function saveRun(job, data) {
  await putObject(runPath(job), JSON.stringify({ job, at: new Date().toISOString(), ...data }), 'application/json');
}

export async function latestRuns(job, n = 5) {
  const names = await listNames(`runs/${job}/`, { newestFirst: true, max: n });
  const out = [];
  for (const name of names) {
    const res = await getObject(`runs/${job}/${name}`);
    if (res) out.push(await res.json());
  }
  return out;
}
