#!/bin/bash
# ─────────────────────────────────────────────────────────────
# DB 계층 우회 점검
#
# 왜 필요한가:
#   worklog-app.Html 은 한 파일이라 같은 규칙이 여러 곳에 복제되기 쉽다.
#   실제로 골프 훈련기록(owner_id 누락)과 시설 추가(users 캐시 미갱신)가
#   같은 원인 — SB.from(...) 을 직접 부른 것 — 으로 깨졌다.
#
#   두 가지가 DB 계층(const DB = {...}) 안에서만 처리된다:
#     · owner_id 부여      — 빠지면 저장은 되는데 목록에서 사라진다
#     · _cd() 캐시 무효화  — 빠지면 화면이 옛 목록을 계속 보여준다
#   그래서 아래 테이블에 대한 쓰기는 DB 계층 밖에서 일어나면 안 된다.
#
#   에너지 테이블(energy_records / energy_info / vehicle_info)은 캐시도
#   owner_id 도 쓰지 않아 대상이 아니다. 나중에 캐시를 붙이면 여기 추가할 것.
#
# 사용:  bash scripts/check-db-layer.sh
#        통과하면 0, 우회가 있으면 1 을 돌려준다.
# ─────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")/.." || exit 1

FILE="worklog-app.Html"
TABLES="users|todos|daily_logs|personal_goals|facility_goals|annual_goals|stocks|trades|funds|books|exercises|vocab_progress|knowledge_sources|org_goals"

# DB 계층의 범위 — 'const DB = {' 부터 그 객체가 닫히는 줄까지
START=$(grep -n '^const DB = {' "$FILE" | head -1 | cut -d: -f1)
if [ -z "$START" ]; then
  echo "✗ DB 계층(const DB = {)을 찾지 못했습니다. 이 스크립트를 손봐야 합니다."
  exit 1
fi
END=$(awk -v s="$START" 'NR>s && /^};/{print NR; exit}' "$FILE")
if [ -z "$END" ]; then
  echo "✗ DB 계층의 끝을 찾지 못했습니다. 이 스크립트를 손봐야 합니다."
  exit 1
fi

HITS=$(grep -nE "SB\.from\(['\"]($TABLES)['\"]\)\.(insert|update|upsert|delete)" "$FILE" \
       | awk -F: -v s="$START" -v e="$END" '$1 < s || $1 > e')

if [ -n "$HITS" ]; then
  echo "✗ DB 계층(${START}~${END}행) 밖에서 데이터를 직접 쓰고 있습니다."
  echo
  echo "$HITS" | sed 's/^/    /'
  echo
  echo "  DB.upsertXxx / DB.deleteXxx 를 쓰세요. 없으면 DB 계층에 만들어 쓰세요."
  echo "  직접 쓰면 owner_id 가 빠지거나 캐시가 남아 '저장했는데 안 보인다'가 됩니다."
  exit 1
fi

echo "✓ DB 계층 우회 없음 (검사 범위: ${START}~${END}행 밖의 쓰기 호출)"
exit 0
