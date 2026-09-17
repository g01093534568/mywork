-- 옛 이관 자료의 에너지 종류 이름 정리 ('전기료' → '전기' 등)
-- Supabase SQL Editor에서 실행하세요. 앱은 두 이름을 모두 읽으므로 실행하지 않아도 조회는 됩니다.

-- 1) 확인
SELECT energy_type, count(*) FROM energy_records GROUP BY energy_type ORDER BY 1;

-- 2) 정리
UPDATE energy_records
SET energy_type = left(energy_type, length(energy_type) - 1)
WHERE energy_type IN ('전기료', '상하수도료', '도시가스료', '통신료');
