# 클라이언트 작업 지침

`client/**`와 `index.client.tsx`를 수정할 때 [루트 지침](../AGENTS.md)에 더해 적용한다.
진입점은 등록·정리 작업을 담당하고, 화면·상태 로직은 `client/`에 둔다.

## 화면과 플랫폼

- React Native의 `View`, `Text`, `Pressable`, `ScrollView` 등을 사용한다.
  DOM 태그, `className`, `onClick`, `window`, `document`, `localStorage`, `navigator`를 도입하지 않는다.
- 아이콘·모달·입력·toast에는 기존 `@getpaseo/plugin/client/react-native` 사용 패턴을 따른다.
  버튼·카드·사용량 표시에는 `ui.tsx`를 우선 재사용한다.
- 색상은 호스트 `theme` 토큰을 사용하고, `layout.compact`와 좁은 화면을 고려한다.
  접근성 이름, disabled/busy 상태, 터치 조작을 유지한다. hover만으로 기능을 제공하지 않는다.
- 사용자 문구는 현재 UI의 용어를 따른다. pending 전환, 새 에이전트 continuation,
  리셋 성공·실패를 같은 성공 상태로 표현하지 않는다.

## 상태·RPC·호스트

`ZeroSubStore`가 설치 인스턴스별 공용 폴러다. 화면마다 독립 폴러를 만들지 않는다.
`useStore()`로 구독하고, 변경 작업은 가능한 한 `store.rpc()`를 사용하여 후속 상태 갱신을 유지한다.
오래된 응답이 최신 상태를 덮어쓰지 않도록 sequence와 in-flight 제어를 보존한다.

일반 화면 갱신은 서버의 캐시 상태를 읽는다. 실제 제공자 사용량 갱신을 요청하는
`refreshUsage: true`를 일반 폴링에 추가하지 않는다. 로그인 중 빠른 폴링은 `watchClosely()`,
화면 표시 중에는 `watch(VISIBLE_POLL_MS)`를 사용하고 반환된 정리 함수를 호출한다.

계정·설정·로그인·composer pill의 동작은 대상 호스트에 귀속되어야 한다.
다른 호스트의 계정 ID나 스냅샷을 재사용하지 않는다. 연결 실패 시 마지막 상태와 오류를 구분한다.
브라우저 콜백은 데몬 호스트 기준이다. 원격·모바일·헤드리스 환경의 코드 로그인 경로를 유지한다.

## 확인이 필요한 변경

RPC 또는 view model 변경은 [공유 계약 지침](../shared/AGENTS.md)을 읽는다.
설정 UI를 바꾸면 `accounts-surface.tsx`와 `settings-screen.tsx`의 양쪽 노출을 확인한다.
리셋·다른 제공자로의 수동 fork에는 기존 확인 대화상자를 유지한다.

`index.client.tsx`의 반환 정리 함수와 컴포넌트 effect cleanup에서 구독·타이머를 해제한다.
검증은 [검증 절차](../docs/agents/verification.md)를 따른다.
`audit:mobile`이 검사하지 않는 `index.client.tsx`와 공유 코드도 직접 확인한다.
