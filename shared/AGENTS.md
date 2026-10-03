# 공유 계약 작업 지침

`shared/**`를 수정할 때 [루트 지침](../AGENTS.md)에 더해 적용한다.
이 코드는 클라이언트·서버 양쪽 TypeScript 검사와 배포 경계에 걸친다.
Node.js 파일·프로세스 API, React Native UI, DOM, 서버 구현을 import하지 않는다.

## 변경 단위

Zod 스키마를 계약의 기준으로 삼고 타입은 `z.infer`·`z.output` 등으로 유도한다.
스키마 기본값 때문에 입력과 출력 타입이 다를 수 있으므로 RPC 입력을 출력 타입으로 억지 캐스팅하지 않는다.
새로운 필드나 enum을 추가할 때 다음 연결을 함께 확인한다.

| 계약 | 함께 확인할 위치 |
| --- | --- |
| `model.ts` | `Service.view()`와 클라이언트의 상태·로그인·계정 표시 |
| `rpc.ts` | `index.server.ts`의 handler, `client/`의 호출부와 결과 처리 |
| `preferences.ts` | `Service`의 `DEFAULT_PREFERENCES`, 설정 화면·Accounts 화면 |
| `timeline.ts` | 서버 append 경로, `index.client.tsx`의 등록, `client/switch-row.tsx` |
| `format.ts` | `format.test.ts`, 사용량·계정 UI |

## 호환성과 의미

RPC 이름 `zerosub.*`, 플러그인 ID, 타임라인 kind/version을 임의로 바꾸지 않는다.
저장된 상태와 과거 타임라인을 고려해 optional/default/null 의미를 유지한다.
비호환 변경은 필요한 버전·마이그레이션과 이전 데이터 검증을 함께 설계한다.
`server/state.ts`의 저장 스키마는 별도이므로 view model 변경만으로 저장 형식이 바뀐다고 가정하지 않는다.

사용량의 unknown·cached·error·실제 수치, 계정의 current·pending·pinned를 구분한다.
`switched`, `pending`, `continued`, `stayed`, `reset` 결과를 하나로 합치지 않는다.
로그인 화면에 필요한 일시적 URL·device code 외의 인증 비밀은 공유 view model에 추가하지 않는다.

`FamilySchema`에 제공자를 추가하는 것만으로 지원이 완성되지 않는다. adapter, resolver,
상태 기본값, Service의 제공자 목록, UI 목록·라벨·RPC·테스트를 함께 확인한다.
관련 클라이언트·서버 지침을 읽고, `npm run typecheck`로 양쪽을 모두 검사한다.
