# AGENTS.md

ZeroSub은 Paseo에서 여러 Claude·ChatGPT(Codex) 구독 계정을 사용하는 TypeScript 플러그인이다.
독립 웹앱이나 인증 프록시가 아니다. 현재 체크아웃을 수정 대상으로 삼고, 패키지명
`@kapybara/zerosub`과 플러그인 ID `zerosub`을 요청 없이 변경하지 않는다.

## 작업 시작과 문서 선택

먼저 `git status --short`, `package.json`, 수정할 코드와 인접 테스트를 확인한다.
기존 작업을 보존하고, 아래 지침은 해당 영역을 수정하기 전에 명시적으로 읽는다.
하위 `AGENTS.md`가 실행 도구에 의해 자동으로 로드된다고 가정하지 않는다.

| 작업 범위 | 먼저 읽을 문서 |
| --- | --- |
| `client/**`, `index.client.tsx` | [클라이언트 지침](client/AGENTS.md) |
| `server/**`, `index.server.ts` | [서버 지침](server/AGENTS.md) |
| `shared/**` | [공유 계약 지침](shared/AGENTS.md), 영향받는 클라이언트·서버 지침 |
| 구조 탐색, 계정·세션 흐름, 제공자 확장 | [아키텍처](docs/agents/architecture.md) |
| 테스트, 의존성, 설치·배포 관련 변경 | [검증 절차](docs/agents/verification.md) |

모든 문서를 무조건 읽지 말고 작업에 필요한 것만 읽는다.
세부 동작·버전·명령은 현재 소스와 `package.json`을 확인하며, 문서가 낡았다면 함께 고친다.

## 빠른 명령

레포 루트에서 실행한다. npm과 `package-lock.json`을 사용한다.

```sh
npm ci
npm run typecheck
npm test
npm run audit:mobile
```

`typecheck`는 클라이언트와 서버를 별도로 검사한다. `test`는 Vitest 단발 실행이다.
`audit:mobile`은 `client/`의 DOM·HTML 사용을 찾는 정규식 검사이지, 실제 모바일 테스트가 아니다.
현재 `build`, `dev`, `lint` 스크립트는 없다. 존재하지 않는 명령을 만들어 안내하지 않는다.
Paseo에 설치·재로드하는 수동 검증은 검증 문서의 조건을 먼저 확인한다.

## 공통 불변 조건

- 인증 정보는 공식 CLI가 소유한다. 계정·호스트 사이에서 자격 증명을 복사하지 않고,
  자체 OAuth나 refresh-token 갱신을 구현하지 않는다. 토큰을 로그·RPC·레지스트리에 넣지 않는다.
- Claude의 기존 대화는 다른 계정으로 다시 열 수 있지만, 이력이 있는 Codex 대화는
  계정에 고정된다. Codex 전환은 새 continuation agent로 처리하고 기존 대화를 보존한다.
- 실행 중인 턴을 계정 전환 때문에 중단하지 않는다. 라우팅 실패가 세션 시작을 막지 않게 하고,
  실제 실행 계정과 다음 세션에 사용할 계정을 구분한다.
- 호스트별 계정·설정 경계를 유지한다. 별도 API 키·엔드포인트·인증 홈을 지정한 제공자를
  구독 계정 라우팅으로 강제 전환하지 않는다.
- 리셋 크레딧 자동 사용과 다른 제공자로의 자동 fork는 기본적으로 꺼져 있어야 한다.
  fork의 권한 수준은 원본보다 높이지 않는다. 동등하거나 더 제한적인 모드가 없으면 중단한다.
- 상태는 `StateStore.update()`와 원자적 쓰기 경로를 통해 변경한다. 관리 홈 정리·동기화 중
  실제 CLI 홈이나 공유 링크의 원본을 삭제·교체하지 않는다.

## 코드와 경계

기존의 2칸 들여쓰기, 큰따옴표, 세미콜론, 확장자 없는 상대 import를 따른다.
TypeScript의 `strict`와 `noUncheckedIndexedAccess`를 유지하고, 외부 응답은 검증한 뒤 사용한다.
관련 없는 재포맷·추상화·의존성 추가를 섞지 않는다.

`client/`는 React Native, `server/`는 Node.js, `shared/`는 양쪽에서 사용하는 계약이다.
공유 코드에 Node.js·DOM 의존성을 넣지 않는다. RPC·설정·타임라인 변경은 Zod 스키마,
생산자, 소비자, 기본값·기존 데이터 호환성을 함께 확인한다.

Paseo는 배포된 플러그인의 소스를 처리하며, npm 설치에는 개발 의존성이 없을 수 있다.
타입 전용 import도 배포 시 해석될 수 있으므로 로컬 typecheck 통과만 믿지 않는다.
서버에서 `@getpaseo/protocol`의 타입을 다시 import하지 말고,
`server/adapter.ts`의 SDK 기반 `AgentTimelineItem`을 재사용한다.

## 변경 완료 기준

실행 코드 변경은 관련 회귀 테스트를 추가·수정하고, 가능하면 위의 세 검증 명령을 모두 실행한다.
의존성·entrypoint·배포 파일 변경에는 `npm pack --dry-run`과 별도 설치 검증도 필요하다.
문서만 변경했다면 경로·링크·명령을 확인하고 런타임 테스트 생략 사실을 밝힌다.

완료 보고에는 변경 내용, 실제 실행한 명령과 결과, 미실행 검증과 이유, 남은 위험을 적는다.
실제 로그인·리셋 사용·계정 삭제·운영 에이전트 재로드·게시·push는 별도 허가 없이 수행하지 않는다.
동작이 바뀌면 `README.md`와 해당 상세 지침만 갱신하고, 루트에 긴 구현 설명을 누적하지 않는다.
