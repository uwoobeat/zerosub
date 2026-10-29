# Antigravity 지원 가능성 및 구현 계획

최초 검토일: 2026-10-24, ZeroSub 1.3.0 기준. 현재 상태 갱신일: 2026-10-29,
ZeroSub 1.4.0 및 upstream 병합 커밋 `860f678` 기준이다.
설계 검토와 OS별 실증 결과를 바탕으로 현재 checkout에 1차 제품 코드를 구현·통합했다.
2026-10-26에는 제공자 확인 경로를 수정하고 현재 Linux Paseo 데몬에서 플러그인을 재로드해
상태 RPC의 Antigravity 노출을 확인했다. 아래 조사 결과와 제품 통합 검증은 구분한다.

## 현재 구현 범위

- native `AntigravityAdapter` 등록, 계정별 HOME·XDG 환경, 기존 CLI 로그인과 그룹별 quota 화면을 연결했다.
- 상태·RPC·설정·UI에 `antigravity`와 제공자별 capability를 추가했다. 이전 Claude/Codex 데이터는 기본값으로 호환한다.
- quota는 `status: SUCCESS`, `num_turns: 0`, `command.name: usage`를 검증하며, 조회 간격·timeout·출력 제한과 실패 시 캐시 보존을 적용한다.
- 그룹 한도는 `scopedLimits`로 기록한다. 정확한 모델 대응이 없으면 그룹 수치를 에이전트 사용량이나 자동 선택으로 추정하지 않는다.
- 수동 계정 선택은 새 세션에 환경을 적용하며, 이력이 있는 대화는 원본을 보존하는 continuation을 사용한다. 실행 중인 턴을 중단하지 않는다.
- Antigravity 자동 전환·잔량 기반 분산·banked reset·제공자 간 fork는 비활성이다. 일반 자동 전환 설정으로 활성화하지 않는다.

Linux의 공식 CLI 코드 로그인은 OS `script(1)`의 private PTY를 기존 `LoginHandle`에 연결한다.
제품 로그인에서는 UI의 일시적 URL·코드 RPC를 사용하므로, 사용자가 CLI에 직접 입력하는
아래 진단 도구와 별도 경로다. TERM_PROGRAM 값이 없을 때에는 native DA2 질의만 표준 응답으로
협상하며, 다른 터미널의 이름을 기본값으로 위조하지 않는다. 코드·인증 응답을 기록하지 않고
종료 코드·private 인증 파일·새 quota 조회로 완료를 검사한다. 합성 CLI 검증과 실제 제품
로그인 검증은 구분한다.

macOS는 기존 파일 인증 재사용을 실증했으나, 새 제품 HOME의 첫 로그인에서 global Keychain을
읽거나 쓰지 않는다는 점이 미입증이다. 따라서 현재 Mac 제품의 관리 계정 추가·재로그인은
비활성이다. 기존 CLI 로그인의 quota 표시는 가능하다. 아래 OS별 진단 프로필의 인증은 제품
관리 홈으로 가져오거나 복사하지 않는다.

제품 코드 검증 결과(2026-10-29 upstream 병합 시 실행):

- `npm run typecheck`: 클라이언트·서버 통과.
- `npm test -- --silent`: 30개 파일·409개 테스트 통과. Linux의 실제 OS PTY에서 합성 CLI의 코드 입력·DA2 협상·취소·timeout·출력 상한을 검사했다. 내부 PID 파일 생성 전 즉시 취소도 PTY helper의 process group을 종료하며, 기존 CLI 로그인의 디렉터리 symlink 허용과 token symlink 거부를 함께 확인했다. 관리 계정은 디렉터리 symlink도 계속 거부한다.
- `npm run audit:mobile`, `git diff --check`: 통과. 모바일 검사는 정규식 검사이며 실기기 검증은 아니다.
- `npm pack --dry-run --json --ignore-scripts`: entrypoint와 로컬 모듈 포함, 테스트·`.env` 제외 확인.
- tarball을 개발 의존성 없이 임시 npm 경로에 설치한 뒤, Paseo 0.13.2의 실제 `compilePlugin()`으로 양쪽 bundle을 컴파일하고 `evaluateBundle()`로 서버 entry를 평가했다. 앞선 구현 단계에서는 0.12.0·0.13.0도 확인했다. 별도 설치본의 contribution은 시작하지 않았다.
- 2026-10-26 표시 누락 수정: `listAvailable()`은 모든 제공자의 재검사 때문에 2.5초가 지나도 응답하지 않아 resolver의 1.5초 제한에 걸렸다. `providers.snapshot()`은 같은 호스트에서 Antigravity enabled·ready를 11ms 만에 반환했다. 확인 경로를 카탈로그로 바꾸고 기존 IPC 시간 제한·별도 인증 제외를 유지했다. 수정 resolver는 실제 호스트에서 22ms 만에 Antigravity를 인식했고, 플러그인 재로드 후 `zerosub.state`에 제공자·CLI 계정·Linux 계정 추가 capability가 포함됐다. 비활성·로딩·오류·불완전 카탈로그 항목은 제외하는 회귀 검사를 추가했다.

2026-10-29 Linux Paseo에서 서로 다른 실계정으로 사용자가 확인한 `agy1`·`agy2`의 실제
ZeroSub 라우팅을 검증했다. `agy1` 세션에서 `/account agy2` 전환 후 managed continuation이
생성됐고, 각 에이전트의 binding·session 계정 ID가 main·managed 계정과 각각 일치했다.
두 계정의 별도 quota 조회도 성공했다. CLI 파일에는 이메일·identity claim이 없어 계정 ID와
Google 신원 자체의 일치를 독립적으로 확인할 수 없다. 동시 실행, 재시작, CLI가 수행하는
만료 후 갱신, 재로그인·로그아웃·관리 계정 삭제의 격리는 아직 검증하지 않았다. 이 조건을
대신하기 위해 자동 전환을 켜거나 진단 프로필의 인증을 재사용하지 않는다.

## 남은 작업과 완료 조건

2026-10-29 기준이다. 그룹별 quota 표시, Linux 코드 로그인 구현, 수동 계정 선택과 새
continuation 생성은 구현했다. 아래는 구현 완료와 실계정 검증을 구분한 후속 작업이다.

| 작업 | 현재 상태 | 완료 조건 |
| --- | --- | --- |
| Linux 제품 흐름의 서로 다른 계정 검증 | 2026-10-29 실제 main(agy1)→managed(agy2) continuation 라우팅을 검증했다. 각 binding·session 계정 ID가 일치했고 두 계정의 quota 조회도 성공했다. CLI 이메일·identity claim은 unknown이다. 동시 실행, 재시작, CLI 만료 후 갱신, 재로그인·로그아웃·관리 계정 삭제 격리와 기존 CLI 로그인 보존은 미검증이다. | 서로 다른 실계정의 계정 식별과 실제 실행·quota 귀속이 일치하는지 확인한다. 동시 실행, 재시작, CLI가 수행하는 만료 후 갱신, 재로그인·로그아웃·관리 계정 삭제의 격리를 확인하며 기존 CLI 로그인을 보존한다. |
| 작업별 계정 탭 재사용·증분 인계 | Antigravity 전용 수동 작업 탭 재사용·증분 인계를 구현했다. 합성 SDK·회귀·배포 검증 결과와 native 재개 등 남은 제약은 [탭 재사용·증분 인계 계획](antigravity-tab-reuse-plan.md)의 구현 결과에 기록했다. | 같은 작업에서 A→B→A→B 전환 시 계정별 탭을 재사용하고, 각 탭이 아직 받지 않은 진행 내용만 전달한다. 기존 탭 재개, 작업 간 분리, 계정·모델·권한 일치, 전송 중단·재시작 복구를 상세 계획의 완료 조건으로 검증한다. |
| 그룹 단위 자동 전환 | `capabilities.autoSwitch`는 `false`다. `detectLimit()`·`detectSignOut()`은 `null`을 반환하며, 검증된 모델→quota 그룹 대응표 `VERIFIED_MODELS`는 비어 있다. 후속 범위·구현 순서·활성화 조건은 [그룹 단위 자동 전환 계획](antigravity-auto-switch-plan.md)을 따른다. | 선택한 모델에 적용되는 공유 그룹과 공식 한도 신호를 입증한 뒤, 신선한 해당 그룹 잔량이 있는 계정의 현재 작업 탭으로 이어간다. 다른 그룹 오차단·429 오탐·중복 전송·busy 경쟁·재시작과 작업 전체 전환 횟수 제한을 검증한다. 공식 로그아웃 감지는 별도로 입증한 범위에서만 활성화한다. |
| macOS 신규 관리 계정·재로그인 | 기존 파일 인증 재사용만 실증했다. 제품의 계정 추가·재로그인은 비활성이다. | 진단 프로필 인증을 복사하지 않고 빈 제품 HOME에서 첫 공식 로그인을 수행한다. 기존 사용자 Keychain의 인증을 읽거나 쓰지 않고 default·search list를 보존함을 입증한 뒤 제품 로그인·재로그인 경로를 연결하고 검증한다. |
| composer 문구와 실제 UI 검증 | Accounts의 `Model mapping not reported` 표시는 제거했다. composer에는 `usage not reported for this model`·`usage unknown (model not reported)` 문구가 남아 있다. | 개별 모델 잔량이 누락된 것처럼 보이지 않도록 그룹 기준 문구로 바꾼다. 선택 모델의 그룹을 모르면 잔량을 추정하지 않는다. 좁은 화면·밝은/어두운 테마·캐시/오류 상태·수동 continuation을 실제 Paseo UI에서 확인한다. |
| upstream 병합 후 운영 확인 | 병합 소스의 타입·409개 테스트·패키지 컴파일은 통과했다. 병합 커밋 `860f678` 이후 운영 플러그인 재로드는 수행하지 않았다. | 허가된 호스트에서 재로드 후 제공자 노출, Accounts, 계정 선택과 continuation을 확인한다. 재로드만으로 macOS 로그인이나 자동 전환 capability가 활성화되지는 않는다. |

Antigravity의 잔량은 **그룹별 공유 bucket**이다. 자동 전환에 필요한 모델→그룹 대응은
실행 중인 모델이 어느 공유 한도를 사용하는지 판별하기 위한 것이며, 개별 모델의 독립 잔량을
요구하는 것이 아니다. Accounts에서 그룹별 사용량을 보여주는 데 이 대응표는 필요하지 않다.

우선순위는 다음과 같다. macOS의 첫 로그인 격리 검증은 별도로 진행할 수 있다.

1. Linux에서 서로 다른 실계정의 제품 로그인·라우팅·인증 격리를 검증한다.
2. Antigravity의 기존 작업 탭 재개를 검증하고, 계정별 탭 재사용·증분 인계를 구현한다.
3. 그룹 단위 자동 전환을 탭 재사용 경로와 연결하고 검증 후 활성화한다.

탭 재사용·증분 인계는 자동 전환과 함께 우선 구현할 범위다. 현재의 수동 다계정 지원을
성립시키는 필수 조건은 아니지만, 반복 전환에서 탭 증가와 반복 인계를 줄이기 위해
자동 전환 활성화 전에 구현·검증한다. 제공자 간 인계는 이후 확장 항목이며, banked reset은
지원 근거가 확보되기 전에는 구현·활성화하지 않는다. 실제 로그인·로그아웃·삭제·운영 재로드는
허가된 범위에서 수행하며, 이 문서 갱신에서는 실행하지 않았다.

### 탭 재사용·증분 인계

Antigravity의 수동 계정 전환에서 같은 작업의 계정별 탭을 재사용하고, 각 탭이 아직 받지 않은
지시와 진행 내용만 전달하도록 구현했다. 구현 순서·완료 조건·검증 결과와 남은 제약은
[작업별 탭 재사용·증분 인계 계획](antigravity-tab-reuse-plan.md)에서 관리한다.

검증 근거와 제약은 [Linux 인증 격리 보고서](antigravity-linux-isolation.md),
[macOS 인증 격리 보고서](antigravity-macos-isolation.md)에 기록했다. 관련 코드와 회귀 검사는
[어댑터](../server/antigravity.ts), [Service 검사](../server/service-antigravity.test.ts),
[검증 절차](agents/verification.md)를 참고한다.

### 그룹 단위 자동 전환

공식 구독 한도로 멈춘 현재 작업을, 같은 모델의 공유 그룹 한도가 남아 있는 다른 AGY 계정의
작업 탭으로 자동 인계한다. 공식 실패 신호·모델 대응·후보 신선도·턴 귀속·동시성·기본값과
활성화 조건은 [그룹 단위 자동 전환 계획](antigravity-auto-switch-plan.md)에서 관리한다.
새 에이전트 분산·reset·제공자 간 fork는 해당 계획의 구현 범위에 포함하지 않는다.

## 초기 검토 당시의 판단

**기존 CLI 로그인에 대한 quota 조회·표시는 구현 가능하다. 여러 계정의 동시 사용과 자동
전환은 인증 저장소 격리를 확인한 뒤 구현해야 한다.** Paseo의 제공자 실행 기능은 이미
있으므로 ZeroSub에 새 Paseo provider나 인증 프록시를 만들 필요는 없다.

| 영역 | 검토 결과 |
| --- | --- |
| Paseo 연동 | 현재 연결된 호스트의 `antigravity`가 enabled/available. 실행 파일명은 `agy`이며, `agy`라는 provider ID는 구성되어 있지 않다. |
| CLI | 설치된 `agy --version`은 `1.4.6`. 로컬에 설치된 Paseo CLI 및 server 패키지는 `0.12.0`. |
| 구독 quota | 공식 CLI의 독립적인 JSON 조회 명령을 실제로 실행해 확인했다. |
| 그룹별 공유 한도 | 여러 모델이 공유하는 그룹과 Argon처럼 별도로 반환되는 그룹이 있다. 개별 모델 잔량으로 나누거나 계정 전체 단위 정책을 그대로 적용하면 오판할 수 있다. |
| 다계정 인증 격리 | Linux와 macOS에서 같은 실제 계정을 A/B 별도 HOME에 각각 로그인해 동시 quota·stream-json init을 실증했다. Linux는 빈 D-Bus 주소, macOS는 잠긴 private Keychain·SSH 환경값 제거 상태에서도 CLI 파일 인증을 재사용했다. 서로 다른 계정·만료 후 갱신은 미검증이다. |
| 계정 간 기존 대화 이동 | 미검증. 초기 정책은 `portable: false`와 새 continuation agent를 권장한다. |
| 다른 제공자에서 인계 | 대상 Antigravity가 full-access만 제공하므로 원본의 권한 수준에 따라 불가능할 수 있다. |
| 리셋·추가 크레딧 | banked reset 지원 근거를 확인하지 못했다. 초기 구현은 `resets: null`, reset 실행 미지원으로 둔다. |

## quota 조회: 실제 확인 결과

다음 명령을 기존 로그인으로 실행했다. 로그인·로그아웃이나 모델 프롬프트는 실행하지 않았다.

```sh
agy --print /usage
agy --print /usage --output-format json
agy models
```

첫 번째 명령은 exit 0, 약 6.31초에 TSV 5개 행을 반환했다. 각 행은 모델 그룹, 한도명,
잔여 퍼센트, ISO 리셋 시각이다. JSON 명령도 exit 0으로 성공했으며 두 차례 조회는 각각
약 5.73초, 5.54초였다. stderr는 모두 비어 있었다.

JSON에는 일반 실행 결과와 CLI 명령 결과가 함께 있다. 다음은 확인된 구조를 줄인 예다.
`conversation_id` 등 불필요한 값은 생략했다.

```json
{
  "status": "SUCCESS",
  "num_turns": 0,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "thinking_tokens": 0,
    "cache_read_tokens": 0,
    "total_tokens": 0
  },
  "command": {
    "name": "usage",
    "data": {
      "groups": [
        {
          "name": "Gemini 4 Argon",
          "buckets": [
            {
              "id": "gemini-argon-wtu-weekly",
              "name": "Gemini 4 Argon Weekly Limit",
              "window": "weekly",
              "remaining_fraction": 0.5132234692573547,
              "reset_time": "2026-10-24T00:42:59Z"
            }
          ]
        }
      ]
    }
  },
  "response": "<TSV text>"
}
```

**quota 원본은 `command.data.groups[].buckets[]`다.** 최상위 `usage`는 토큰 수이며,
구독 quota 잔량이 아니다. 이 호출에서는 `num_turns: 0`이고 모든 토큰 수가 0이어서
모델 생성 없이 조회할 수 있음을 확인했다.

확인한 전체 bucket은 다음과 같다. 표시명이나 제공 모델은 향후 바뀔 수 있다.

| 그룹 | bucket ID | window | 확인 당시 잔량 |
| --- | --- | --- | --- |
| Gemini Models | `gemini-weekly` | `weekly` | 100% |
| Gemini Models | `gemini-5h` | `5h` | 100% |
| Claude and GPT models | `3p-weekly` | `weekly` | 100% |
| Claude and GPT models | `3p-5h` | `5h` | 100% |
| Gemini 4 Argon | `gemini-argon-wtu-weekly` | `weekly` | 약51.32% |

공식 문서는 `/usage`가 backend에서 quota를 갱신한다고 설명한다.
또한 `/usage` 같은 CLI 자체 명령은 실행 중인 stream-json 입력 세션에 보낼 수 없으며,
별도 `--print` 호출을 사용해야 한다. Paseo의 Antigravity driver도
`--disable-slash-commands`를 사용한다. 따라서 에이전트에 `/usage`를 메시지로 보내지 않고
서버에서 별도 프로세스로 조회한다.
([quota 문서](https://antigravity.google/docs/cli/commands/usage/),
[headless 문서](https://antigravity.google/docs/cli/headless/))

공식 changelog의 1.1.11 항목은 `/usage`의 비생성 print-mode 응답과 JSON 출력을 명시한다.
다만 `command.data.groups[].buckets[]`의 상세 구조는 설치된 1.4.6에서 실측한 결과이며,
모든 중간 버전에서 같은 구조라고 보장하지 않는다.
([공식 changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md))

### 공식 ACP에서 구독 quota를 받을 수 있는가

**확인한 공개 구현 기준으로 공식 `agy_acp_server`는 ACP를 통해 잔여 구독 quota를
제공하지 않는다. 다만 ACP 계정의 quota를 별도 API로 조회한 구현은 존재한다.**
ACP 연결만으로 해결되는지와 ACP 밖에서 조회할 수 있는지를 구분해야 한다.

- Google CLI 이슈 [#1045](https://github.com/google-antigravity/antigravity-cli/issues/1045)는
  공식 ACP 1.1.1에서 quota가 전달되지 않는다고 보고했다. 제안된 `_antigravity/usage`는
  구현된 메서드가 아니다. 해당 이슈는 open이지만 그것만으로 최신 버전의 미지원을 단정하지 않는다.
- 더 최근의 [Google ACP for Copilot 변경 이력](https://github.com/NeoMetric/google-acp-for-copilot/blob/9f9daac539e102ac497944609d9e022893bbedb6/CHANGELOG.md)은
  공식 ACP **1.4.1**을 사용하며 잔여 quota 미제공 때문에 meter가 없다고 명시한다.
  2026-10-23 갱신된 클라이언트 소스의 `quota.ts`는 한도 도달 오류를 처리하며 사전 잔량을
  조회하지 않는다. 이는 해당 클라이언트의 보고와 소스 검토 결과이며, 이번에 공식 ACP
  1.4.1을 직접 실행해 전체 RPC를 검증한 것은 아니다.
- ACP 표준 [`usage_update`](https://agentclientprotocol.com/rfds/session-usage)는 컨텍스트
  크기와 누적 비용이다. 위 클라이언트가 읽는
  [`_meta.quota.token_count`](https://github.com/NeoMetric/google-acp-for-copilot/blob/9f9daac539e102ac497944609d9e022893bbedb6/src/agent.ts)은
  턴별 토큰 수다. `quota`라는 필드명이 있어도 모델 그룹별 5시간·주간 구독 잔량과 다르다.
- HarnessDesk의 병행 CLI 조회는 실제로 [병합됐다](https://github.com/HarnessDesk/HarnessDesk/pull/769).
  그러나 [조회 소스](https://github.com/HarnessDesk/HarnessDesk/blob/0502b80dcdac63711b7fcbf82c457a5cd66f8b65/packages/server/src/usage/agy.ts)는
  ACP와 CLI가 별도로 로그인하므로 실행 계정과 quota 계정의 일치를 검증할 수 없다고 명시한다.
  이 값을 ACP 계정의 자동 전환 근거로 쓰면 안 된다.
- T3 Code는 [PR #17530](https://github.com/pingdotgg/t3code/pull/17530)을
  2026-10-11 병합했다. [병합된 조회 구현](https://github.com/pingdotgg/t3code/blob/716357cbbaca914ee1cbaef7b9fe3ea79319d1b6/apps/server/src/provider/antigravityUsageLimits.ts)은
  ACP profile의 `antigravity-acp/acp_token.json`을 읽어 access token을 자체 갱신한 뒤
  `retrieveUserQuotaSummary`, 필요 시 `fetchAvailableModels`를 호출한다. 2026-10-24 확인한
  main에도 이 경로가 있다. 이는 ACP 메시지로 quota를 받는 구현이 아니며, 자체 refresh는
  ZeroSub의 현재 인증 원칙과 맞지 않아 그대로 채택할 수 없다.

따라서 범위를 좁히는 근거는 “ACP 자체가 다계정에 부적합하다”가 아니라 **“현재 확인된
공식 ACP 경로만으로 구독 quota 조회를 완결할 수 없다”**이다. 실행과 조회의 계정 일치 및
공식 runtime 소유의 인증 갱신을 유지하려면, 우선 실측한 native CLI의 `/usage` 경로가 구체적인
구현 후보이다. ACP 지원은 별도 플러그인으로 분리해야 하는 요구사항이 아니다. 같은 플러그인에
추가할 수도 있지만, quota를 지원한다고 표시하기 전에 자체 refresh 없이 같은 ACP 계정의
quota를 얻는 경로를 입증해야 한다.

### 권장 조회·파싱 설계

- `server/antigravity.ts`에서 `providerCommand("antigravity")`와 기존 `run()`을 사용해
  `--print /usage --output-format json`을 호출한다. 기본 실행 파일은 `agy`로 매핑하고
  Paseo의 command/prefix와 별도 환경 설정을 보존한다.
- exit code뿐 아니라 `status === "SUCCESS"`, `command.name === "usage"`와 응답 구조를
  Zod로 검증하고 `num_turns === 0`도 확인한다. `remaining_fraction`은 유한한 0~1 값만 사용한다.
- 실행 전에 wrapper prefix에 `--disable-slash-commands`나 streaming 입력 같은 충돌 옵션이
  없는지 검사한다. 결과의 `num_turns` 검사는 이미 실행된 모델 생성을 되돌리지 못하므로,
  일반 세션 인자를 quota 명령에 재사용하지 않는다.
- `usedPercent = (1 - remaining_fraction) * 100`으로 변환하고 반올림은 표시 시에만 한다.
  TSV의 정수 퍼센트나 `response`를 우선 파싱하지 않는다.
- `bucket.id`를 window 식별자로 보존하고 그룹·window·reset 시각도 유지한다.
  timestamp가 없거나 잘못됐으면 `null`로 표시한다. 과거 reset 시각도 실제 출력에 있었으므로
  이를 임의의 미래 차단 시각으로 바꾸지 않는다.
- JSON 미지원·응답 변경 시 마지막 정상값과 오류를 함께 표시한다. unknown을 0% 사용이나
  signed-out으로 해석하지 않는다. TSV fallback은 별도 버전 검증 후 표시 용도로만 검토한다.
- session-open hook에서 quota 프로세스를 실행하지 않는다. 계정별 in-flight 중복 방지와
  기존 캐시 병합 경로를 재사용한다. 초기 `usageSpacingMs`는 90~120초 수준으로 잡고 실측한다.
  이는 제공자의 공식 요청 제한 수치가 아니라 프로세스 비용을 줄이기 위한 초기 정책이다.
- timeout·프로세스 출력 상한을 적용하고 무인증 환경에서는 빠르게 실패하게 한다. backend
  오류나 조회 429를 구독 소진으로 취급하지 않는다. CLI가 Retry-After를 노출하지 않으면
  헤더를 읽었다고 가정하지 않고 제한된 backoff를 적용한다.

### 그룹별 공유 한도에 대한 초기 변경 계획

아래는 최초 검토 당시의 변경 제안이다. 현재 구현은 그룹별 제한을 별도로 저장하며,
남은 자동 전환 조건은 위의 현재 상태 표를 따른다.

현재 [routing.ts](../server/routing.ts)는 모든 window의 최댓값으로 잔량을 비교하고,
[service.ts](../server/service.ts)의 `refreshUsage()`는 window 하나만 100%여도 계정 전체에
`limitedUntil`을 기록한다. Antigravity에서는 Gemini의 한도가 소진되어도 Claude/GPT 쪽은
사용 가능할 수 있으므로 자동 전환 도입 전에 이 정책을 분리해야 한다.

1. 사용량 window에 적용 범위 정보를 호환 가능한 optional 필드로 추가하고, 대상 모델에
   적용되는 window를 고르는 순수 함수를 둔다. UI에는 모든 그룹을 표시한다.
2. `mostAvailable()`·계정 사용 가능 여부·limit 기록 및 해제에 대상 모델/그룹 문맥을 전달한다.
   계정 전체 한도와 그룹 한도는 구분해 저장한다. 기존 Claude/Codex 데이터의 의미는 유지한다.
3. `agent.session_open` 요청에는 model 필드가 없으므로 요청에서 바로 읽는다고 설계하지 않는다.
   Paseo의 에이전트 설정 또는 사전에 확보한 모델 정보를 사용하고 15초 hook 제한을 보존한다.
   모델 변경 후에는 적용 범위를 다시 계산한다.
4. `agy models`의 ID·라벨과 검증한 bucket 대응표를 사용한다. 그룹 설명 자연어만으로 자동
   분류하지 않는다. Argon 분리 여부는 플랜에 따라 달라질 수 있다는 설명도 실제 응답에 있었다.
   알 수 없는 모델·bucket 조합은 표시하되 자동 차단·잔량 기반 분산의 근거로 삼지 않는다.
5. quota의 `remaining_fraction === 0`과 실행 실패를 구분한다. 일반 429·용량 부족·stream
   interruption은 계정 소진의 증거가 아니다. 자동 failover는 공식 한도 오류와 적용 범위를
   확인한 뒤 수행한다.

## 그룹별 공유 한도 화면안

[인터랙티브 화면안](design/antigravity-quota-preview.html)은 Accounts 카드와 에이전트 composer
pill의 초기 제안이다. 예시 수치이며 실시간 조회나 계정 변경을 실행하지 않는다.
모델 선택·그룹 강조는 설계 예시이며, 현재 Accounts는 모델 대응표 없이 그룹 수치를 표시한다.

계정 → quota 그룹 → 기간별 bucket의 계층을 유지한다. Gemini Flash/Pro와 Claude/GPT의
공통 한도를 개별 모델마다 복제하지 않고 한 번씩 표시한다. Argon 전용 그룹은 서버가 해당
계정에 반환한 경우에만 추가한다. quota 종류나 그룹 수를 네 개의 고정 bucket으로 제한하지 않는다.

- 카드 상단에는 현재 모델 문맥의 사용 가능 여부와 그 모델에 적용되는 가장 제한적인
  window를 요약한다. Accounts에서 비교할 모델 그룹을 바꿔도 나머지 그룹은 계속 보인다.
  에이전트 pill은 실제 선택된 모델 문맥을 사용한다.
- 기존 ZeroSub과 일치하도록 숫자와 막대는 모두 **사용률**을 나타낸다. 잔여 비율과 사용률을
  한 화면에서 같은 의미처럼 섞거나 여러 bucket의 퍼센트를 더하지 않는다.
- 그룹 제목 아래에 공유하는 모델 범위를 표시하고, 그 아래에 5시간·주간 한도를 각각
  퍼센트, 막대, 해당 bucket의 리셋 시각으로 표시한다.
- 데스크톱에서는 5시간/주간을 나란히, 좁은 화면에서는 세로로 배치한다. 숫자·상태·버튼은
  hover 없이 읽고 조작할 수 있게 한다. 실제 구현은 기존 React Native/theme 컴포넌트를 사용한다.
- 일부 그룹만 소진되면 해당 행에 소진 상태를 표시한다. 계정 전체를 빨갛게 하거나 다른
  그룹의 에이전트까지 `limited`로 표시하지 않는다. 색상 외에 문구도 함께 사용한다.
- 조회 실패 시 마지막 정상 수치와 확인 시각을 유지하고 `cached`를 표시한다. 캐시의 사용
  가능 여부를 현재 검증 결과처럼 표현하지 않는다. 읽은 적이 없는 bucket은 `— / 확인 불가`로 둔다.
- 리셋 시각이 지났다는 이유만으로 잔량이 회복됐다고 표시하지 않는다. 갱신 전에는
  리셋 시각 경과와 재확인 필요를 표시한다. 상세 시각은 호스트/기기 시간대와 함께 제공한다.
- 기본 CLI 로그인만 지원하는 단계에서는 `Add account`, reset 사용, 자동 전환을 노출하지 않는다.
  인증 방식/OS별 capability가 확보된 뒤 가능한 작업만 연다.

화면안은 정상 수치, Argon만 소진, 조회 실패 후 캐시, 전체 미확인 상태를 바꿔볼 수 있다.
모델 문맥을 바꾸면 카드 요약과 pill이 함께 바뀐다. 실제 데이터 계약에는 group/bucket 식별자,
기간, 모델 적용 범위, 확인 시각과 오류/캐시 상태를 보존해야 한다.

## 다계정 지원의 선행 조건

공식 인증 문서는 CLI가 OS keyring의 token profile을 사용하고 App·IDE·CLI가 로컬 인증을
공유한다고 설명한다. 원격 SSH에서는 URL을 열고 코드를 붙여넣는 공식 흐름도 있다.
설치된 `--help`에는 `auth login`·`auth status`나 주 로그인 프로필 선택 옵션이 없었다.
따라서 Claude의 `CLAUDE_CONFIG_DIR`나 Codex의 `CODEX_HOME`을 그대로 대입할 수 없다.
([인증 문서](https://antigravity.google/docs/install?tab=cli))

후속 실험에서 [Linux native 인증 조회 분리](antigravity-linux-isolation.md)를 실증했다.
같은 service/username에 다른 합성 표식을 저장한 private D-Bus 두 개를 동시에 실행해 native
`agy`의 각 Keyring 조회를 관측했다. HOME만 바꾸고 bus를 유지한 대조 실험은 같은 저장소를
읽었다. 이후 같은 실제 계정을 A/B에 각각 로그인한 결과 CLI 자체 파일 저장을 확인했고,
빈 D-Bus 주소에서도 동시 stream-json 초기화와 quota 조회가 성공했다. 두 인증 파일은 별도
경로·inode·0600이며 내용은 읽거나 복사하지 않았다. 만료 후 갱신은 아직 확인하지 못했다.
[macair 실험](antigravity-macos-isolation.md)에서도 같은 실제 계정을 A/B에 각각 공식
로그인한 뒤, CLI가 각 HOME의 파일에 인증을 저장한 것을 확인했다. 두 파일은 서로 다른
inode·0600이며 내용을 읽거나 복사하지 않았다. private Keychain을 해제하지 않고 SSH
환경값도 제거한 비TTY 실행에서 두 프로필의 동시 quota·stream-json init이 성공했다.
native Keychain 사용을 입증한 결과는 아니며, 서로 다른 계정의 라우팅과 CLI 자체 갱신은
두 플랫폼 모두 후속 확인이 필요하다.

구현 전 별도 개발 호스트와 테스트 계정에서 다음을 확인해야 한다.

- 공식 CLI가 제공하는 프로세스별 계정 선택 또는 인증 저장소 namespace를 확인한다.
  설정 경로와 keyring 항목이 모두 분리되어야 한다. `HOME`·XDG 경로만 바꿔서 성공했다고
  단정하지 않는다. 바이너리에 보이는 미문서화 환경 변수도 지원 계약으로 취급하지 않는다.
- 서로 다른 두 계정을 동시에 실행해 실제 실행 계정과 quota 조회 계정이 각각 일치하는지,
  한 계정의 로그인 갱신이 다른 세션과 기존 CLI/App/IDE 로그인에 영향을 주지 않는지 검증한다.
- identity의 안정적인 키와 중복 계정 식별 경로를 확보한다. quota JSON만으로는 이메일이나
  계정 ID가 확인되지 않았으므로, 성공한 quota 조회를 고유 identity로 대체하지 않는다.
- 공식 CLI 로그인 과정을 기존 `LoginHandle`의 browser/code/cancel 흐름에 연결할 수 있는지
  확인한다. TUI/PTY가 필요하면 별도 설계하며, 자체 OAuth나 토큰 갱신을 구현하지 않는다.
- 관리 계정의 logout이 해당 namespace만 대상으로 하는지 확인한다. 안전성이 확인되기 전에는
  기본 keyring의 `/logout`을 관리 홈 정리·계정 삭제 경로에서 호출하지 않는다.
- 인증 파일·keyring 항목을 다른 계정으로 복사하거나 전역 active profile을 바꿔가며 실행하는
  방식은 채택하지 않는다. 프로세스별 patch를 사용하고 전역 `process.env`를 변경하지 않는다.

이 조건을 만족하는 공식 경로가 없으면 전체 다계정 지원은 보류하고, 기존 CLI 로그인 quota
표시까지를 제공 범위로 둔다. 토큰 교체로 다계정을 흉내 내지 않는다.

### 공개 구현 조사 결과

아래는 2026-10-24에 원본 저장소/배포 소스를 읽은 결과다. 설치하거나 로그인·실계정 전환을
실행하지 않았다. 저장소의 동작 설명과 소스에서 확인한 기법이며 ZeroSub의 실증 결과는 아니다.

| 공개 구현 | 인증·quota 방식 | ZeroSub에서 참고할 점 |
| --- | --- | --- |
| [lefos13/paseo-plugin-antigravity-cli](https://github.com/lefos13/paseo-plugin-antigravity-cli/tree/1d43a3855cf62e1bdb1ea334e7fc36941a357e35) | native `agy`, 계정별 shadow home, macOS 별도 Keychain, 같은 home에서 `/usage` JSON 조회. 대화를 생성 계정에 고정한다. | 가장 직접적인 native CLI 선례. Windows는 기본 계정만 지원. Linux에서 home 분리만으로 공유 Secret Service가 격리됐다고 볼 수는 없다. |
| [breathi3552/paseo-agy-usage](https://github.com/breathi3552/paseo-agy-usage/tree/6529817d69373d57a570dcde648f3542377f9da8) | OS keyring을 읽어 `retrieveUserQuotaSummary`와 `loadCodeAssist` 호출. 로그인 갱신은 CLI에 맡긴다. | `discover()`는 global만 허용한다. 세션 환경만으로 계정 소유권을 알 수 없다는 판단을 참고한다. quota mapper는 네 bucket만 열거하므로 Argon 같은 추가 그룹을 동적으로 처리해야 한다. |
| [yannelli/paseo-usage-plugin](https://github.com/yannelli/paseo-usage-plugin/tree/0b6cdfb7fc038a33646a50700a0784e6accf741c) | CLI OAuth 파일을 읽어 quota summary API 조회, 필요 시 `fetchAvailableModels` fallback. 자체 refresh 없음. | 동적 그룹/기간과 legacy 모델 quota 구분이 유용하다. `AGY_USAGE_TOKEN_FILE`은 이 플러그인의 조회 경로이며 CLI 계정 selector가 아니다. 같은 잔량/시각만으로 공유 pool을 추측하지 않는다. |
| [3ae3ae/paseo-plugin-agy-provider](https://github.com/3ae3ae/paseo-plugin-agy-provider/tree/5d50b2350911afb4baae855d05eb5bf1c9ca9f7e) | native CLI 대신 공식 `agy_acp_server`를 실행한다. 로그인 helper는 ACP `authenticate`를 호출하고 서버가 인증을 소유한다. | ACP 로그인과 CLI 로그인이 별개다. `GEMINI_HOME`을 사용하는 경우 로그인과 실행의 값을 맞춘다. 자체 OAuth가 필요 없는 로그인 연결 선례다. |
| [tiezbro/paseo-agy-acp](https://github.com/tiezbro/paseo-agy-acp/tree/51bf83964399d924e4b9737a7afd3388e920bff0) | 공식 ACP kernel과 native CLI를 별도 provider/로그인으로 병행한다. 계정 내 동시 실행은 Admission queue로 조정한다. | CLI+ACP 두 로그인 병행 사례이며 임의 개수의 native 계정 selector를 증명하지 않는다. `AGY_ACP_STATE_DIR`은 queue/state 경로이지 인증 root가 아니다. |
| [openclaw/acpx](https://github.com/openclaw/acpx/blob/59ba80066f8932c8237aef0c46e13bbc4ae98fd2/agents/Antigravity.md) | 공식 ACP runtime의 계정 root는 `GEMINI_HOME`. `AGY_ACP_FORCE_FILE_STORAGE=1`로 profile-local 저장을 안내한다. | ACP별 독립 로그인 후보가 구체적이다. 해당 옵션이 native `agy`에도 적용된다는 근거는 아니다. |
| [ashaskhan/multiagy](https://github.com/ashaskhan/multiagy/tree/eec4e4a4c84e95cfbedd32c0740cdb7dff31d8ef) | Linux IDE를 profile별 private D-Bus와 `gnome-keyring-daemon` 안에서 실행한다. 브라우저 로그인은 host D-Bus로 연결한다. | Linux CLI에도 검증할 가치가 있는 OS credential 경계다. IDE 구현이므로 현재 CLI에서의 재현을 별도로 해야 한다. |
| [AI Switcher](https://aiswitcher.dev/guides/antigravity/switch-accounts/), [agy-tools](https://github.com/tnduyh5/agy-tools) | 저장한 자격 증명을 전역 keyring/설정에 다시 적용한다. | 전역 전환 방식은 계정별 동시 실행과 다르며 ZeroSub의 인증 복사 금지 규칙에 맞지 않아 채택하지 않는다. |

직접 API의 `bucketId`·`remainingFraction`·`resetTime`과 CLI JSON의
`id`·`remaining_fraction`·`reset_time`은 서로 다른 입력 계약이다. API의 protobuf scalar 생략
규칙을 CLI JSON에도 자동 적용해 누락 수치를 0으로 바꾸지 않는다. 입력별 검증 후 같은 내부
quota 모델로 정규화한다.

[nerveband/paseo-provider-usage](https://github.com/nerveband/paseo-provider-usage/tree/44a76c5c183702ad6e1287fd1a8fb3e0e3499fae)는
OMP의 access token을 CodexBar용 별도 설정에 전달하는 bridge와 여러 fallback을 사용한다.
usage UI 사례로는 유용하지만, 그 login이 ZeroSub 에이전트의 실제 실행 계정이라는 보장은 없다.
해당 token bridge를 ZeroSub의 계정 격리 방법으로 가져오지 않는다.

`@xpufx/paseo-antigravity-claude` 0.1.0 배포 소스도 확인했다.
`AGY_TARGET_POOL=claude`를 child 환경에 넣고 partner 모델만 노출하지만, README는 이 값을
해석하는 별도 `agent-mux` wrapper가 있어야 계정 라우팅이 된다고 명시한다. 일반 `agy`에는
효과가 없다. 따라서 환경 변수 이름만 가져와 다계정/그룹 라우팅이 해결됐다고 볼 수 없다.
([0.1.0 배포 소스](https://registry.npmjs.org/@xpufx/paseo-antigravity-claude/-/paseo-antigravity-claude-0.1.0.tgz))

### 채택 후보와 검증 우선순위

**현재 Paseo의 native `antigravity`를 유지하는 경로를 우선한다.** 이 경로는 같은 CLI 로그인으로
quota를 조회할 수 있음을 실측했다. 공식 ACP에서 구독 quota를 받는 지원은 확인되지 않았고,
공개 외부 API 구현은 자체 refresh를 포함한다. ACP의 별도 확장 분리를 미리 결정하는 것이
아니라, 인증 root·quota 조회·모델 목록·권한 모드의 차이를 확인한 뒤 지원 범위를 정한다.

1. **macOS:** lefos13의 구조를 참고한 Keychain 합성 분리 뒤, 실제 같은 계정을 A/B HOME에
   각각 공식 로그인했다. native CLI는 인증을 파일에 저장했고 private Keychain을 잠근 채
   해제 없이 quota·stream-json init을 동시에 실행했다. SSH 환경값도 필요하지 않았다.
   따라서 관리 HOME의 CLI 파일 인증을 우선 구현 후보로 검토한다. 실제 native Keychain
   저장 경로를 지원한다면 저장소 선택·unlock 수명 검증은 별도로 필요하다. 관리 계정 격리
   실패를 성공으로 표시하지 않으며, 호스트 기본 Keychain/search list를 바꾸지 않는다.
2. **Linux native CLI:** 별도 home과 profile 전용 D-Bus/Secret Service의 합성 분리 검증 뒤,
   같은 실제 계정의 A/B 파일 인증 재사용도 실증했다. private HOME과 빈
   `DBUS_SESSION_BUS_ADDRESS`에서 native session init·quota가 성공했으므로, 상주 daemon과
   unlock 암호가 필요 없는 headless 파일 경로를 우선 구현 후보로 검토한다. 실제 다른 계정과
   만료 후 갱신·오류 처리는 남아 있다. 세션·quota·로그인에 같은 인증 환경을 적용해야 한다.
3. **Linux file fallback:** 공식 CLI 1.1.3 changelog에는 D-Bus session이 없으면 keyring을
   우회하는 동작이 있다. 현재 1.4.6에서 독립 HOME의 CLI 자체 파일 저장과 재실행을 실증했다.
   공개 `agyw` README의 `GEMINI_FORCE_FILE_STORAGE`와 ACP의 파일 저장 옵션을 native CLI의
   공식 지원 옵션처럼 안내하지 않는다. 현재 1.4.6 바이너리의 문자열 검사에서도 이 두 옵션과
   `GEMINI_HOME`은 찾지 못했으며, 이는 지원 여부를 확정하는 검사는 아니다.
4. **ACP:** `GEMINI_HOME`+profile-local 저장으로 계정별 공식 `authenticate`를 연결하는
   실험을 한다. native `agy --print /usage`가 ACP 계정을 사용한다고 가정하지 않는다.
   quota는 위 조사 결과를 기준으로 미지원 상태에서 출발한다. 공식 runtime의 quota 응답이나
   그 runtime이 소유·갱신하는 access token을 이용한 읽기 전용 조회 경로가 입증돼야 한다.
   T3 Code의 자체 refresh 구현을 가져오지 않는다.
5. **Windows:** native 다계정 경로는 검증될 때까지 비활성화한다. ACP의 profile-local 저장이나
   별도 OS 사용자/호스트 경계는 대안이지만, 기본 Credential Manager 항목 교체로 대체하지 않는다.

공식 auth-profile selector 요청 [#381](https://github.com/google-antigravity/antigravity-cli/issues/381)은
검토 시점에 open이었다. 댓글에도 확정된 공식 selector 안내는 없었다. 이후 Linux와 macOS에서
독립 HOME의 CLI 파일 인증과 같은 실제 계정의 A/B 동시 실행을 실증했다. 이 결과가 서로 다른
계정 선택이나 자동 전환까지 검증한 것은 아니다.

ACP는 별도 실행 파일과 helper가 필요하다. 조사한 tiezbro 버전은 kernel 1.3.0을 고정하지만,
공식 ACP registry는 현재 1.4.1을 가리킨다. 일부 모델 호환성 patch가 포함된 구현을 그대로
들여오는 대신, 수정하지 않은 공식 runtime에서 현재 계정의 모델·권한·인증 동작을 검증한다.
([공식 ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json))

실증 완료 기준은 두 계정 동시 실행, 계정별 quota 일치, 갱신/재시작 후 identity 일치,
한 계정 logout 시 다른 계정과 호스트 기본 로그인 보존이다. 그 전에는 자동 전환을 켜지 않는다.

## 코드 변경 범위

| 위치 | 필요한 작업 |
| --- | --- |
| `shared/model.ts`, `shared/rpc.ts`, `shared/timeline.ts` | `Family`에 `antigravity` 추가, quota 범위·지원 기능 계약, 기존 RPC/타임라인 호환성 |
| `server/adapter.ts`, 새 `server/antigravity.ts` | CLI quota·identity·인증 연결, 제공자별 login/reset/managed-account 지원 여부 구분 |
| `server/families.ts` | 기본 provider 및 직접 확장 profile 해석, 독립 인증·엔드포인트 제외 |
| `server/binaries.ts`, `server/paths.ts`, `server/homes.ts` | `antigravity` → `agy`, wrapper 인자, 검증된 인증 namespace와 공유/비공개 정책 |
| `server/state.ts` | defaults·main account ID·scope limit 호환성, 상태 복구·이전 데이터 보존 |
| `server/service.ts`, `index.server.ts` | adapter 등록, 목록·잠금·고아 홈 정리, 실제/다음 계정 구분, 조회/전환 조정 |
| `server/routing.ts`, `server/usage.ts`, `server/limits.ts` | 모델별 선택·캐시·limit 적용/해제·공식 오류 감지 |
| `client/accounts-surface.tsx`, `client/add-account.tsx`, `client/pills.ts` | 세 번째 제공자·그룹별 quota·지원 가능한 로그인/전환만 표시 |
| `client/fork-confirm.tsx`, `client/commands.ts`, 설정 및 공유 표시 코드 | 두 제공자 분기 제거, 대상 선택·명령어·라벨·설명 갱신 |
| `README.md`, `docs/agents/architecture.md`, `package.json`, manifest | 실제 지원 범위·최소 버전·설치 및 배포 검증 반영 |

ACP까지 지원한다면 계정 locator에 transport와 credential backend를 구분하는 메타데이터가
필요하다. 같은 Google 계정이나 같은 `Family`라고 인증 파일 경로·세션 portability·quota source가
같다고 볼 수 없다. 모든 `extends: "acp"` profile을 Antigravity로 자동 분류하지 않는다.

`GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `AGY_ADC_AUTH`,
`GOOGLE_APPLICATION_CREDENTIALS` 등 별도 인증/엔드포인트가 있는 profile과 API-key 설정의
`modelProvider: "gemini"`는 구독 라우팅에서 제외하는 방향으로 검토한다. 데몬 상속 환경과
설정 파일도 확인해야 하며, API 키 환경 변수 하나만 보고 인증 방식을 단정하지 않는다.
Gemini API key 모드는 해당 설정과 키가 함께 필요하다는 것이 공식 문서의 설명이다.
([인증 문서](https://antigravity.google/docs/install?tab=cli))

`OTHER_FAMILY`와 `family === "claude" ? "codex" : "claude"`는 세 제공자를 표현할 수 없다.
초기에는 기존 Claude↔Codex 자동 fork 정책을 보존하고 Antigravity의 제공자 간 자동 fork는
끄는 것이 적합하다. 이후 명시적 대상 선택/우선순위를 추가하고, 후보마다 availability·quota·
권한 대응을 검증한다. 기존 설정의 의미를 바꾸지 않고 새 자동 동작은 opt-in으로 둔다.

Paseo 문서와 현재 provider capability에는 full-access만 있다. 따라서 Claude Plan/Always Ask나
Codex Default 같은 원본을 Antigravity로 인계하는 경우 기존 `equivalentMode()`가 권한 상승을
막아야 한다. Antigravity CLI 자체의 다른 mode 존재만으로 Paseo에서도 지원된다고 보지 않는다.
([Paseo provider 문서](https://paseo.sh/docs/supported-providers#antigravity))

계정 간 대화 이동은 확인될 때까지 non-portable로 둔다. 기존 continuation 경로를 재사용하되,
Paseo는 daemon 재시작 후 Antigravity transcript를 replay하지 않는다는 제한이 있다.
인계에 필요한 대화가 실제로 남아 있는지 확인하고, 없는 이력을 전달했다고 표시하지 않는다.
([Paseo provider 문서](https://paseo.sh/docs/supported-providers#antigravity))

## 권장 구현 순서와 완료 조건

최초 구현 단계에 탭 재사용·증분 인계를 추가한 계획이다. 현재 완료·미완료 범위는 위의
「남은 작업과 완료 조건」을 따른다.

| 단계 | 결과물 | 완료 조건 |
| --- | --- | --- |
| 1. quota 기반 최소 지원 | 기존 CLI 로그인 카드, JSON 파서, 그룹별 quota 표시 | 관리 계정 추가·자동 전환·reset은 노출하지 않음. 지원 기능 계약과 timeout/오류/캐시 회귀 테스트 통과 |
| 2. 인증 격리 검증 | 테스트 호스트 실험 결과 및 채택할 공식 selector/namespace | 두 계정 동시 실행·quota 일치·재시작 후 identity 일치·기존 로그인 보호. 실패 시 다음 단계 보류 |
| 3. 수동 다계정 지원 | 공식 로그인 연결, 계정별 선택, binding/default, continuation | 인증 복사 없이 새 세션별 계정 지정, 원본 대화 유지, busy 턴 보존, 삭제 범위 검증 |
| 4. 작업별 계정 탭 재사용 | 기존 탭 재개 검증, 계정별 탭·현재 작업 탭 관리, 증분 인계·전달 복구 | A→B→A→B에서 두 탭 재사용, 독립 작업 분리, 이력 누락·중복 전송·연결 끊김·재시작 검사 및 Codex 회귀 통과 |
| 5. 그룹 단위 자동 처리 | 선택 모델→공유 그룹 대응, quota scope 기반 선택·한도 감지·자동 탭 전환 | 다른 그룹 오차단 없음, stale 실패/일반 429 오탐 없음, 재로드 실패·중복 전환·SwitchGuard 회귀 통과 |
| 6. 제공자 간 인계 | 수동 대상 선택, 선택적 자동 우선순위 | 기존 두 제공자 설정 의미 보존, 대상별 권한 상승 금지, 중복 continuation 및 이력 누락 처리 |

1단계도 `Service`의 기존 전제상 enum만 추가해서 끝나지 않는다. capability를 계약에 넣고
지원하지 않는 login·managed-account·reset 경로가 UI와 RPC 양쪽에서 실행되지 않게 해야 한다.
quota만 읽는 단계에서는 새 인증 환경 patch를 세션에 적용할 필요가 없다.

Paseo의 Antigravity 내장 지원은 공식 v0.11.0 릴리스에 포함되어 있다. 현 manifest의
`>=0.9.1`을 유지할지는 기능 감지 전략과 함께 결정한다. 기존 기능의 호환성을 유지한다면
provider가 실제로 존재하는 호스트에서만 Antigravity 기능을 노출한다. 새 SDK API를 사용하면
실제 필요한 최소 버전으로 manifest와 개발 의존성을 함께 맞춘다.
([Paseo v0.11.0](https://github.com/getpaseo/paseo/releases/tag/v0.11.0))

## 검증 계획과 이번 검토에서 실행한 검사

구현 시 JSON fixture 기반 파서·프로세스 테스트를 추가한다. 성공/비인증/timeout/응답 변경,
fraction 0·1·누락·범위 오류, 여러 bucket, 중복 ID, 잘못된 reset 시각, API-key profile 제외,
모델별 소진·회복·모델 변경, 기존 상태 로드와 Claude/Codex 회귀를 포함한다.
자연어 응답·도구 출력·오래된 턴 오류를 공식 quota 실패로 오인하지 않는 사례도 필요하다.

초기 검토에서는 실제 로그인·로그아웃·계정 삭제·quota 소진 유발·크레딧 사용·운영 에이전트
재로드를 수행하지 않았다. 이후 사용자가 허가한 Linux와 macair의 A/B 프로필에 같은 Google
계정으로 각각 공식 로그인해 동시 quota와 stream-json 초기화를 검증했다. 상세 범위와 한계는
[Linux 보고서](antigravity-linux-isolation.md)와 [macOS 보고서](antigravity-macos-isolation.md)에
기록했다. 서로 다른 계정과 만료 후 갱신은 현재 준비할 수 없어 보류한다.
로그아웃·계정 삭제·quota 소진·크레딧 사용·운영 에이전트 재로드는 계속 수행하지 않는다.

이번 검토의 실행 결과:

- `git status --short`: 시작 시 변경 없음.
- `agy --version`, `agy --help`, `agy models`: 성공.
- `agy --print /usage`: 성공, TSV 5행.
- `agy --print /usage --output-format json`: 두 차례 성공, 구조화 quota와 토큰 0 확인.
- Paseo `list_providers`, `inspect_provider("antigravity")`: available 및 full-access 확인.
  `inspect_provider("agy")`는 미구성으로 응답해 ID와 실행 파일명의 차이를 확인했다.
- `npm run typecheck`: 성공.
- `npm test`: 19개 파일, 150개 테스트 성공.
- `npm run audit:mobile`: 성공. 정규식 검사이며 실제 모바일 검증은 아니다.

최초 검토는 문서와 화면안만 추가했고, 후속 호스트 검증에는 수동 진단 스크립트를 추가했다.
플러그인 실행 코드·의존성·entrypoint·배포 파일을 변경하지 않았으므로
`npm pack --dry-run`, 별도 패키지 설치, Paseo 플러그인 설치·재로드는 이번에 실행하지 않았다.
실제 구현 후에는 이 검사들과 허가된 개발 호스트의 통합 검증이 필요하다.

후속 화면 설계·공개 구현 조사에서는 문서와 HTML 화면안만 변경했다. Chrome에서 736/360/320px,
light/dark, 4개 데이터 상태와 3개 모델 문맥의 72개 조합을 확인했고, 모델 선택·pill 펼침·예시
갱신도 확인했다. 브라우저 오류와 가로 넘침은 없었으며 데스크톱/모바일 화면을 직접 확인했다.
이는 React Native 앱의 실기기 검증이 아니다. 실행 코드 변경이 없어 typecheck/Vitest/mobile
audit는 앞선 검토 결과를 유지하고 반복 실행하지 않았다.

ACP quota 후속 확인에서는 공개 이슈·클라이언트 변경 이력·조회 소스와 PR 병합 상태를
대조했다. 공식 ACP 실행·로그인·토큰 읽기·quota API 호출은 수행하지 않았다. 문서만 보완했으므로
런타임 검사는 반복하지 않았으며, 추가 링크와 로컬 경로 및 공백 오류를 확인했다.
