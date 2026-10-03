# 검증과 개발 실행

실행 코드·테스트·의존성·플러그인 설치 관련 작업 전에 읽는다.
아래 명령은 레포 루트 기준이며, 분석 시 존재한 스크립트는 `typecheck`, `test`, `audit:mobile`이다.
명령 목록이 바뀌었다면 [package.json](../../package.json)을 우선한다.

## 준비와 기본 검사

Node.js와 npm을 사용하고 기존 `package-lock.json`을 유지한다.
분석 기준 레포에는 `engines`나 별도 Node 버전 고정 파일이 없다. 임의의 최소 버전을
프로젝트의 공식 요구 사항으로 단정하지 않는다. 의존성이 요구하는 엔진 버전도 확인한다.

```sh
npm ci
npm run typecheck
npm test
npm run audit:mobile
```

`npm ci`는 lockfile 기반 설치다. 설치 실패를 숨기기 위해 lockfile 삭제·패키지 매니저 교체·
검증 플래그 완화를 하지 않는다. 의존성을 의도적으로 변경했다면 manifest와 lockfile을 함께 검토한다.
`typecheck`는 `tsconfig.json`과 `tsconfig.server.json`을 모두 실행한다.
`audit:mobile`은 `client/`만 grep하므로 client entrypoint·공유 코드·실제 기기 동작을 보장하지 않는다.
현재 별도 lint/build/dev 스크립트나 `.github/workflows/`는 없다. CI 통과를 확인했다고 쓰지 않는다.

## 변경별 회귀 테스트 위치

표는 테스트를 찾는 출발점이지 완전한 coverage 보장이 아니다. 실제 테스트 사례를 읽고 부족하면 추가한다.

| 변경 | 관련 테스트 |
| --- | --- |
| 계정 선택·제공자 라우팅 | `server/routing.test.ts` |
| Service의 전환·실패·재로드 처리 | `server/failover.test.ts` |
| 인증 홈·공유 링크·설정 동기화·삭제 | `server/homes.test.ts` |
| 공식 한도 알림·시간대·로그아웃 감지 | `server/limits.test.ts` |
| 사용량 파싱·대화 인계문 | `server/parsers.test.ts` |
| 리셋 제안·소비 응답 파싱 | `server/resets.test.ts` |
| 사용량 병합·Retry-After | `server/usage.test.ts` |
| 상태 복구·호환성 | `server/state.test.ts` |
| 계정 식별 키·로그인 중복/재로그인 검사 | `server/identity.test.ts` |
| 제공자 간 권한 수준 대응 | `server/modes.test.ts` |
| 데몬의 브라우저 로그인 가능 여부 | `server/machine.test.ts` |
| 계정·사용량 표시 형식 | `shared/format.test.ts` |

빠른 대상별 실행 예시:

```sh
npm test -- server/routing.test.ts server/failover.test.ts
npm test -- server/homes.test.ts server/state.test.ts
npm test -- server/limits.test.ts server/parsers.test.ts server/resets.test.ts
npm test -- shared/format.test.ts
```

파일·Service 테스트는 기존 `mkdtemp()`와 fake adapter/Paseo 패턴을 따른다.
필요한 `PASEO_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` 등을 임시 디렉토리로 격리하고,
변경한 모든 환경 변수·타이머·리소스를 `afterEach`에서 복구한다. 실제 계정으로 로그인하거나
실제 `~/.paseo`, `~/.claude`, `~/.codex`에 쓰지 않는다. 시간 의존 사례는 고정 시각이나 제어된 clock을 사용한다.

## 고위험 변경의 추가 사례

한도 처리에서는 실제 실행 계정과 binding이 다른 경우, `turnId: null`의 과거 알림,
취소된 턴, 일반 API 오류·용량 429 오탐, 캐시가 새 한도를 지우는 경우를 확인한다.
세션 전환에서는 busy 상태, 재로드 실패·시간 초과, 전환 횟수 제한, Codex 기존 thread 고정을 확인한다.
리셋에서는 동시 실패·중복 요청·이미 해소된 한도·결과 불명확 응답을 확인한다.
인계에서는 중복 continuation 방지·workspace 유지·reasoning 제외·권한 상승 방지를 확인한다.
파일 처리에서는 공유 원본 보호, 중첩 symlink, 부분 상태 손상, 임시 읽기 오류를 확인한다.
이 목록 전체가 이미 자동 테스트로 구현돼 있다고 가정하지 않는다.

## Paseo에서의 수동 확인

플러그인 설치·재로드는 대상 데몬의 상태를 바꾼다. 사용자가 허용한 개발 호스트와 테스트 계정에서만 실행한다.
필요한 Claude/Codex CLI가 그 호스트에 있어야 하며, 클라이언트 컴퓨터의 CLI 설치 여부와 혼동하지 않는다.

```sh
paseo plugin install "$(pwd)"
paseo plugin reload zerosub
paseo plugin logs zerosub
```

현재 [README.md](../../README.md)의 개발 절차를 따른다. 일반적인 `npm run dev`로 대체하지 않는다.
확인 항목은 변경 범위에 맞춰 고른다: Accounts 화면, compact 레이아웃, 접근성,
호스트 선택·오프라인 상태, 브라우저/코드 로그인, 기본 계정·개별 계정 전환, pending/continuation 표시.
리셋 소모·로그아웃·계정 삭제·사용자 작업 중인 에이전트 재로드는 단순 smoke test로 자동 실행하지 않는다.
로그를 보고서에 첨부할 때 토큰·이메일·기기 코드·개인 경로 등 민감한 값은 필요한 범위에서 가린다.

## 배포물 확인

```sh
npm pack --dry-run
```

이는 포함 파일 확인이며, 배포 설치 성공을 증명하는 명령은 아니다.
`package.json.files`의 entrypoint·`paseo-plugin.json`·client/server/shared 코드와 테스트 제외를 확인한다.
하위 디렉토리의 `AGENTS.md`도 패키지에 포함될 수 있고, 루트 `docs/`는 현재 allowlist에 없다.
문서 배포 범위를 바꾸려면 별도 변경으로 검토하며 이 가이드를 넣는 과정에서 manifest를 자동 수정하지 않는다.

npm 설치에는 devDependencies가 없을 수 있다. 배포 소스에서 타입 전용 import도 해석될 수 있으므로
특히 서버의 `@getpaseo/protocol` import를 재도입하지 않는다. SDK 기반 타입을 재사용한다.
관련 변경은 개발 checkout의 node_modules를 참조하지 않는 별도 패키지·Paseo 설치 환경에서도 확인한다.
새로운 외부 의존성은 호스트 제공 여부와 패키지 포함 여부를 확인한다. `npm publish`는 실행하지 않는다.

## 결과 보고

실제로 실행한 명령, 성공·실패, 오류 요약, 환경 제약을 구분해 적는다.
네트워크·CLI·데몬이 없어서 못 한 검사를 성공으로 쓰지 않는다.
문서만 바꿨다면 링크와 파일 경로 검증을 수행하고, 코드 테스트·수동 설치를 생략했다고 명시한다.
회귀 테스트 결과와 실계정·멀티호스트·모바일 통합 검증 결과를 구분한다.
