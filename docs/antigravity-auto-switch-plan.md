# Antigravity 그룹 단위 자동 전환 계획

작성일: 2026-10-29. [Antigravity 전체 로드맵](antigravity-support-plan.md)의 3번 작업에
대한 실행 계획이다. 2번 [작업별 탭 재사용·증분 인계](antigravity-tab-reuse-plan.md)의
현재 구현을 기반으로 한다. 이 문서는 실행 계획과 진행 기록이며, 자동 전환을 활성화한 결과 보고가 아니다.

## 구현 시작 기록

신규 에이전트의 quota 기반 분산을 Antigravity 자동 전환 설정과 분리했다. 모델이 알려지고
향후 adapter가 자동 전환을 지원하더라도 Antigravity 신규 분산은 비활성이다. 두 설정 화면의
Antigravity 스위치는 전역 자동 전환이 꺼져 있을 때도 비활성으로 표시한다. 공식 모델·scope
대응과 Paseo까지 전달되는 공식 실패 신호는 아직 확보하지 못했으며 capability는 false다.
아래의 턴 귀속, 엄격한 후보 선택, 자동 인계와 영속 전환 제한은 아직 구현하지 않았다.

## 목적과 범위

공식 구독 한도로 멈춘 AGY 작업을, 같은 모델의 공유 한도가 남아 있는 다른 AGY 계정의
작업 탭에서 이어간다. Gemini·Claude/GPT·Argon 등 서로 다른 그룹의 한도는 독립적으로
판단하고, 선택 모델·권한·thinking·기능 설정과 원본 대화를 보존한다.

예를 들어 A의 Gemini 그룹이 소진되고 Claude/GPT 그룹은 남았다면 Gemini 작업의 대체 계정을
찾는다. A의 Claude/GPT 작업은 그대로 사용할 수 있다. 짧은 기간과 주간 한도가 함께 적용되면
둘 다 여유가 있어야 후보가 된다. 그룹명과 모델명만으로 대응 관계를 추측하지 않는다.

이번 범위는 한도 알림 판별, 그룹을 확인한 후보 선택, 작업 탭 자동 인계, 전환 결과 표시와
옵트인 활성화다. 공식 로그아웃 신호도 별도로 검증하되, 검증 전에는 해당 감지를 비활성으로 둔다.
새 에이전트의 잔량 기반 분산, 모델 자동 변경, 다른 제공자로 fork, banked reset,
macOS 신규 로그인과 추가 실계정 인증 격리 실험은 별도 범위다.

## 현재 코드와 보완 지점

| 영역 | 현재 상태 | 이번 작업에서 필요한 보완 |
| --- | --- | --- |
| [AGY adapter](../server/antigravity.ts) | quota 그룹·bucket을 파싱한다. `VERIFIED_MODELS`는 비어 있고 `detectLimit()`·`detectSignOut()`은 `null`, `autoSwitch`는 `false`다. | 입증한 모델·그룹 대응과 공식 실패 신호만 등록하고, 활성화 조건을 분리한다. |
| [사용량·계정 선택](../server/routing.ts), [공유 표시 함수](../shared/format.ts) | 모델에 대응하는 window와 `scopedLimits`를 사용할 수 있다. 일반 후보 선택은 unknown을 기본 점수 50으로 취급하며 캐시·오류·신선도를 필수 조건으로 검사하지 않는다. | AGY 자동 전환의 엄격한 후보 필터를 추가한다. 기존 Claude/Codex 정책과 수동 AGY 전환의 의미를 보존한다. |
| [턴 hook](../index.server.ts), [Service](../server/service.ts) | `agent.turn_started`에 `turnId`가 있지만 현재 Service에는 agent만 전달한다. `agentModels`는 세션 시작 시 모델이며, hook agent에는 모델이 없다. | 실패한 턴의 실제 계정·인증 세대·실행 모델·세션 문맥을 고정하고, 늦은 이벤트로 현재 작업을 잘못 옮기지 않게 한다. |
| Service의 한도 저장 | AGY의 `refreshUsage()`는 그룹 한도를 별도로 저장한다. `failover()`는 AGY의 scope 없는 limit을 거부한다. | 실패 신호의 scope와 해당 턴 모델을 대조하고, 실제 실행 계정에만 제한을 기록한다. |
| [AGY 작업 탭 관리자](../server/antigravity-continuations.ts) | 작업별 잠금·계정 귀속·설정 비교·증분 인계·stable ID와 receipt 복구가 구현돼 있다. 수동 호출만 구분하며 자동 호출과 현재 작업 탭 검사는 별도로 제공하지 않는다. | 자동 호출의 조건을 작업 잠금 안에서 재확인하고, 주차된 탭의 늦은 실패가 작업을 다시 시작하지 않게 한다. |
| [전환 횟수 제한](../server/switch-guard.ts) | agent마다 10분에 4회이며 메모리에 저장한다. | AGY는 탭을 오가므로 같은 작업 root 전체의 자동 전환을 제한하고, 플러그인 재시작으로 제한이 초기화되지 않게 한다. |
| [설정](../shared/preferences.ts) | `autoSwitch`와 기본값 false인 `antigravityAutoSwitch`, adapter capability를 모두 검사한다. AGY의 새 에이전트 분산도 같은 자동 전환 조건에 연결돼 있다. | 기본값·호스트 경계를 유지하고, 이번 기능 활성화가 AGY 신규 분산까지 함께 켜지 않게 한다. |
| [타임라인 계약](../shared/timeline.ts), [표시](../client/switch-row.tsx) | 현재 설명에는 계정 전체 소진, 새 agent, banked reset을 전제로 한 문구가 있다. | AGY에서는 적용 그룹과 대상 작업 탭을 표시하고, 후보 미확인을 전체 계정 소진으로 표현하지 않는다. |

2번 구현은 사용자가 완료했다고 알려 준 현재 checkout을 기준으로 한다. 구현 결과와
합성 검증 범위는 해당 계획 문서의 결과 절에 기록돼 있다. 실제 native 재개와 데몬 재시작 뒤
이력 복원 등 기존 한계를 이번 계획에서 검증 완료로 승격하지 않는다.

## 1. 활성화 전에 확보할 근거

### 모델과 공유 그룹의 대응

- 지원할 CLI·Paseo 버전, native provider ID, 정확한 모델 ID, quota의 scope·bucket ID와
  계정에서 실제 반환한 window 조합을 기록한다. 모델 카탈로그와 `/usage`를 함께 확인하되,
  카탈로그에 모델이 있다는 사실만으로 특정 quota를 사용한다고 확정하지 않는다.
- 공식 자료·검증 가능한 제공자 응답 등으로 입증한 대응만 등록한다. 현재 `VERIFIED_MODELS`의
  빈 목록을 표시명 유사성이나 모델 이름 접두사로 채우지 않는다. 테스트용 모델 대응은
  합성 fixture임을 구분하며 실제 지원 목록에 포함하지 않는다.
- 대응은 대상 계정의 반환 그룹에도 유효해야 한다. Argon 분리나 플랜별 그룹 구성 차이,
  bucket 누락·추가를 검사한다. 반환되지 않은 그룹에 잔량이 있다고 간주하지 않는다.
- 초기 지원은 입증한 모델·그룹 조합에 한정한다. unknown·충돌하는 대응은 표시를 유지하며
  자동 전환 대상에서 제외한다. 복수 그룹이 실제로 적용된다면 입증한 모든 그룹을 검사한다.

### 공식 실패 신호의 전달 경로

- native CLI의 실패 → Paseo provider → `PluginTurnOutcome` 또는 해당 턴의 공식 error 항목까지
  어떤 코드·문구·모델·scope 정보가 유지되는지 확인한다. 원본 CLI frame만 알아도 플러그인에서
  그 정보를 받지 못하면 자동 전환 판별에 사용할 수 없다.
- 관측한 공식 한도 응답이나 공식 예시를 비밀 없이 최소 fixture로 남긴다. 합성 오류 문자열만
  만들어 파서를 통과시키는 것은 지원 근거가 아니다. 계정 한도를 의도적으로 소진하지 않는다.
- 설치된 Paseo 0.13.2 소스에는 AGY 결과의 오류 문구를 가공해 전달하는 경로가 있다.
  quota 종류·scope가 보존된다는 보장은 아직 없으므로, 일반 `429`·`RESOURCE_EXHAUSTED` 같은
  넓은 범주만으로 subscription limit을 판별하지 않는다.
- 공식 응답이 scope를 명시하면 검증된 ID로 정규화한다. scope가 없는 경우에는 해당 오류가
  선택 모델의 구독 한도를 뜻한다는 근거와 실패 턴의 정확한 모델 대응이 모두 있을 때만 scope를
  보완한다. 응답과 모델의 scope가 충돌하거나 식별할 수 없으면 자동 처리하지 않는다.
- 공식 로그아웃 알림은 quota 실패와 별도로 검증하고, CLI가 실제 signed-out 상태임을 확인한
  뒤 계정 단위로 처리한다. quota 조회 실패·네트워크 오류·토큰 일시 만료만으로 signed-out을
  기록하지 않는다. 근거가 없으면 `detectSignOut()`은 계속 `null`을 반환한다.

대응표나 한도 신호의 근거가 없으면 구현을 보류할 부분과 확보할 자료를 기록하고,
`capabilities.autoSwitch`는 false로 유지한다. 필요한 정보가 Paseo에서 유실된다면 provider의
지원 또는 호환 버전을 별도 의존 사항으로 명시한다. 검증을 위해 판별 조건을 완화하지 않는다.

## 2. 실행 정책

### 전환할 때와 멈출 때

| 입력·상태 | 처리 |
| --- | --- |
| 현재 작업 탭의 이번 턴에서 공식 구독 한도와 모델·scope를 확인함 | 실제 실행 계정의 해당 scope만 제한으로 기록하고 대체 후보를 평가한다. |
| quota 조회에서 잔량 0을 확인했지만 공식 턴 한도 신호는 없음 | 그룹 상태를 갱신한다. 실행 중 턴을 중단하거나 자동 인계를 시작하지 않는다. |
| 일반 429·용량 부족·조회 실패·도구 출력·사용자 인용·일반 assistant 문장 | 한도 감지와 자동 전환의 근거로 사용하지 않는다. |
| 취소된 턴, 이전 턴 오류, 현재 작업을 떠난 주차 탭의 늦은 이벤트 | 자동 인계를 시작하지 않는다. 귀속이 입증된 공식 한도만 원래 실행 계정에 기록한다. |
| `turnId`가 없거나 시작 hook·실행 모델 귀속을 확보하지 못함 | 이전 타임라인을 재해석하지 않는다. 해당 이벤트로 작업을 자동 재개하지 않는다. |
| 원본 또는 다른 작업 멤버가 실행 중이거나 권한 요청 중 | 취소·권한 자동 승인 없이 전환을 중단한다. 턴 종료 직후의 짧은 상태 지연만 제한된 시간 동안 재확인한다. |
| 최신 사용량이 확인된 후보가 없음 | 원본 작업을 보존하고 수동 계정 선택·갱신·리셋 시각 확인을 안내한다. 미확인을 전체 소진으로 표현하지 않는다. |
| 모든 지원 후보의 해당 그룹이 소진됐음을 확인함 | 해당 그룹에 사용 가능한 계정이 없다고 알린다. 다른 그룹 사용 가능 상태를 유지한다. |
| `autoContinue`가 false | 제한을 기록하고 후보를 안내한다. 작업 탭 생성·인계 메시지 전송·자동 재개를 수행하지 않는다. |
| 자동 전환 설정 또는 capability가 꺼짐 | 기존 수동 전환 경로를 제공한다. 이미 시작한 SDK 요청의 결과는 확인하되 새 자동 전송을 시작하지 않는다. |

### 후보 계정의 조건과 순위

1. 같은 호스트의 native AGY 구독 계정이며 signed-in·enabled 상태여야 한다. 별도 API 키·
   엔드포인트·인증 홈 provider는 기존 resolver 규칙에 따라 제외한다.
2. 실패한 턴의 정확한 모델을 유지할 수 있고, 후보 계정의 사용량에서 해당 모델에 적용되는
   그룹·window를 확인해야 한다. account-wide·scope별 기존 제한도 함께 검사한다.
3. 후보 읽기는 `cached === false`, `error === null`이며 현재 시각보다 미래의 읽기가 아니어야
   한다. 초기 정책은 `fetchedAt`으로부터 5분 이내다. 이는 제품 정책이며 공식 API 제한 수치가
   아니다. 테스트에서 경계값을 고정하고 provider의 `usageSpacingMs` 120초와 별도로 관리한다.
4. 적용되는 모든 window의 사용률이 100% 미만이고 필요한 bucket이 빠지지 않아야 한다.
   잔량 미확인·그룹 대응 미확인·오류 캐시는 순위의 기본값 50으로 대체하지 않는다.
5. eligible 후보끼리는 적용 window 중 최대 사용률이 낮은 계정을 우선한다. 동률이면 기존
   default → CLI 로그인 → 생성 시각 순서를 유지한다. 다른 그룹의 잔량은 비교에 넣지 않는다.
6. 오래된 후보는 기존 spacing·Retry-After·in-flight를 지키며 한 번 갱신할 수 있다. 전체 후보
   갱신 대기 예산은 초기 15초, 동시 실행 상한은 2개다. 후보마다 새 timeout을 연장하며
   무한 대기하지 않는다. 갱신을 시작할 수 없거나 예산 안에 완료하지 못한 후보는 이번에 제외한다.

자동 선택은 갱신이 끝난 최신 snapshot으로 다시 계산한다. 전달 직전에도 해당 그룹의 제한과
숫자·신선도·인증 세대를 재검사한다. session-open hook에는 quota 프로세스를 추가하지 않는다.
기존 generic 선택 함수의 Claude/Codex fallback 정책은 유지하고, AGY 자동 경로에 조건을 적용한다.
`chooseAccount()`가 새 세션에서 한도 계정을 건너뛰는 경로도 함께 확인한다. 자동 인계로
미리 bind한 대상 계정이 세션 생성 사이에 달라지면 다른 계정으로 조용히 재라우팅하지 않고
인계를 중단한다. 이 조건을 session-open의 로컬 상태 검사와 관리자 생성·전송 재확인에 연결한다.

## 3. 턴 귀속·한도 저장·회복

- `index.server.ts`에서 `agent.turn_started`의 `turnId`를 Service에 전달한다. 턴 시작 시
  실제 `sessions` 계정·세션 시작 시각·관측한 인증 세대·provider와 모델·설정·사용자 지시 위치를
  고정한다. 모델은 로컬 agent/runtime 정보에서 얻으며 세션 시작 시의 `agentModels` 캐시만
  신뢰하지 않는다. hook agent 자체에 model 필드가 있다고 가정하지 않으며, 실행 모델을
  확인할 수 없거나 값이 충돌하면 해당 턴의 자동 전환을 보류한다.
- 종료 이벤트는 고정한 문맥과 대조한다. 이후 수동 전환·재로그인·모델 변경·새 지시가 있었다면
  이전 턴으로 현재 작업을 옮기지 않는다. 이벤트 중복은 세션 문맥과 turn ID를 함께 사용해
  판별하고, hook 순서 경쟁이나 플러그인 재시작으로 문맥을 잃은 경우 자동 재개를 보류한다.
- scope는 실패 턴 모델에 적용되는지 확인한 뒤 `StoredAccount.scopedLimits`에 기록한다.
  AGY 한 그룹의 오류로 account-wide `limitedUntil`을 설정하지 않는다. 공식 budget이
  확인된 경우에도 종류·적용 범위를 보존하며 usage 조회로 budget 제한을 해제하지 않는다.
- 공식 미래 reset 시각 또는 신선한 동일 scope의 quota로 확인한 시각을 사용한다. 여러 window가
  소진됐으면 모든 적용 제한이 풀리는 시각을 고려한다. 잘못된 시각·지난 시각을 임의의 미래로
  바꾸지 않는다. 회복 시각이 없는 AGY scope는 `limitedUntil: null`을 허용해 `확인 필요`로
  저장하고, 재확인 전 자동 후보에서 제외한다. 기존 문자열 레코드와 호환하며 모든 날짜
  소비자가 null을 처리하도록 함께 변경한다. Claude/Codex의 기존 fallback은 보존한다.
- `LIMIT_TRUST_MS`, 새 알림보다 오래된 `fetchedAt`의 역전 방지, 계정별 조회 spacing을 유지한다.
  시간 경과·리셋 시각 경과·그룹 누락만으로 수치 회복을 확정하지 않는다. 신선한 같은 scope의
  읽기와 실제 재로그인 등 입증한 변화로 해제하며, 삭제·해제의 이유를 테스트로 구분한다.
- 한도 수치를 UI에 반영할 때도 동일 scope에만 적용한다. `showLimit()`과 `resetFromUsage()`의
  기존 근사 매칭이 다른 그룹·다른 window를 갱신하지 않는지 확인한다.

## 4. 작업 탭 자동 인계와 동시성

- AGY 관리자의 `continue()`에 수동/자동 호출 문맥을 추가하되 기존 수동 호출의 의미를 유지한다.
  자동 문맥에는 실패 턴·모델·scope·원본 계정과 검증한 후보 조건을 전달한다.
- 작업 root 잠금 안에서 현재 작업 탭을 판정한다. 마지막으로 인계를 확정한 탭과, 이후 사용자가
  다른 멤버에 직접 남긴 지시를 함께 고려한다. 자동 호출은 현재 작업 탭에서만 허용한다.
  단순 `activeAgentId` 조회 뒤 잠금 밖에서 전송하는 구조로 만들지 않는다.
- 계정별 한도 기록 잠금·작업별 전환 잠금·에이전트 switching 표시의 순서를 정하고, 수동 전환과
  자동 전환이 서로 기다리며 교착하지 않게 한다. 실행 중인 수동 인계와 한도 알림이 겹쳐도
  원래 실행 계정의 그룹 제한은 기록하되 별도 인계는 중복 생성하지 않는다.
- 후보의 모델·권한·thinking·features·workspace·인증 홈·관측한 인증 세대를 전송 직전까지
  확인한다. 자동 호출에서는 후보가 해당 그룹의 scope 제한에 걸리지 않는지도 관리자 내부에서
  재확인한다. 현재 `currentAccount()`의 account-wide `isUsable()` 검사만으로 통과시키지 않는다.
- 2번의 기존 탭·증분 인계·stable agent/message ID·정확한 pending prompt와 receipt 검사를
  재사용한다. 기존 탭에 새 delta가 없는 경우에도 `autoContinue`가 켜져 있으면 설정한
  `continuePrompt`를 같은 예약·수신 확인 경로로 한 번 전달한다. delta가 있으면 인계문에
  계속하기 지시를 포함하며, Service가 별도 후속 메시지를 추가 전송하지 않는다.
- 미확정 pending이 있는 작업은 새 자동 인계를 시작하지 않는다. 기존 2번의 동일 ID·동일 본문
  재시도 정책을 유지하고, 자동 경로가 새 message ID로 우회하지 않게 한다. receipt로 확정된
  전달은 성공으로 정리하며, 실패·불명확 결과에는 대상 탭을 명시한다.
- AGY 자동 전환 횟수는 작업 root 전체에서 10분에 4회로 제한한다. 새 탭을 만들거나 기존 탭으로
  돌아가도 같은 한도를 공유한다. 예약과 확정된 전환의 구분을 영속화해 중복 이벤트·플러그인
  재시작이 카운트를 초기화하거나 같은 이동을 두 번 세지 않게 한다. 수동 계정 선택은 유지한다.
- 성공한 인계만 현재 탭·커서를 확정한다. 생성·send 실패, 계정 변경, 더 최신 사용자 지시,
  권한 요청, timeline gap·epoch 변경 시 원본과 pending을 보존하고 자동 계속을 중단한다.
  현재 SDK의 busy 확인과 send 사이에 원자적 조건부 전송이 없다는 2번의 경쟁 구간도 유지해서 보고한다.

## 5. 설정·UI·저장 호환성

- 활성 조건은 `autoSwitch && antigravityAutoSwitch && capabilities.autoSwitch`를 유지한다.
  `antigravityAutoSwitch`는 기본값 false이며, 누락된 과거 설정도 false다. 지원 capability는
  검증된 native 경로에서만 켜고, 미지원 호스트·모델은 실제 자동 동작에서 제외한다.
- [Accounts](../client/accounts-surface.tsx)와 [설정 화면](../client/settings-screen.tsx)의
  양쪽 스위치를 확인한다. 전역 스위치가 꺼졌거나 지원 근거가 없을 때의 표시를 맞추고,
  일반 설정 또는 업그레이드만으로 AGY opt-in이 false에서 true로 바뀌지 않게 한다.
- `balanceNewAgents`와 AGY 자동 failover의 연결을 끊는다. 이번 구현에서 AGY 신규 분산은
  계속 비활성이며, 기존 Claude/Codex 분산 설정을 변경하지 않는다.
- 타임라인에는 적용 scope·실제 출발 계정·대상 계정·재사용/생성한 작업 탭과 중단 이유를
  표시한다. `continued`, `stayed`, `pending`을 성공 하나로 합치지 않는다. 후보 미확인,
  해당 그룹 소진, 작업 busy, 사용자 설정 중지, 전달 불명확을 구분한다. AGY에 지원하지 않는
  banked reset·다른 제공자 fork를 해결책으로 제시하지 않는다.
- 필요한 scope·중단 이유는 `shared/timeline.ts`에 optional/default 필드로 추가하고 생산자와
  renderer를 함께 갱신한다. 과거 `zerosub-switch` 행과 기존 RPC 이름·결과의 의미를 유지한다.
- 회복 시각 미확인 scope, AGY 작업별 자동 전환 이력·중복 턴 판정에 필요한 상태만 확장한다.
  AGY 체인에는 optional 자동 처리 메타데이터로 최근 전환 시각·전달 ID와 처리한 턴 문맥을
  제한된 길이로 저장한다. 기존 체인은 해당 필드가 없는 상태에서 시작할 수 있어야 한다.
  기존 `scopedLimits` 데이터와 Codex/AGY 체인을 보존하고 부분 손상은 해당 레코드에 한정해
  복구한다. 상태 변경은 `StateStore.update()`와 원자적 저장으로 수행한다.

## 구현 순서와 단계별 완료 조건

| 단계 | 주요 파일·결과물 | 완료 조건 |
| --- | --- | --- |
| 1. 근거와 지원 범위 고정 | `server/antigravity.ts`, 오류/모델 fixture, 호환 버전 기록 | 실제 플러그인까지 전달되는 공식 한도 신호와 지원 모델→scope 대응을 입증한다. 누락된 근거와 로그아웃 미지원 범위를 명시하며, 근거 확보 전 capability는 false다. |
| 2. 턴 문맥·분류·한도 계약 | `index.server.ts`, `server/service.ts`, `server/adapter.ts`, 필요 시 `server/limits.ts`·`server/state.ts` | failed turn의 실제 계정·모델·scope만 기록하고, 취소·중복·stale 이벤트와 회복 시각 미확인을 정확히 처리한다. |
| 3. 그룹별 후보 선택 | `server/routing.ts`, `server/usage.ts`, `shared/format.ts`, Service | 신선한 지원 그룹의 양의 잔량만 후보로 삼고, 다른 그룹·unknown·오류 캐시가 선택에 섞이지 않는다. 갱신 예산과 spacing을 지킨다. |
| 4. 자동 작업 탭 인계 | `server/antigravity-continuations.ts`, Service, AGY 상태 스키마 | 현재 작업 탭에서만 같은 모델·권한으로 이어가고, busy·수동 경쟁·중복 이벤트·재시작·전달 유실에도 한 번만 처리한다. delta 없는 기존 탭도 한 번 재개한다. |
| 5. 결과 표시·옵트인 연결 | 공유 timeline·설정 계약, Accounts·설정·타임라인 renderer | 그룹별 결과와 미확인 상태가 정확하고, 일반 설정으로 AGY 자동 동작·신규 분산·reset·fork가 함께 활성화되지 않는다. |
| 6. 회귀·패키지·제한된 통합 검증 | 아래 검사와 README·관련 상세 지침, 필요 시 manifest | 회귀와 배포 검사가 통과하고 지원 환경의 자동 인계 경로를 검증한다. 남은 native·외부 인증 변경·send 경쟁 한계를 기록한 뒤에만 검증 범위의 capability를 활성화한다. |

## 검증 계획

아래 검사는 구현 단계의 계획이다. 이 문서 작성 중에는 런타임 테스트나 운영 플러그인 재로드를
수행하지 않는다. 테스트 모델·quota·오류는 비밀 없는 fixture와 임시 HOME, fake provider/Paseo를
사용한다. 현재 실제 SDK를 거치는 합성 daemon harness도 AGY 자동 경로로 확장한다.

| 검증 영역 | 필수 사례 | 검사 위치 |
| --- | --- | --- |
| 공식 신호 | 검증된 한도·로그아웃 양성, 일반 429/용량 오류/인용/도구·assistant 문장 음성, scope 누락·모델 충돌, `turnId: null`, 취소 | `server/antigravity.test.ts`, `server/antigravity-process.test.ts`, 필요 시 `server/limits.test.ts` |
| 모델·그룹 | 동일 공유 그룹의 여러 모델, Argon 분리, 계정별 반환 차이, bucket 누락·추가, unknown·충돌, 모델 변경 | `server/antigravity.test.ts`, `server/routing.test.ts`, `shared/format.test.ts` |
| 후보와 회복 | 5시간은 여유/주간 소진, 다른 그룹만 소진, 0%/100%, 미확인·cached·error, 5분 신선도 경계·미래 시각, Retry-After·in-flight·15초 예산, reset 누락·과거·동시 소진, budget 보존 | `server/routing.test.ts`, `server/usage.test.ts`, `server/service-antigravity.test.ts` |
| 턴 귀속 | 실제 session과 요청 binding 불일치, 시작 뒤 모델·계정·인증 세대 변경, 중복/늦은 hook, start/end 순서 경쟁, 빈 hook timeline, context 없는 재시작 | `server/service-antigravity.test.ts`, `server/failover.test.ts` |
| 탭과 동시성 | 자동 A→B→A→B, 수동 뒤 주차 탭 실패, 다른 탭의 사용자 지시·busy·권한 요청, delta 없음, 수동/자동 동시 전환, 실제 전송 전 설정 off·계정 비활성 | `server/antigravity-continuations.test.ts`, `server/service-antigravity.test.ts` |
| 전달과 제한 | create/send 응답 유실, 동일 ID receipt, 미확정 pending, plugin restart, 4회/10분을 탭 전체에서 공유, timeline gap·epoch·projected overlap, 두 작업 분리 | `server/continuations.sdk.test.ts`, `server/antigravity-continuations.test.ts`, `server/state.test.ts` |
| UI·호환성 | 기존 설정 기본값·세 스위치 조건, 신규 분산 분리, scope별 성공·소진·미확인·중단 문구, 과거 timeline/state 복구, Claude/Codex 회귀 | `client/presentation.test.ts`, `server/state.test.ts`, `server/continuations.test.ts`, `server/failover.test.ts` |

기본 검증에는 현재 존재하는 명령을 사용한다.

```sh
npm run typecheck
npm test
npm run audit:mobile
git diff --check
npm pack --dry-run
```

개발 의존성이 없는 별도 tarball 설치와 대상 Paseo의 `compilePlugin()`·`evaluateBundle()`로
배포 소스의 import 해석도 확인한다. 새 API나 최소 버전 변경이 필요하면 manifest·개발 의존성과
호스트 기능 감지를 함께 검토한다. 현재 없는 build/dev/lint 명령을 검증 절차로 안내하지 않는다.

실제 UI는 허가된 테스트 호스트의 Accounts·설정·composer·timeline을 넓은 화면/compact와
밝은/어두운 테마에서 확인한다. native 통합 검증은 허가된 테스트 agent와 기존 로그인에 한정하며,
실제 로그인·로그아웃·삭제·크레딧 사용·의도적 quota 소진·운영 재로드는 별도 허가 없이 수행하지
않는다. 합성 실패 주입으로 자동 인계를 확인한 결과와 실제 공식 quota 응답을 사용한 검증 결과를
구분해 보고한다.

## 미확인 사항과 완료 판정

- 현재 공식 모델→quota 대응과 한도 실패 fixture가 미확인이므로 코드 구현·합성 검사 통과만으로
  `autoSwitch`를 활성화하지 않는다. 구현 완료와 지원 환경에서의 활성화 여부를 구분해 보고한다.
- 외부 CLI에서 관측 없이 Google 계정이 바뀌는 문제, native conversation 재개와 Paseo
  timeline 복원의 차이, SDK busy 확인과 send의 경쟁 구간은 2번에서 이어지는 제약으로 기록한다.
- 3번 완료는 지원 근거가 있는 모델·환경에서 같은 그룹의 후보 선택·현재 탭의 자동 인계·중단
  조건·영속적인 전환 횟수 제한·UI·배포 검증을 충족하는 것으로 판단한다. 미지원 모델과 로그아웃
  감지의 미지원 범위는 명시하며, 일반 설정으로 해당 동작이 암묵적으로 활성화되지 않게 한다.

관련 규칙은 [서버 지침](../server/AGENTS.md), [공유 계약](../shared/AGENTS.md),
[클라이언트 지침](../client/AGENTS.md), [검증 절차](agents/verification.md)를 참고한다.
