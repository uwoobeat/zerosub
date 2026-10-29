# Antigravity 작업별 계정 탭 재사용·증분 인계 계획

작성일: 2026-10-29. [Antigravity 전체 로드맵](antigravity-support-plan.md)의
남은 작업 중 2번에 대한 실행 계획이다.

## 범위와 목표

Antigravity의 수동 계정 전환에서 작업별 탭 재사용과 증분 인계를 구현한다. 목표는 같은
작업·호환 설정에서 A→B→A→B 전환을 두 탭으로 처리하고, 돌아온 탭에는 아직 전달하지
않은 지시와 진행 내용만 인계하는 것이다.

추가 실계정 인증 검증, 그룹 자동 전환, macOS 로그인, 별도 composer 문구 정리와 운영
재로드는 이번 구현 범위에 포함하지 않는다. 자동 전환 capability는 계속 비활성이다.

## 사전 확인

사전 탐색에서는 설치된 Paseo 0.13.2의 native provider가 저장한 conversation ID를
`--conversation`으로 넘기고, 재개한 ID의 일치 여부를 검사하며, prompt의
`clientMessageId`를 턴 수락 응답에 돌려주는 코드를 확인했다. 이는 설치 소스의 계약 확인이며
실제 기존 AGY 탭 재개나 데몬 재시작 뒤 타임라인 복원을 검증한 결과는 아니다.

## 구현 순서

실행 순서는 다음과 같다. 각 단계의 완료 조건을 확인한 뒤 다음 단계로 진행한다.

| 단계 | 구현·확인할 내용 | 완료 조건 |
| --- | --- | --- |
| 1. 기존 탭 재개 계약 확인 | 설치된 Paseo의 native AGY 구현과 SDK에서 같은 계정의 기존 conversation 재개, timeline의 epoch·seq, `clientMessageId`·`turnId` 수신을 조사한다. 요청한 canonical projection이 실제로 제공되는지도 확인하고 합성 provider/SDK 검사로 실패 동작을 고정한다. | 기존 conversation 재개와 타임라인 복원 여부를 각각 판단한다. 지원하지 않거나 필요한 이력이 없으면 재사용 요청을 중단하고 대상 탭·문맥 재제공을 안내하는 조건이 정해져 있다. |
| 2. AGY 전용 상태와 조정자 | `server/antigravity-continuations.ts`를 추가하고 `server/state.ts`에 기본값 `{}`인 `antigravityContinuations`를 둔다. Codex의 `CodexContinuations`와 저장 체인을 분리하고 `handoff.ts`의 전사·축약·새 agent 생성 helper를 재사용한다. | 이전 state가 그대로 로드되며, AGY 레코드 손상·추가가 Codex 체인이나 계정 데이터를 손실시키지 않는다. 상태 변경은 `StateStore.update()`로 저장한다. |
| 3. 수동 전환과 탭 재사용 | `Service.setAgentAccount()`와 `continueElsewhere()`에 AGY 조정자를 연결한다. 작업 root별 잠금으로 전환을 직렬화하고, 같은 작업·계정·workspace·provider·모델·권한·thinking/기능 설정의 탭을 찾는다. | A→B→A→B에서 두 탭을 재사용한다. 설정이 다른 경우에는 호환 설정의 새 탭을 만들며 기존 탭을 보존한다. 같은 workspace의 독립 작업은 합치지 않는다. 작업의 어느 탭이든 실행 중이거나 권한 요청 중이면 전환을 시작하지 않는다. |
| 4. 증분 인계와 이전 탭 채택 | 대상 탭이 알고 있는 source별 timeline cursor 이후의 지시·진행 내용만 모아 전달한다. `zerosub.continued-from` 관계로 기존 AGY continuation을 채택하고 실제 계정·workspace를 검증한다. | A/B/C 왕복과 어느 탭에서 시작한 전환에서도 새 지시가 누락되지 않고, 자체 인계문이 반복 중첩되지 않는다. 독립적으로 기준 문맥을 확인할 수 있는 멤버가 없거나 parked member timeline을 읽지 못하면 중단한다. SDK가 projected entry로 저장 cursor를 가로지르면 그 handoff도 중단한다. |
| 5. 전달 예약과 장애 복구 | 생성 전 대상 ID·계정 binding을 예약하고, 생성/전송 단계·메시지 ID·전달할 범위의 커서와 불확실한 send의 정확한 prompt를 영속화한다. 생성에는 같은 대상 ID의 `idempotencyKey`를 사용한다. 전송 직전에 계정·설정·busy 상태를 재확인한다. | 동일 요청·동시 요청·연결 끊김·플러그인 재시작에서 탭과 인계가 중복 생성되지 않는다. 정상 응답은 timeline receipt로 확인하고, 응답 유실 뒤에는 같은 prompt와 message ID만 재시도한다. 완료 뒤 pending prompt를 지우며, outcome이 여전히 unknown이면 대상 확인을 안내한다. |
| 6. 회귀 검증과 문서 반영 | AGY 조정자 단위 검사와 실제 SDK를 거치는 합성 daemon 검사를 추가한다. Service·state 호환성·기존 Codex 회귀를 실행하고 README 및 해당 서버·아키텍처·검증 지침을 갱신한다. | 아래 검증 항목과 기본 세 명령이 통과한다. npm 패키지를 개발 의존성 없이 별도 설치해 새 모듈이 Paseo에서 컴파일·평가됨을 확인한다. 실제 native 재개 동작은 합성 검사 결과와 구분해 보고한다. |

## 상태와 계정 귀속

상태와 계정 귀속은 다음처럼 설계한다.

- 작업 root마다 현재 탭, 멤버별 계정 ID·인증 namespace·관측한 재로그인 세대와 실행 설정,
  대상 탭이 이미 받은 source별 `epoch`·`seq`, 각 탭의 마지막 확인 epoch와 snapshot 시각을 기록한다.
  전송 중에는 source/target ID, 메시지 ID, 생성/전송 단계와 예약한 커서 범위를 추가한다.
  receipt가 불확실한 동안에는 동일 ID로 안전하게 재시도하기 위해 정확한 prompt를 보호된 plugin state에
  임시 저장하고, 전달이 확정되면 제거한다.
- 현재 탭은 마지막으로 인계를 확정한 탭을 기본으로 한다. 사용자가 주차된 다른 멤버 탭에
  직접 새 지시를 남기면 그 탭에서 작업을 이어갈 수 있도록 판정한다. 어느 멤버에서 전환을
  요청하든 다른 멤버의 미전달 지시도 수집하며, 최신 중지·완료 지시를 인계문에 보존한다.
- AGY의 `identity`·이메일은 unknown일 수 있으므로 Codex의 `identity !== null` 재사용 조건을
  그대로 적용하지 않는다. 등록 계정 ID·인증 홈·실제 session 귀속과 재로그인 세대를 검사하고,
  관측된 재로그인·계정 교체 이후에는 이전 멤버를 재사용 후보에서 제외한다. Google 신원의
  unknown 상태와 외부 CLI에서 관측 없이 로그인 계정이 바뀔 수 있다는 한계는 유지한다.
- 기존 탭의 계정은 `sessions`의 실제 실행 계정을 우선해 확인한다. 인증 홈 변경·계정 제거·
  별도 인증 provider·workspace 이동·archive를 발견하면 해당 탭을 재사용하지 않는다.
  후보가 여러 개이고 계보·귀속을 확정할 수 없으면 임의로 합치지 않고 확인을 안내한다.
- 플러그인만 재시작했을 때에는 영속화한 커서와 전달 수신 기록으로 복구한다. 데몬 재시작이나
  epoch 변경·타임라인 gap·멤버 삭제로 필요한 이력을 확보할 수 없으면 자동 재사용을 중단한다.
  CLI가 기존 conversation을 재개할 수 있다는 사실만으로 Paseo timeline 복원을 판단하지 않는다.
- 목록에서 빠진 멤버는 `refresh()`로 다시 확인한다. 삭제된 역사 멤버는 가능한 미전달 문맥의
  흔적으로 보존하고, 다른 멤버가 기준 문맥을 입증하지 못하면 handoff를 중단한다. 생성 중 pending은
  전송 전 다른 계정이 선택되면 예약을 해제하고, 불확실한 send는 동일 prompt/message ID receipt로
  먼저 해소한다. 기존 RPC의 `continuedIn` 결과와 원본 대화 보존을 유지한다.

## 완료 조건

- 같은 작업의 A→B→A→B 전환은 호환되는 계정별 탭 두 개를 재사용한다. 같은 workspace의
  독립 작업은 별도 체인을 유지한다. 계정 식별·모델·권한 설정과 원본 workspace 경계를 확인한다.
- 각 탭에 전달한 타임라인 위치를 기록해 새 지시와 진행 내용만 추가로 인계한다. 이전
  인계문의 중첩 축약은 이미 공통 `handoff.ts`를 통해 적용되므로 기존 동작을 보존한다.
- 작업별 현재 탭과 전환 잠금을 관리한다. 실행 중인 턴·권한 요청을 보존하고, 다른 멤버
  탭에서 작업이 중복 시작되지 않게 한다.
- 전달 예약·메시지 식별자·확인 결과를 영속화하고, 중복 요청·연결 끊김·프로세스 재시작에도
  같은 인계가 다시 실행되지 않게 한다. 전송 여부가 불명확하면 대상 탭 확인을 안내한다.
- Antigravity CLI의 기존 대화 재개와 Paseo 타임라인 확보를 각각 검증한다. 특히 데몬 재시작 후
  필요한 문맥을 확보할 수 없으면 자동 재사용을 중단하고 컨텍스트 재제공을 안내한다. 기존
  Codex 탭 재사용·인계 복구 회귀 검사도 함께 통과해야 한다.

## 검증

추가할 회귀 검사는 `server/antigravity-continuations.test.ts`와
`server/continuations.sdk.test.ts`를 중심으로 구성한다. 두 제공자는 같은 합성 daemon을 통한
SDK 검사를 공유해 wire contract와 receipt 동작을 같은 방식으로 확인한다. 기존
`server/service-antigravity.test.ts`, `server/state.test.ts`, `server/handoff.test.ts`를 함께
보완하며, Codex의 `server/continuations.test.ts`·`server/continuations.sdk.test.ts`도 실행한다.
필수 사례는 두 탭 왕복, 세 계정 증분 전달, 독립 작업 분리, 기존 continuation 채택,
unknown identity, 재로그인 뒤 재사용 거부, 모델·권한 불일치, busy·권한 요청,
생성/전송 응답 유실, 플러그인 재시작, 데몬 이력 소실과 불완전 목록에서의 정리 보류다.

기본 검증은 `npm run typecheck`, `npm test`, `npm run audit:mobile`, `git diff --check`다.
새 배포 모듈을 추가하므로 `npm pack --dry-run`과 별도 설치·Paseo 컴파일 검사도 포함한다.
실제 기존 AGY 탭 재개 확인은 허가된 테스트 agent에 한정한다. 실제 로그인·삭제·운영 재로드는
이번 실행 단계에 포함하지 않는다.

## 관련 자료

검증 근거와 제약은 [Linux 인증 격리 보고서](antigravity-linux-isolation.md),
[macOS 인증 격리 보고서](antigravity-macos-isolation.md)에 기록했다. 관련 코드와 회귀 검사는
[어댑터](../server/antigravity.ts), [Service 검사](../server/service-antigravity.test.ts),
[검증 절차](agents/verification.md)를 참고한다.

## 구현 결과 (2026-10-29)

- AGY 전용 `AntigravityContinuations` 상태와 manager를 추가했다. Codex 체인과 분리하고,
  실제 session 계정·home·관측한 인증 세대·workspace·모델·권한·thinking·기능이 일치할 때만 탭을 재사용한다.
- `zerosub.continued-from` 계보를 따라 legacy continuation 탭을 채택하고, 같은 계정의 후보가
  여러 개면 중단한다. Paseo timeline의 `epoch/seq` 표시를 저장하지만 요청한 `canonical`
  projection이 보장되지 않으므로, projected entry가 저장 cursor를 가로지르면 전달을 거부한다.
  확인된 이력에서 탭별 미전달 사용자 지시와 assistant 진행만 전달한다. 이력이 읽히지 않거나
  epoch·기준 문맥이 바뀌면 불완전한 인계를 막고 전체 작업 문맥을 새 Antigravity agent에 제공하도록 안내한다.
- 생성·전송 예약에 stable agent ID, message ID, idempotency key와 정확한 prompt를 저장한다.
  전송 결과가 불확실하면 daemon의 영속 message receipt를 확인하고, receipt가 없을 때는 같은
  prompt와 message ID로 재시도한다. 전달이 확정되면 pending prompt를 지운다. 목록에서 빠진
  agent는 개별 `refresh()`로 삭제 여부를 확인하며, 삭제된 역사 멤버는 검증용 tombstone으로 보존한다.
- 회귀 검사에는 상태 복구, unknown identity와 관측된 재로그인, 독립 workspace task, A/B/C 왕복,
  legacy continuation 채택과 중복 후보 거부, busy·permission, 이력 gap/epoch/window 손실,
  생성·전송 응답 유실, plugin restart와 pruning을 포함한다. SDK 검사는 같은 합성 daemon
  harness를 공유한다. Paseo SDK의 busy 재확인과 실제 send 사이에는 원자적 조건부 전송 API가 없어
  마지막 확인 직후 다른 탭이 시작하는 경쟁 구간이 남는다.
- `npm run typecheck`, `npm test`(31 files, 442 tests),
  대상 검사(3 files, 60 tests), `npm run audit:mobile`, `git diff --check`,
  `npm pack --dry-run`과 개발 의존성이 없는 임시 tarball 설치 검증을 실행했다. Paseo 0.13.2의
  `compilePlugin()`으로 client/server bundle을 만들고 `evaluateBundle()`로 server entry를 평가했다.
- 이 결과는 합성 SDK/daemon 검사다. 별도 Antigravity CLI HOME에서 실제 continuation을 재개하거나,
  데몬 재시작 뒤 native conversation 재개와 timeline 복원을 수행한 실계정 검증은 하지 않았다.
  외부에서 관측되지 않은 Google 계정 변경도 감지한다고 보장하지 않는다. 실제 Paseo 설치·reload도
  실행하지 않았다.
