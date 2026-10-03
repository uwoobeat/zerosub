# 서버 작업 지침

`server/**`와 `index.server.ts`를 수정할 때 [루트 지침](../AGENTS.md)에 더해 적용한다.
관련 함수와 테스트를 먼저 읽고, 큰 `service.ts` 전체를 무관한 리팩터링 대상으로 삼지 않는다.

## 책임 배치

`Service`는 계정·로그인·사용량·전환의 조정자다. 제공자별 처리는 `FamilyAdapter` 구현,
순수 선택은 `routing.ts`, 알림 파싱은 `limits.ts`, 파일 관리는 `homes.ts`·`state.ts`에 둔다.
파일별 탐색 경로는 [아키텍처](../docs/agents/architecture.md)를 확인한다.

## 세션과 계정 전환

- `agent.session_open`은 create/resume/refresh/import를 모두 처리한다.
  진입점의 15초 제한과 오류 시 `undefined` 반환을 보존한다. 불필요한 네트워크 조회나
  로그인 작업을 hook의 필수 경로로 추가하지 않는다.
- `state.bindings`는 원하는 계정, `state.sessions`는 실제로 열린 세션의 계정이다.
  실패·사용량의 책임 계정은 `runningOn()`을 기준으로 판단한다. 기록되지 않은 기존 세션은
  기본 설정 계정이 아니라 해당 제공자의 CLI 로그인으로 취급한다.
- 요청의 나머지 필드를 보존하고 환경 변수만 `applyEnv()`로 변경한다.
  `EnvPatch`의 `null`은 데몬 환경 상속이다. 세션 override에서는 키를 제거하지만,
  `spawnEnv()`에서는 부모 환경을 삭제하지 않는다. 빈 문자열과 혼동하지 않는다.
- `FamilyResolver`의 별도 인증·엔드포인트 제공자 제외 규칙과 사용자 선택 경쟁 방지를 유지한다.
  기존 Codex import는 CLI 로그인에 귀속시키고, 기존 대화의 thread binding을 보존한다.
- 사용 중인 턴의 전환은 끝날 때까지 미룬다. SDK `agents.ref(id).refresh()`는 데이터 조회이지
  세션 재시작이 아니다. 재시작은 `Reopener`의 `paseo agent reload` 경로를 사용한다.
  재로드 실패·시간 초과를 성공으로 단정하거나 확인되지 않은 계정에서 자동 계속하지 않는다.

## 한도·사용량·동시성

공식 CLI의 한도·로그아웃 알림만 감지한다. 일반 `429`, 용량 오류, 낮은 잔량 경고,
사용자·도구 출력의 “limit” 문자열로 계정을 전환하지 않는다. `turnId === null`인 실패에서
이전 턴의 타임라인을 새 실패 원인으로 재해석하지 않는다. 취소된 턴은 별도로 취급한다.

`window` 한도와 `budget` 한도를 구분한다. 사용량 조회만으로 지출 한도를 해제하지 않는다.
알 수 없는 사용량을 0%로 간주하지 않고, 최신 한도 알림을 오래된 캐시로 즉시 지우지 않는다.
`usageSpacingMs`, `Retry-After`, 캐시 병합, in-flight 중복 방지와 최신 읽기 우선순위를 보존한다.
명시적 사용자 요청이 아닌 주기적 폴링에서 Claude 로그인 갱신을 실행하지 않는다.

계정별 failover·reset 잠금과 에이전트별 전환 중 상태를 유지한다.
`SwitchGuard`의 기본 제한은 에이전트당 10분에 4회다. 시간·횟수·알림 정책을 바꾸면
반복 전환과 동시 실패의 회귀 테스트를 함께 수정한다.

## 리셋과 continuation

`autoRedeem`·`forkOtherProvider`의 기본값은 false다. 모든 계정이 소진된 자동 처리에서
옵트인 리셋, 옵트인 다른 제공자 fork, 중단 알림의 순서와 조건을 유지한다.
자동 리셋은 `onlyAtLimit`로 제공자의 현재 상태를 재확인하고, 최근 리셋·중복 실패·
`not_limited`·결과 불명확 응답을 구분한다. 프로세스 내부 Mutex를 멀티호스트 잠금으로 취급하지 않는다.

Codex의 계정 변경에는 `continueInNewAgent()`를 사용한다. 원본 workspace/cwd와 원본 대화를
유지하고, 생성 전에 새 계정을 bind한다. 이전 continuation을 재사용하는 중복 방지 경로를 보존한다.
전달문에는 기존 대화·작업 요약만 포함하고 reasoning이나 원시 도구 출력을 추가하지 않는다.
같은 제공자에서만 model/mode/thinking 설정을 이어받는다. 다른 제공자에서는 대상 기본 모델과
`equivalentMode()`를 사용한다. 모드가 불명확하거나 안전한 대응 모드가 없으면 fork하지 않는다.

## 인증 홈과 영속 데이터

- 인증은 공식 CLI의 login/logout과 자체 저장소를 사용한다. 자체 토큰 갱신을 추가하지 않는다.
  토큰·키체인 출력·전체 인증 응답·로그인 코드를 로깅하거나 테스트 fixture로 커밋하지 않는다.
- `paths.ts`를 재사용하여 `PASEO_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` 등을 존중한다.
  `~/.claude`·`~/.codex`를 직접 하드코딩하지 않는다.
- 공유 항목과 비공개 항목은 `homes.ts`의 정책을 따른다. “인증 파일 외에는 전부 공유”로
  단순화하지 않는다. Claude `.claude.json`의 계정 식별 정보는 별도이며, Codex는 private 항목과
  공유 `sessions`·SQLite 홈의 차이를 유지한다.
- 링크는 실제 대상을 확인하는 기존 로직을 보존한다. 삭제는 ZeroSub 관리 홈 내부로 제한하고,
  공유 symlink 원본을 따라가서 지우지 않는다. CLI 로그인은 제거할 수 없어야 한다.
  실행 중인 세션·진행 중 로그인·계정에 고정된 Codex 대화가 있는 홈은 성급히 정리하지 않는다.
- 상태 변경은 `StateStore.update()`로 직렬화·검증·원자적 저장한다. 일부 잘못된 레코드 때문에
  전체 계정·thread binding을 버리지 않는다. 복구용 백업, 일시적 읽기 오류의 전파,
  불완전한 에이전트 목록에서 pruning하지 않는 동작을 유지한다.

파일·디렉토리의 기존 제한적 권한(기본 파일 0600, 관리 디렉토리 0700)을 약화하지 않는다.
프로세스 실행은 `providerCommand()`, `run()`, `Reopener`의 기존 경로 탐색·시간 제한을 재사용한다.
테스트는 fake adapter/Paseo와 임시 홈으로 수행한다. 실제 로그아웃·삭제·리셋으로 재현하지 않는다.
검증 범위는 [검증 절차](../docs/agents/verification.md)에서 선택한다.
