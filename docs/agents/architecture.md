# ZeroSub 아키텍처와 탐색 지도

분석 기준: `uwoobeat/zerosub`의 `main`, 커밋 `2354700ad8749bebc3cff142190c37e1a7bd8999`.
이 문서는 탐색용 지도다. 수정 시에는 현재 소스를 다시 확인하고 영향받는 내용을 갱신한다.

## 실행 모델

ZeroSub은 Paseo가 실행하는 플러그인이다. 클라이언트 등록은 [index.client.tsx](../../index.client.tsx),
서버 등록은 [index.server.ts](../../index.server.ts)가 맡고, 요구 버전은
[paseo-plugin.json](../../paseo-plugin.json)에 정의된다. 분석 기준 요구 버전은 Paseo 0.9.1 이상이다.
패키지 메타데이터는 `@kapybara/zerosub`을 사용하고 upstream 저장소를 가리킨다.
현재 작업 저장소 주소가 다르다는 이유만으로 이름·설치 예시·upstream 메타데이터를 일괄 치환하지 않는다.

클라이언트는 React Native UI이고 서버는 Node.js에서 공식 CLI를 실행한다.
RPC·view model·설정·타임라인은 Zod 기반 공유 계약이다. 독립 웹 서버나 자체 OAuth 서버는 없다.
일반 개발 명령은 [package.json](../../package.json), 사용자 기능 설명은 [README.md](../../README.md)를 읽는다.

## 어디를 수정할 것인가

| 관심사 | 주된 소스 |
| --- | --- |
| hook·RPC 등록과 종료 정리 | `index.server.ts`, `index.client.tsx` |
| 계정·로그인·사용량·failover 조정 | [server/service.ts](../../server/service.ts) |
| 제공자 인터페이스와 환경 적용 | [server/adapter.ts](../../server/adapter.ts) |
| 공식 CLI 연동 | [server/claude.ts](../../server/claude.ts), [server/codex.ts](../../server/codex.ts) |
| Codex 계정 식별 키(워크스페이스+멤버)·기존 키 호환 비교 | [server/identity.ts](../../server/identity.ts) |
| 제공자 profile 식별·별도 인증 제외 | [server/families.ts](../../server/families.ts) |
| 계정 선택·잔량 순위·binding | [server/routing.ts](../../server/routing.ts) |
| 한도·로그아웃·리셋 시각 파싱 | [server/limits.ts](../../server/limits.ts) |
| 사용량 캐시 병합·저장 | [server/usage.ts](../../server/usage.ts) |
| 리셋 응답 정규화 | [server/claude-resets.ts](../../server/claude-resets.ts), `server/codex.ts` |
| 계정 홈·symlink·경로 | [server/homes.ts](../../server/homes.ts), [server/paths.ts](../../server/paths.ts) |
| 상태 검증·복구·원자적 파일 쓰기 | [server/state.ts](../../server/state.ts), [server/json-file.ts](../../server/json-file.ts) |
| 세션 재시작·전환 횟수 제한 | [server/reopen.ts](../../server/reopen.ts), [server/switch-guard.ts](../../server/switch-guard.ts) |
| 새 대화로 인계·권한 대응 | [server/handoff.ts](../../server/handoff.ts), [server/modes.ts](../../server/modes.ts) |
| CLI 탐색·실행·헤드리스 판별 | `server/binaries.ts`, `server/process.ts`, `server/machine.ts` |
| 계정 화면·로그인 | `client/accounts-surface.tsx`, `client/add-account.tsx` |
| 공용 상태 폴링 | [client/store.ts](../../client/store.ts) |
| composer pill·명령·타임라인 | `client/pills.ts`, `client/commands.ts`, `client/switch-row.tsx` |
| 리셋·fork 확인과 설정 | `client/reset-confirm.tsx`, `client/fork-confirm.tsx`, `client/settings-screen.tsx` |
| 공용 UI | [client/ui.tsx](../../client/ui.tsx) |
| 계약·표시 형식 | `shared/model.ts`, `shared/rpc.ts`, `shared/preferences.ts`, `shared/timeline.ts`, `shared/format.ts` |

## 중요한 데이터 흐름

세션 생성·재개·갱신·import → `agent.session_open` → `FamilyResolver` → `chooseAccount()` →
필요한 관리 홈 준비 → binding/실제 세션 기록 → `applyEnv()`로 CLI 인증 홈 지정.
일반 상태 조회에서 공식 제공자 API를 매번 호출하지 않는다. Service가 사용량을 갱신하고
클라이언트의 `ZeroSubStore`는 상태를 공유한다.

턴 종료 → adapter의 공식 한도·로그아웃 알림 감지 → 실제 실행 계정 확인 → 계정별 직렬화 →
사용 가능한 계정 선택 → Claude 재오픈 또는 Codex continuation.
대체 계정이 없으면 설정·조건에 따라 banked reset, 다른 제공자 fork, 중단 안내로 이어진다.
라우팅의 목표 계정과 실행 중 세션의 계정은 전환 완료 전까지 다를 수 있다.

## 데이터와 인증 경계

`PASEO_HOME`의 기본값은 `~/.paseo`다. ZeroSub 데이터는 그 아래 `zerosub/`에 둔다.
`state.json`은 계정 메타데이터·기본 계정·binding·세션, `usage.json`은 사용량 캐시,
`homes/`는 관리 계정의 인증 홈이다. CLI 자신의 로그인은 `kind: "main"`, `home: null`로 표현한다.

Claude 관리 홈에는 `CLAUDE_CONFIG_DIR`와 `CLAUDE_SECURESTORAGE_CONFIG_DIR`를 적용한다.
Codex에는 `CODEX_HOME`과 필요한 `CODEX_SQLITE_HOME`을 적용한다. 환경 상속·config 설정의
우선순위는 `paths.ts`, adapter의 `env()`, `codexSqliteHome()`을 읽는다.
공유 여부는 `homes.ts`의 private 정책이 기준이다. 예를 들어 Codex의 `plugins`는 private 목록에
포함된다. README의 개괄 설명을 “모든 파일을 공유한다”는 구현 규칙으로 해석하지 않는다.

## 변경 범위를 고르는 기준

UI 표시 변경은 가능하면 `client/`에 국한한다. 제공자 응답 변경은 adapter의 파서와 fixture를 먼저
수정한다. 선택 정책은 `routing.ts`, 전환 조정은 `Service`, 저장 호환성은 `state.ts`에서 다룬다.
새 구독 제공자 추가는 단일 adapter 작업이 아니다. `Family` 계약, resolver, 상태 기본값,
Service·UI의 제공자 목록, 로그인 방식, portability, 권한 대응, 패키징과 테스트를 함께 검토한다.

관련 안전 규칙은 [서버 지침](../../server/AGENTS.md), 검증 방법은
[검증 절차](verification.md)를 읽는다.
