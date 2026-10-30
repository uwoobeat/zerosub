# Antigravity 새 에이전트 잔량 기반 계정 선택 계획

작성일: 2026-10-30. [Antigravity 전체 로드맵](antigravity-support-plan.md)에 추가하는
독립 작업이다. 이 문서는 실행 계획과 진행 기록이며, 기능을 활성화한 결과 보고가 아니다.
같은 날 `검토/분석 1` 독립 검토를 반영해 첫 세션 모델 전달, 이전 인증 세대의 상태 변경 차단,
quota 실행의 공통 동시성 제한, 지원 중단 후 재동의 정책을 보완했다.
이후 같은 날 사용자가 한계를 인정한 구현과 사용 중 수정을 요청해, 공식 모델 대응과 실제 서버
생성 경로의 완전한 입증을 구현·실험적 옵트인의 선행 조건에서 제외했다. 설치 소스와 기존
실측에 기반한 초기 범위를 구현하고, 필수 회귀 검증과 아래의 구체적 확인 절차로 보완한다.

## 목표와 범위

새 AGY 에이전트의 첫 세션을 시작할 때, 선택한 모델의 공유 그룹 사용률이 가장 낮은 계정을
자동으로 선택한다. 사용자가 이 기능을 켠 호스트에서만 적용하며, 선택한 계정은 후속 세션에도
고정한다. 모델·권한·thinking·기능 설정과 작업 디렉터리는 기존 요청을 유지한다.

비교는 가장 최근에 성공적으로 읽은 quota snapshot을 사용한다. 실행 중인 작업을 계속 옮기거나
각 계정에 미래 사용량을 예약하는 기능은 포함하지 않는다. 동시에 생성한 여러 에이전트가 같은
최저 사용률 snapshot을 보면 같은 계정을 선택할 수 있다. 이는 요청 수를 번갈아 배분하는
round-robin이나 계정별 실행 개수 기반 부하 분산과 구분한다.

[2번 탭 재사용](antigravity-tab-reuse-plan.md)은 이미 시작한 작업의 수동 계정 이동,
[3번 자동 전환](antigravity-auto-switch-plan.md)은 한도로 멈춘 작업의 자동 인계를 다룬다.
이번 기능은 첫 세션의 계정 선택이므로 기존 대화를 이동하거나 continuation을 생성하지 않는다.
새로운 로그인 방식, 계정 삭제, 리셋 사용, 모델 자동 변경과 다른 제공자로 fork도 별도 범위다.

## 현재 구현과 초기 지원 범위

| 영역 | 현재 상태 | 필요한 변경 |
| --- | --- | --- |
| [계정 선택](../server/routing.ts) | 엄격한 후보 순위 함수 `mostAvailableAntigravity()`가 준비돼 있고 3번 자동 전환에서도 사용한다. `chooseAccount()`는 AGY 신규 분산을 제외한다. | 초기 모델·bucket 대응 가정과 첫 세션 조건을 연결한다. |
| [Service](../server/service.ts) | `route()`가 AGY의 `balanceNewAgents`를 false로 전달한다. hook에는 모델 필드가 없고, 첫 hook 때는 agent가 아직 등록되지 않을 수 있다. | 명시적 생성 모델을 요청별 문맥으로 전달하고 독립 설정·capability를 연결한다. |
| [AGY adapter](../server/antigravity.ts) | 그룹별 quota를 읽지만 `VERIFIED_MODELS`는 비어 있다. | 3번의 실측에 기반한 초기 모델·그룹 가정을 별도 실험적 대응으로 사용한다. |
| [설정](../shared/preferences.ts)·[capability](../shared/model.ts) | 기존 `balanceNewAgents`는 Claude/Codex용이며 AGY 신규 선택을 독립적으로 표현할 capability가 없다. | AGY 전용 기본값 false 설정과 독립 capability를 추가한다. |
| 사용량 갱신 | 기본 계정은 5분, 비활성 사용 계정은 20분 주기의 기존 갱신이 있다. AGY `identity()`도 quota를 조회한다. | 후보 캐시를 백그라운드에서 준비하고, 모든 quota 실행의 상한과 인증 세대별 상태 반영을 보장한다. |
| 회귀 검사 | [routing 검사](../server/routing.test.ts)는 알려진 모델에서도 AGY 신규 분산을 거부하도록 고정한다. | 비활성·미지원 시 거부를 유지하고 활성·지원 조건의 선택 사례를 추가한다. |

3번 자동 전환은 한 차례 실측에 기반한 모델·그룹 가정을 별도로 사용한다. 이번 신규 선택도
같은 가정을 초기 범위에서 사용할 수 있다. 공식 대응이나 실제 생성 성공으로 표현하지 않는다.
현재 신규 선택의 설정·동의·라우팅은 연결되지 않았고, 후보 함수의 검사는 합성 검사다.
Service의 identity 갱신은 조회 시작 후 계정이 삭제되거나 인증 홈·세대가 바뀌면 저장 시 결과를
버리도록 보강했다. 사용량 in-flight의 세대별 격리와 adapter 공통 실행 제한은 아직 남아 있다.

초기 실험 범위는 3번에서 Linux `agy` 1.4.10·Paseo 0.14.0으로 관측한
`claude-opus-5-5-high` → `claude-and-gpt-models`와 `3p-5h`·`3p-weekly` 조합이다.
이는 단일 실행의 한도 오류와 quota가 일치한 관측에 기반한 **가정**이며 계정·플랜에 따라
다를 수 있다. 후보 계정의 응답에 해당 그룹과 필요한 두 bucket이 모두 있을 때만 사용한다.
실제 생성 경로와 버전 호환성은 아래 절차로 구현 중·사용 중 확인한다.

지원 모델·scope·bucket과 가정의 근거를 개별 기록한다. `agy models`의 목록이나 이름 접두사만으로
추가 모델을 일괄 대응하지 않는다. 공식 대응표 `VERIFIED_MODELS`와 실험적 가정을 구분하며,
테스트용 모델 ID를 운영 대응표에 넣지 않는다. 공식 대응이 없어도 초기 가정과 필수 합성 검증을
바탕으로 제한적 capability를 켤 수 있다.

**3번의 한도 오류 감지나 자동 전환 활성화는 이번 기능의 조건이 아니다.** 이번 기능은 정상
quota snapshot과 초기 모델 대응을 사용하며 `autoSwitch`가 false여도 독립적으로 작동한다.

## 첫 세션 모델 전달과 구현 방침

2026-10-30에 읽은 설치본 `@getpaseo/server` **0.14.0**의 `createAgentInternal()`은
`agent.create` → `prepareSessionConfig()` → `buildLaunchContext()`의 session hook →
provider session 생성 → `registerSession()` 순서다. 첫 session hook에서는 신규 agent를
조회할 수 있다고 가정하지 않는다. hook 요청에도 모델 필드가 없다. 이 결과는 설치 소스의
확인이며 실제 생성 검증이나 과거 0.13.2의 호환성 검증 결과가 아니다.

현재 개발 SDK `@getpaseo/plugin` 0.9.1의 `agent.create` hook에는 `config`·`env`가 있지만
`agentId`는 없다. 다음 경로로 명시 모델부터 구현한다.

1. 명시한 `agent.create.config.model`을 Service의 일시적 생성 문맥에 보관하고,
   요청별 식별자로 첫 `agent.session_open`과 연결하는 방식을
   구현한다. env를 연결 수단으로 쓰면 플러그인이 발급한 문맥만 인정하고 provider·cwd·요청을
   대조한다. 임의 환경값을 모델의 증거로 신뢰하지 않는다. 연결용 값은 CLI에 전달하지 않으며,
   실패·timeout·중복 요청의 정리와 수명을 정의한다. 전역의 마지막 모델 값을 공유하지 않는다.
2. 초기에는 `default`·모델 생략·미지원 alias를 제외하고, 실험적 대응에 있는 명시적 모델 ID를
   지원한다. 명시 모델이 이후 hook이나 provider에서 바뀌지 않는다는 가정을 기록한다.
   확보한 로컬 정보와 충돌을 관측하면 fallback한다. 이후 변경을 전부 관측할 수 없다는
   한계는 허용하며 이를 이유로 정상적인 명시 모델 경로의 구현을 미루지 않는다.
3. session hook에 최종 모델을 제공하는 Paseo 계약 확장은 후속 개선으로 둔다. 현재 계약으로
   구현과 합성 검증을 진행하고, 존재하지 않는 필드를 가정하지 않는다. 실제로 문맥을 연결할 수
   없는 요청만 fallback하며, 문제가 재현되면 최소 fixture와 함께 경로를 수정한다.
4. 설치 소스의 생성 순서를 모델링한 양성 검사를 필수로 둔다. hook 동안 `agent.refresh()`는
   신규 agent를 반환하지 않아야 하며, 그래도 전달된 명시 모델과
   서로 다른 신선한 quota를 사용해 더 여유 있는 계정을 선택해야 한다. agent를 hook 전에
   등록하는 기존 fake만으로 통과했다고 판단하지 않는다. 실제 서버 기반 생성 검증은 선택
   검증으로 진행하고, 모델링 검사와 구분해 기록한다.

**공식 모델 대응과 실제 서버 생성의 완전한 입증을 기다리지 않고 선택 경로·설정·UI를 구현한다.**
명시 모델 경로의 합성 양성과 필수 회귀 검증을 통과하면 초기 범위에서 실험적 capability를
켤 수 있다. 정상 생성에서 항상 fallback하는 상태를 기능 완료로 보고하지 않는다. 모델 문맥
누락·관측된 충돌은 기존 시작 경로로 돌아가며, hook에 카탈로그 탐색·모델 실행·quota 조회를
추가하지 않는다.

### 설치 소스·공식 자료 조사 결과

현재 설치된 `@getpaseo/server` 0.14.0의 `createAgentInternal()`과 plugin lifecycle 코드를
다시 확인했다. `agent.create` 변환은 플러그인 ID 순서로 실행되고, 다른 플러그인은 cwd를
유지하면서 `config.model`을 변경할 수 있다. 이후 `normalizeConfig()`가 모델을 trim하고
빈 값·`default`를 기본 모델로 해석한다. 기본 모델은 provider 카탈로그에서 결정한다.
그 다음 session hook에 전달되는 요청에는 agent ID와 env가 있으나 모델이 없다. 최종 변환된
config와 session hook을 연결할 수 있다는 사실만으로 중간 플러그인이 관측한 모델이 최종
모델이라고 보장할 수는 없다. 이 결과는 설치 소스의 정적 분석이지 실제 서버 생성 양성 검사가
아니다. 다른 버전의 동일 동작도 확인하지 않았다.

초기 구현에서는 이 한계를 인정하고 요청별 env 문맥을 사용한다. 후속 hook·provider의 모델
변경을 관측하지 못하면 실제 실행 모델과 다른 그룹으로 계정을 고를 수 있다. 이때도 원래
모델 요청 자체를 변경하지 않으며, 사용 중 문제가 확인되면 해당 사례의 판별과 지원 범위를
보완한다. Paseo의 `agent.session_open`에 최종 provider launch 모델을 읽기 전용으로 제공하는
계약은 후속 개선안이다. 이 확장의 배포를 초기 구현의 선행 조건으로 삼지 않는다.

[Google 모델 문서](https://antigravity.google/docs/models/)는 그룹별 표시를,
[/usage 문서](https://antigravity.google/docs/cli/commands/usage)와
[요금제 문서](https://www.antigravity.google/docs/plans)는 quota 조회와 플랜별 차이를 설명한다.
이번 조사에서 정확한 CLI 모델 ID와 각 계정의 bucket ID·필수 window를 연결하는 명시적 대응은
찾지 못했다. 관측된 3번의 단일 모델 가정은 공식 대응의 증명이 아니지만 초기 실험 범위에서
사용한다. `VERIFIED_MODELS`를 공식 검증된 것처럼 채우지 않고 별도 실험적 대응을 사용한다.

## 선택 정책

### 적용 대상과 우선순위

다음 조건을 모두 만족하는 요청에만 잔량 기반 선택을 적용한다.

- 현재 호스트의 native AGY 구독 provider이며 별도 API 키·엔드포인트·인증 홈을 가져오지 않는다.
- `purpose === "interactive"`, `reason === "create"`이고, 해당 agent의 기존 실행 session·native
  conversation 귀속·계정 binding 또는 continuation 예약이 없다. `create` 재시도만으로 이미
  선택한 계정을 바꾸지 않는다. 생성 요청의 첫 prompt가 이미 Paseo에 등록된 경우를 지원하며,
  `lastUserMessageAt` 하나만으로 기존 native 대화가 있다고 판단하지 않는다.
- AGY 전용 설정과 신규 선택 capability가 켜져 있고, 생성 문맥의 명시 모델이 초기 대응 범위에 있다.

기존 수동 binding, continuation의 사전 binding, 실행 계정·thread 귀속을 우선한다.
`resume`·`refresh`·`import`·history 목적 요청은 이번 선택 대상에서 제외한다. 기존 가용성 처리와
원본 계정 고정은 유지하며, 사용량 비교를 이유로 명시적 계정을 덮어쓰지 않는다.

첫 세션의 모델은 위의 요청별 생성 문맥으로 확보한다. 등록 후 agent/runtime 조회는 재검증에
쓸 수 있지만 최초 생성의 유일한 근거로 삼지 않는다. 정보가 없거나 충돌하면 선택을 보류한다.

### 후보의 조건

1. 같은 호스트의 등록된 AGY 계정이며 signed-in·enabled 상태이고 인증 홈·관측한 인증 세대가
   현재 상태와 일치해야 한다. 조회를 시작할 때의 home·세대와 결과를 함께 확인한다.
   CLI 로그인과 관리 계정을 모두 후보로 삼을 수 있다.
2. 후보 계정의 quota가 선택 모델에 적용되는 그룹과 필요한 모든 window를 포함해야 한다.
   초기 대응 범위 밖의 모델·그룹, 관측된 대응 충돌, 필요한 bucket 누락은 후보에서 제외한다.
3. 사용량은 `cached === false`, `error === null`이며 `fetchedAt`이 현재보다 미래가 아니고
   5분 이내여야 한다. 5분은 초기 제품 정책이며 공식 제공자 요청 제한이 아니다.
4. account-wide·선택 모델의 scope 제한에 걸리지 않고, 적용되는 모든 window의 사용률이
   100% 미만이어야 한다. 확인 필요 상태의 제한도 존중한다. reset 시각 경과만으로 회복을 확정하지 않는다.
5. unknown·오류·오래된 캐시를 0%나 기본 점수 50으로 대체하지 않는다. 다른 그룹의 잔량도 빌려 쓰지 않는다.

### 순위와 예시

계정의 점수는 적용되는 모든 window의 **반올림 전 사용률 중 최댓값**이다. 점수가 낮을수록
우선한다. 동률이면 기본 계정 → CLI 로그인 → 먼저 생성된 계정 → 계정 ID 순서로 정한다.
기존 Claude/Codex의 점수·동률 정책은 변경하지 않는다.

| Gemini 그룹 예시 | 5시간 사용률 | 주간 사용률 | 선택 점수 |
| --- | --- | --- | --- |
| 계정 A | 20% | 80% | 80% |
| 계정 B | 45% | 35% | 45% |

이 경우 B를 선택한다. 사용률 평균·합계·전체 그룹 최댓값으로 비교하지 않는다. 다른 모델이
선택되면 그 모델에 적용되는 그룹으로 다시 계산한다. 향후 Argon처럼 window가 하나인 구성을
지원 범위에 추가하면 그 window를 사용하며, 항상 5시간·주간 두 개가 있다고 가정하지 않는다.

후보를 확정할 수 없으면 기존 기본 계정·가용성 처리 경로로 돌아간다. 이때 `balance` 선택으로
기록하거나 최저 사용률 계정을 확인했다고 표시하지 않는다. 선택 실패가 세션 시작을 막지 않게 한다.

## 독립 설정과 capability

- `shared/preferences.ts`에 호스트별 `antigravityBalanceNewAgents`를 추가하며 기본값은 false다.
  기존 `balanceNewAgents`는 Claude/Codex 설정으로 유지한다. 새 설정은 `autoSwitch`,
  `antigravityAutoSwitch`, `autoContinue`, Claude/Codex용 `balanceNewAgents`와 독립적으로 작동한다.
- `FamilyCapabilitiesSchema`에 신규 선택 지원을 나타내는 optional `balanceNewAgents`를 추가한다.
  AGY는 필드 누락·capability 누락을 false로 처리한다. 기존 Claude/Codex의 과거 동작 fallback은
  보존하며, `Service.view()`·adapter·클라이언트의 capability 검사와 타입을 함께 연결한다.
- AGY 신규 선택 capability는 초기 모델 대응과 합성 첫 세션 라우팅·필수 회귀를 통과한 범위에서
  실험적으로 켤 수 있다. 이는 `capabilities.autoSwitch`와 별개이며 기본 opt-in은 false다.
  capability가 있어도 초기 대응 범위 밖의 모델에는 적용하지 않는다.
- [Accounts](../client/accounts-surface.tsx)와 [설정 화면](../client/settings-screen.tsx)에
  `Start new Antigravity agents on the account with the most room` 스위치를 추가한다.
  실험 기능·초기 모델 범위·그룹 기준·새 에이전트에만 적용된다는 점을 설명한다.
- [family-support](../client/family-support.ts)의 지원 검사와 설정 저장 정규화를 확장한다.
  아래 지원 상태와 재동의 정책을 두 화면과 서버에서 동일하게 적용한다. 다른 스위치 저장이
  기존 설정을 덮어쓰지 않게 한다.
- 기존 설정 버전 1과 기존 RPC 이름을 유지한다. 과거 데이터에는 새 설정이 false로 채워지고,
  capability의 새 필드가 없는 응답도 읽을 수 있어야 한다. 설정 초기화·업그레이드만으로 켜지지 않는다.

### 지원 상태와 재동의의 영속화

신규 선택의 기능 지원과 현재 사용 가능 상태를 분리한다. `Service.view()`가 일시적 불가용에도
capability를 false로 내릴 수 있으므로 그 값 하나로 저장된 사용자 선택을 지우지 않는다.

| 상태 | 실행과 UI | 저장 정책 |
| --- | --- | --- |
| 초기 지원 범위·현재 사용 가능 | 설정과 유효한 동의가 모두 있으면 실험적으로 적용한다. | 사용자의 선택을 유지한다. |
| 기능 미지원 확정 | 구현상 지원하지 않는 플랫폼이나 기능 철회 등 명시적인 기능 미지원일 때 실행을 끈다. | 서버가 재동의 필요 상태를 영속적으로 기록한다. 지원이 복구돼도 자동 재활성화하지 않는다. |
| 일시적 불가용·판정 대기 | 연결·CLI 오류, provider 카탈로그 로딩, 구독 라우팅 제외 설정 등에서는 실행을 보류한다. | 설정과 유효한 동의를 보존한다. 현재 상태가 회복되면 기존 동의 범위에서 다시 적용할 수 있다. |

요청 모델의 대응 미확인이나 오래된 quota는 그 요청의 fallback 사유이며 호스트 전체의
지원 중단으로 기록하지 않는다. `StateView`에는 새 기능의 지원 상태·현재 가용성·재동의 필요
여부와 지원 상태 revision을 optional 계약으로 전달한다. 구형 응답은 실행 불가로 처리하되
누락 자체를 확정 미지원으로 간주해 설정이나 동의를 변경하지 않는다. 이 revision은 일시적
가용성이나 quota 변화로 바꾸지 않는다.

**영구 미지원 뒤에는 명시적인 재동의를 요구하는 정책을 선택한다.** 현재 서버의
`registerSettings()` 반환 API는 읽기·구독만 지원한다. Service의 메모리 값을 false로 바꾸거나
클라이언트의 다음 저장만 기다리는 방식 대신, 호스트의 `StateStore`에 재동의 필요 상태와
지원 상태 revision을 보관한다. 시작 시와 지원 상태 변경 시 UI 연결 여부와 무관하게 갱신하고,
상태 확인·저장이 완료되기 전에는 실행하지 않는다. 미지원 확정 시 이전 동의를 무효화하며
재시작·플러그인 교체·지원 복구에도 유지한다. 기존 데이터에 동의 기록이 없으면 미동의다.

사용자가 두 화면 중 한 곳에서 스위치를 직접 켤 때만 새 동의를 기록하는 RPC를 추가한다.
클라이언트는 설정을 revision 검사로 저장한 뒤, 관측한 지원 상태 revision으로 동의를 요청한다.
서버는 현재 지원 여부와 revision을 다시 검사하고 `StateStore.update()`에서 승인한다. 오래된
화면의 요청이나 중간 실패로 활성화하지 않으며, 설정 저장만 성공하고 동의가 실패하면 실행은
계속 꺼진다. 다른 설정 저장·설정 구독·재연결을 동의로 취급하지 않는다. UI는 저장된 true가
있어도 동의가 무효하면 스위치를 꺼진 상태로 표시하고 다시 켜야 함을 설명한다.

실제 적용 조건은 설정 true·초기 지원 범위·현재 가용성·현재 revision에 유효한 동의다. 이 변경은
새 AGY 선택에 한정하며 기존 자동 전환 설정의 정규화 정책을 함께 재설계하지 않는다.

## 시작 경로·캐시·동시성

### 백그라운드 준비와 공통 quota 실행 제한

- `Service.tick()`과 기존 `refreshUsage()`를 활용해 기능 활성 중인 signed-in·enabled AGY
  후보의 사용량을 백그라운드에서 준비한다. 설정을 켜거나 캐시가 오래됐을 때 갱신을 예약하되
  세션 시작은 기다리지 않는다. 초기 목표 주기는 5분 이내다.
- 호스트의 ZeroSub AGY adapter 인스턴스에서 **실제로 실행하는 quota 프로세스의 공통 상한을
  2개**로 둔다. `refreshUsage()`만 감싸지 않고 adapter의 `readQuota()`에서 실제 프로세스를
  시작하는 경계에 큐를 둔다. 주기적·명시적 사용량 갱신, `refreshIdentity()`와 초기 CLI 계정
  확인의 `identity(null)`도 이 경계를 통과한다. 캐시 적중과 같은 유효 문맥의 중복 합류는 새
  실행 수에 더하지 않으며, 성공·오류·timeout·취소 시 실제 프로세스 종료를 확인한 뒤 슬롯을
  반환한다.
- 계정별 `usageSpacingMs` 120초·Retry-After·in-flight 중복 방지·최신 읽기 우선순위를 유지한다.
  identity와 usage가 같은 quota 실행 경계를 공유하도록 간격·대기 정책도 함께 적용한다.
  큐에서 꺼낼 때 기존 계정의 존재·현재 home·인증 세대·구독 라우팅 여부를 다시 확인하고
  무효 작업을 건너뛴다. 최초 CLI 계정 확인은 아직 등록 전임을 나타내는 별도 bootstrap 문맥으로
  처리하며, 삭제된 기존 계정의 조회와 구분한다. 일반 화면 폴링에 강제 갱신을 추가하지 않고
  Claude/Codex 갱신 구조도 변경하지 않는다.

### 조회 귀속과 이전 인증 세대의 상태 변경 차단

- AGY 조회 시작 시 계정 ID·home·관측한 인증 세대와 조회 식별자를 고정한다. quota snapshot을
  이 문맥과 함께 관리하며, 반환 직후와 상태 반영 직전에 현재 계정과 일치하는지 확인한다.
  adapter 내부 캐시 저장을 막아도 기존 호출자에게 결과가 반환될 수 있으므로 Service에서도
  검증한다. identity 조회가 계정 신원·인증 세대를 변경할 때도 같은 원칙을 적용한다.
- 삭제·재로그인·home 변경으로 무효가 된 조회 결과는 **후보뿐 아니라 모든 상태 반영에서
  폐기**한다. 사용량 메모리·저장 캐시, 신원·signed-in 상태, 현재 세대의 Retry-After·갱신 시각,
  `scopedLimits` 추가·해제와 관련 알림을 갱신하지 않는다. 조회 시작 시 기록한 간격·대기
  정보도 현재 세대의 것으로 재사용하지 않는다.
- 특히 `updateScopedLimits()` 등 영속 상태 변경은 전달받은 조회 문맥을
  `StateStore.update()` 안에서 다시 검사한 뒤 처리한다. 조회 완료 직전의 검사만으로
  충분하다고 보지 않는다. 이전 세대의 100% 결과가 새 세대의 제한을 다시 만들거나, 이전
  세대의 여유 있는 결과가 새 제한을 지우는 경우를 모두 막는다.
- Service의 in-flight 합류는 계정 ID뿐 아니라 home·인증 세대가 일치하는 경우로 제한한다.
  adapter의 home별 quota 무효화와 연결해 새 세대의 요청이 이전 작업에 합류하지 않게 한다.
  이전 작업의 `finally`도 새 작업의 in-flight 기록을 지우지 않도록 작업 식별자를 확인한다.
- 기존 저장 캐시에 귀속 정보가 없으면 표시용으로 유지하고 첫 정상 갱신 전에는 후보에서
  제외한다. 이 검증 정보는 Service 내부에서 snapshot과 함께 관리하며, 공유 사용량 계약에
  인증 경로를 추가하지 않는다. 토큰 내용이나 해시를 계정 키로 저장하지 않는다.

### 첫 세션 선택과 라우팅 경쟁

- 첫 세션 선택은 로컬 계정 상태·모델 문맥·사용량 snapshot으로만 계산한다. 기존 15초 hook
  제한과 요청의 나머지 필드를 유지한다. hook에 공식 로그인·quota 프로세스·네트워크 대기를 추가하지 않는다.
- AGY용 후보 필터는 순수 함수로 두고 Service가 준비한 snapshot을 전달한다. 3번과 같은 모델·
  그룹·신선도 정책은 실제 구현이 있으면 공유하되, 자동 failover의 활성화 여부에 의존하지 않는다.
  generic `mostAvailable()`의 unknown fallback을 그대로 사용하지 않는다.
- 선택 뒤 관리 HOME 준비·환경 검증을 마친 시점에 binding·계정 존재·signed-in/disabled 상태·
  인증 세대·모델·설정을 다시 확인한다. 필요한 선택 재평가는 한 번으로 제한한다. 사용자가
  계정을 지정했다면 그 요청을 우선하고, 이전 선택 결과로 binding을 덮어쓰지 않는다.
- 같은 agent의 중복 create hook은 하나의 선택과 귀속으로 정리한다. HOME 검증이나 hook이
  실패·시간 초과한 뒤 늦게 끝난 비동기 경로가 선택 binding·실제 session을 기록하지 않도록
  route 시도 유효성을 확인한다. hook의 `undefined` 반환과 실제 CLI 로그인 fallback을 보존한다.
- 성공한 첫 선택은 기존 `Binding.source: "balance"`로 저장하고 실제 session 계정도 별도로
  기록한다. 이후 quota·기본 계정·설정이 바뀌어도 resume에서 잔량 비교를 다시 수행하지 않는다.
- 다른 agent의 동시 생성에는 미래 사용량·활성 작업 수를 점수에 더하지 않는다. 같은 snapshot이면
  같은 계정을 고를 수 있으며, 동시성 제어의 목적은 같은 agent의 이중 선택과 잘못된 귀속을 막는 것이다.

## 구현 순서와 완료 조건

2026-10-30 구현 시작: 기존 자동 전환이 사용하던 단일 모델·그룹 가정의 quota 변환을
별도 함수로 분리했다. 원본 snapshot과 다른 모델·그룹의 정보는 유지하며, 지원 모델이 아닌
경우 변환하지 않는다. 이는 후보 준비를 위한 기반 작업이다. 신규 생성 모델 전달, 설정·동의,
첫 세션 라우팅, 조회 동시성·인증 세대 격리와 UI는 아직 연결되지 않았고 capability도 켜지지
않았다. 아래 완료 조건과 필수 검증은 아직 충족하지 않았다.

| 단계 | 결과물과 주요 파일 | 완료 조건 |
| --- | --- | --- |
| 1. 초기 가정과 모델 전달 구현 | `server/antigravity.ts`, 필요 시 `index.server.ts`, 모델/그룹 fixture, 첫 생성 순서 검사 | 3번의 단일 모델·그룹 가정과 후속 hook 변경 가능성을 명시한다. agent가 등록되지 않은 순서의 합성 검사에서 명시 모델 문맥을 전달하고 더 여유 있는 계정을 선택한다. 공식 대응과 실제 서버 검증은 후속 절차로 보강하며 Paseo 계약 확장을 기다리지 않는다. |
| 2. 독립 설정·지원 상태·동의 | `shared/preferences.ts`, `shared/model.ts`, `shared/rpc.ts`, `server/state.ts`, `server/service.ts`, `index.server.ts`, adapter, `client/family-support.ts` | 기본값·구형 응답은 실행 off다. 확정 미지원의 동의 무효화가 UI 없이 영속화되고, 일시 장애는 선택을 보존한다. 지원 복구 후에는 현재 revision에 대한 명시적 재동의가 필요하다. |
| 3. 후보·순위 순수 함수 | `server/routing.ts`, `shared/format.ts`, 관련 fixture | 해당 그룹의 신선한 숫자만 비교하고 window별 최대 사용률·동률·미확인을 일관되게 처리한다. |
| 4. 첫 세션 연결 | `server/service.ts`, 필요 시 `index.server.ts` | 새로운 interactive create에서만 선택하고 수동 binding·기존 대화·예약된 continuation을 보존한다. 실패·시간 초과·경쟁 시 실제 계정 귀속이 정확하다. |
| 5. 캐시 준비·공통 실행 제한·두 설정 UI | Service의 갱신 경로, `server/antigravity.ts`, Accounts·설정 화면 | hook의 quota 호출은 0회다. identity·초기 CLI 확인까지 quota 실행 최대 2개를 지키고, 무효 세대 결과의 모든 상태 반영을 막는다. 두 화면에서 재동의를 처리하며 미확인 fallback을 선택 성공으로 표시하지 않는다. |
| 6. 회귀·패키지·문서 | 아래 검사, README·관련 상세 지침 | 필수 회귀·기본 검사·별도 설치를 통과하고 초기 범위에서 독립 capability를 실험적으로 켤 수 있다. 실제 서버·native 검증과 가정의 확인은 아래 절차에 따라 사용 중 이어간다. |

## 검증 계획

### 현재 검증 가능한 부분

아래 작업은 실계정 로그인·운영 재로드 없이 현재 checkout에서 수행하거나 준비할 수 있다.
수행 가능하다는 뜻이지 모든 항목이 이미 통과했다는 뜻은 아니다. 수행 시 명령·결과와
합성 fixture의 범위를 기록한다.

- `server/routing.test.ts`의 후보·순위 검사와 기존 AGY 신규 분산 비활성 검사를 실행한다.
  필요한 누락·경계 사례를 비밀 없는 합성 fixture로 보강한다. 자동 전환 경로에서의 함수
  재사용도 회귀 확인하되, 이를 신규 선택 경로의 양성 결과로 취급하지 않는다.
- 설치된 Paseo 소스의 순서를 모델링하고, agent가 아직 등록되지 않은 hook으로 요청별 명시
  모델을 전달하는 경로와 선택 양성을 구현한다. 아래 절차로 합성 검사부터 실행하며 실제 서버
  검사는 별도로 기록한다. Paseo 계약 확장 제안과 제품 구현은 병행할 수 있다.
- 공식 자료와 검증 가능한 기존 응답에서 모델·scope·bucket 대응 근거를 찾고, 이미 확보한
  비밀 없는 자료의 범위를 기록한다. 3번의 실험적 가정을 초기 대응으로 연결하고 공식 대응과
  구분한다. 추가 자료 수집을 기다리지 않고 설정·선택 경로 구현을 진행한다.
- 설정·동의 계약, 인증 세대별 조회 귀속, 공통 quota 실행 제한과 두 설정 UI를 구현하고
  합성 검사를 추가한다. 신규 선택 경로를 연결해 초기 범위에서 동작하는 결과물을 만든다.
- 현재 코드에 적용 가능한 `npm run typecheck`, `npm test`, `npm run audit:mobile`,
  `git diff --check`를 실행할 수 있다. 이 결과는 아직 구현하지 않은 기능의 검증을 대신하지 않는다.

### 필수: 구현 완료와 실험적 옵트인 전

초기 명시 모델에 대해 agent가 hook 동안 등록되지 않은 순서의 합성 양성을 통과한다.
아래 회귀 사례 중 구현에 해당하는 항목, 기본 검사, 배포물 검사와 개발 의존성이 없는 별도
설치를 확인한다. 계정·호스트 경계, 사용자 binding 보존, 이전 인증 세대의 상태 반영 차단,
중복·timeout 처리와 기본값 false는 필수다. 공식 모델 대응, 다른 플러그인 조합의 완전한 확인,
실제 서버·native 생성 결과는 초기 capability를 켜는 필수 조건으로 두지 않는다.

필수 검증 실패는 수정하고, 환경상 실행하지 못한 검사는 이유와 영향을 보고한다. 합성 fixture와
임시 HOME, fake provider/Paseo로 검증하며 합성 결과를 실계정 결과로 표현하지 않는다.

| 영역 | 필수 사례 | 주요 검사 |
| --- | --- | --- |
| 설정·capability | 기존 데이터 기본값 false, capability·새 지원 상태 누락, AGY 선택 on/자동 전환 off, 반대 조합, Claude/Codex 분산 on/off의 독립성, 호스트 분리 | `shared/preferences.test.ts`, `shared/model.test.ts`, `client/presentation.test.ts` |
| 동의의 영속화 | UI 연결·저장 없이 확정 미지원→재시작→지원 복구 시 off, 명시적 재동의 후 on, 일시 장애·카탈로그 대기 중 다른 설정 저장 후에도 선택 보존, 동의 없는 true·오래된 revision·부분 저장 실패·동시 설정 변경 | `server/state.test.ts`, `server/service-antigravity.test.ts`, `client/presentation.test.ts` |
| 후보·순위 | 5시간/주간의 최대값, 다른 그룹만 소진, Argon 한 window, 계정별 bucket 차이, unknown·누락·cached·error, 5분 신선도 경계·미래 시각, 동률, 모든 후보 소진 | `server/routing.test.ts`, `server/antigravity.test.ts`, `shared/format.test.ts` |
| 첫 생성 모델 전달 | hook 동안 신규 agent 조회는 null인 생성 순서 모델링, 명시 모델 전달과 최저 사용률 계정 선택 양성, 첫 prompt 등록, 기본 모델·미지원 alias fallback, 관측 가능한 모델 충돌, 문맥 혼선·위조·만료·정리 | `server/service-antigravity.test.ts`, `server/continuations.sdk.test.ts` |
| 시작 경계 | history/create 재시도·resume/refresh/import 음성, 초기 model null·충돌, 기존 session·native 대화·수동/continuation binding, 별도 auth provider | `server/service-antigravity.test.ts`, `server/continuations.sdk.test.ts` |
| 경쟁·귀속 | 선택 중 사용자 선택·계정 비활성/삭제·인증 세대·기본값·설정 변경, HOME 검증 실패, 같은 agent 중복 create, 15초 timeout 후 늦은 완료, 후속 resume 고정 | `server/service-antigravity.test.ts`, `server/state.test.ts` |
| 조회 귀속·상태 보존 | 재로그인 후 이전 100% 조회 완료 시 새 제한 없음, 이전 여유 조회에도 새 제한 유지, home 변경·계정 삭제, state update 대기 중 세대 변경, identity의 늦은 결과, 새 세대의 이전 in-flight 합류 금지·이전 finally의 새 작업 삭제 방지, 귀속 없는 저장 캐시 제외 | `server/service-antigravity.test.ts`, `server/antigravity.test.ts`, `server/state.test.ts` |
| 공통 quota 상한 | 여러 계정의 usage·identity·초기 CLI 확인을 겹쳐도 실제 프로세스 최대 2개, 공유 실행·캐시 적중·spacing·Retry-After, 큐 대기 중 무효화, 오류·timeout 뒤 종료 확인과 슬롯 반환, hook 내 quota 실행 0회 | `server/antigravity.test.ts`, `server/antigravity-process.test.ts`, `server/service-antigravity.test.ts` |
| SDK·기존 기능 | 같은 snapshot의 동시 agent 선택, 기존 Claude/Codex와 AGY 탭 인계 회귀 | `server/usage.test.ts`, `server/continuations.sdk.test.ts`, `server/antigravity-continuations.test.ts` |

기본 명령은 다음과 같다.

```sh
npm run typecheck
npm test
npm run audit:mobile
git diff --check
npm pack --dry-run
```

개발 의존성이 없는 tarball 별도 설치와 대상 Paseo의 `compilePlugin()`·`evaluateBundle()`로
공유 capability·서버·클라이언트의 배포 import를 확인한다. 두 설정 화면의 동의·상태 동작은
합성 검사로 확인하고 실제 UI 확인은 아래 선택 검증에서 보강한다.

### 미확인 항목의 세부 확인 절차

확인 작업은 다음 순서로 진행한다. 1번은 구현과 함께 완료할 필수 합성 검사이고, 2~4번은
실제 환경의 가정을 보강하는 선택 검증이다. 선택 검증을 기다리며 제품 구현을 중단하지 않는다.

1. **요청별 모델 전달과 선택 양성:** 생성 순서를 모델링한 fake Paseo에서 create hook을 거친 뒤
   session hook을 실행하고, provider 생성 완료 뒤에만 agent를 등록한다. hook 중 agent 조회는
   null이어야 한다. 초기 지원 모델을 명시하고 A의 두 window를 20%·80%, B를 45%·35%로 둔다.
   B의 환경과 `balance` binding·실제 session 계정 기록을 확인한다. 모델·권한·thinking·features·
   cwd는 요청과 같고, 연결 식별자는 CLI 환경에서 제거돼야 한다. 두 요청의 hook 순서를 뒤집어
   문맥 혼선이 없는지, 위조·만료·중복 문맥과 기본 모델·미지원 모델이 fallback하는지도 검사한다.
   검사 위치는 `server/service-antigravity.test.ts`와 SDK harness다.
2. **실제 Paseo 코드에서 최종 모델 대조:** 설치된 서버 버전과 SDK 버전을 고정한 격리 harness에
   실제 AgentManager·lifecycle 코드를 연결하고 provider만 fake로 둔다. 운영 데몬을 재로드하지
   않는다. ZeroSub이 본 명시 모델, 모든 create hook 처리와 정규화 뒤 provider `createSession()`에
   전달된 모델, 연결 식별자 제거 여부를 대조한다. 일반 생성·동시 생성·모델 공백 정규화와
   ZeroSub 뒤의 hook이 다른 모델로 바꾸는 사례를 각각 실행한다. 같으면 해당 조합의 전달 성공으로
   기록한다. 달라지는 사례는 최소 fixture로 남기고 관측 가능한 충돌은 fallback으로 수정한다.
   최종 모델을 관측할 수 없는 조합의 한계는 문서화하며 Paseo 읽기 전용 모델 필드 제안에 반영한다.
   서버 내부 API가 달라 harness 연결이 어렵다면 필요한 mock·호출 인자를 먼저 정리하고, 허가된
   테스트 호스트의 3번 절차로 실제 생성 결과를 확인한다. harness 결과와 native 결과를 구분한다.
3. **native 첫 생성과 계정 귀속:** 사용자가 허용한 테스트 호스트와 기존 로그인 계정을 사용한다.
   CLI·Paseo 버전, 명시 모델, 각 후보의 비밀 없는 quota 요약과 조회 시각을 기록한다. 테스트
   설정에서 신규 선택만 켜고 `autoSwitch`·`antigravityAutoSwitch`는 끈 뒤 초기 모델로 새 agent를
   생성한다. 세션 개설 직후 binding·실제 session 계정·provider의 모델 정보를 비교하고, 간단한
   한 턴이 허용되면 실행 후 runtime 모델도 대조한다. 후보 중 점수가 가장 낮은 계정에 귀속되고
   모델 요청이 유지되면 그 환경의 양성으로 기록한다. 캐시가 없을 때 기본 계정 시작, 설정 off,
   후속 resume 고정도 확인한다. 자연스럽게 신선한 후보 둘을 확보하지 못하면 그 사례만 미실행으로
   기록하고, 합성 값을 실계정 사용량인 것처럼 넣지 않는다. 귀속이 다르면 실제 계정을 보존해
   기록하고 실행 중 턴을 옮기지 않으며 다음 생성부터 해당 조건을 수정하거나 fallback한다.
4. **모델과 quota 그룹 대응 보강:** 먼저 정확한 CLI 모델 ID와 그룹·bucket이 함께 나오는 공식
   메타데이터나 응답이 있는지 확인한다. 없으면 허가된 동일 계정에서 다른 작업의 동시 소비를
   피하고 초기 모델 실행 전 snapshot, 한 번의 허용된 짧은 개발 요청, 실행 후 snapshot을 비교한다.
   조회는 기존 120초 spacing·Retry-After를 지키고 갱신이 지연되면 다음 정상 갱신까지 관찰한다.
   모델 ID·시각·bucket별 잔량·reset·동시 사용 여부를 기록하고, 초기에는 `3p-5h`·`3p-weekly`가
   같은 그룹으로 반환되는지 확인한다. 한 번의 잔량 변화는 상관관계로 남긴다. 반복 가능한 개발
   요청에서도 같은 결과면 관측 근거를 추가하고, 다른 bucket이 변하거나 변화가 없으면 동시 사용·
   집계 지연·reset을 확인한 뒤 가정과 fixture를 수정한다. 추가 계정은 로그인 복사 없이 기존
   등록 계정에서 같은 절차를 수행한다. 한도 소진을 의도적으로 유발하지 않는다.

각 절차의 결과는 이 문서에 버전·날짜·시나리오·기대값·관측값·성공/실패/미실행과 다음 조치를
기록한다. hook 순서·명시 모델·최종 모델·가명 계정·bucket 수치처럼 필요한 값만 보존하고
인증 정보·전체 환경·원시 응답·대화 내용은 결과물에 포함하지 않는다. 회귀 fixture에는 합성 값과
실측에서 가져온 최소 필드를 구분한다. 실패를 발견하면 재현 검사를 먼저 추가하고 수정하며,
지원 조건을 좁혀야 한다면 원인을 기록한다. 모든 계정·버전의 완전한 증명을 기다리지 않는다.

### 선택: 구현 후 여건이 되는 대로

- 위 2~4번의 실제 서버·native 생성·모델 대응 확인을 수행한다. 확인 중 드러난 문제는 구현에
  반영하되, 결과를 기다리는 일 자체는 실험적 옵트인 활성화를 막지 않는다.
- 허가된 테스트 호스트에서 두 설정 화면과 새 agent의 계정 버튼을 넓은 화면/compact,
  밝은/어두운 테마로 확인한다. 동의·상태의 합성 검사 결과와 실제 UI 결과를 구분한다.
- 추가 Paseo·CLI 버전, 계정·플랜·모델과 window 구성은 관측이나 자료에 근거해 개별 확장하고
  새 가정과 한계를 기록한다. 이름 접두사만으로 지원을 일괄 확대하지 않는다.
- 사용 중 확인된 캐시 지연, 동시 생성과 다른 호스트의 소비 영향을 관찰하고 재현 가능한
  fixture를 보강한다. 미래 사용량 예약이나 실행 수 기반 분산은 별도 범위로 유지한다.

선택 검증은 안전 불변 조건이나 필수 검증을 면제하지 않는다. 실제 로그인·로그아웃·계정 삭제·
운영 재로드·게시·push는 별도 허가 없이 수행하지 않는다.

## 남은 제약과 완료 판정

초기 모델 대응과 명시 모델 전달은 제한된 관측·정적 조사에 기반한 가정으로 다룬다.
필수 합성 양성·회귀·배포 검증을 통과하면 초기 범위에서 신규 선택 capability를 실험적으로
켤 수 있다. 실제 생성·모델 대응의 추가 확인은 위 절차로 계속 진행하고 사용 중 발견한 문제를
fixture와 함께 수정한다. 3번이 비활성이어도 초기 범위의 신규 선택은 동작해야 한다.

완료 보고에는 구현·회귀 결과, 가정과 적용 범위, capability·사용자 opt-in 여부, 실제 확인한
버전·생성 경로와 선택 검증의 실행 결과·다음 조치를 구분한다. 모든 요청이 fallback하는 구현은
완료가 아니다. 모델 문맥을 얻지 못한 요청, 초기 대응 범위 밖의 모델, 신선한 quota가 없는
요청의 fallback은 정상적인 제한으로 설명한다.

최저 사용률은 신선도 기준을 만족하는 확인된 후보 snapshot 안에서의 값이다. 생성 직후의 사용량
증가·다른 호스트의 소비까지 즉시 예측하지 않는다. 첫 세션에서 모델을 얻지 못하거나 캐시가
준비되지 않은 경우 기본 계정으로 시작할 수 있다는 제한을 사용자 설명에 포함한다.
CLI가 계정 신원을 제공하지 않거나 외부 로그인 교체를 관측하지 못하는 기존 제약도 유지한다.

관련 경계는 [서버 지침](../server/AGENTS.md), [공유 계약](../shared/AGENTS.md),
[클라이언트 지침](../client/AGENTS.md), [검증 절차](agents/verification.md)를 따른다.
