# native Antigravity macOS 인증 저장소 격리 검증

검증일: 2026-10-24. macOS Keychain의 합성 분리와, 같은 실제 Google 계정을 별도 A/B
프로필에 각각 로그인한 뒤 파일 인증을 재사용한 결과다. 서로 다른 두 Google 계정 검증은
아니다. ZeroSub 플러그인 실행 코드와 운영 Paseo 설정은 변경하지 않았다.

## 결과

**macair의 native `agy 1.4.6`에서 같은 계정을 A/B 별도 HOME에 공식 로그인한 뒤,
두 프로필의 quota 조회와 stream-json 초기화를 동시에 확인했다. 실제 인증은 CLI 소유의
파일에 저장됐고, private Keychain이 잠긴 상태에서도 해제 없이 재사용됐다.** Keychain
자체의 합성 분리도 확인했지만 native CLI의 실제 Keychain 사용을 입증한 결과는 아니다.
서로 다른 계정 라우팅·만료 후 갱신과 ZeroSub 제품 연결은 남아 있다.

| 항목 | 관측 결과 |
| --- | --- |
| 원격 연결 | 기존 SSH alias `macair`로 키 인증 성공. Tailscale DNS 전체 이름은 현재 Linux resolver에서 해석되지 않았다. |
| OS | `uname -s`: Darwin, `sw_vers -productVersion`: 27.0.1 |
| native CLI | `/opt/homebrew/bin/agy`, 버전 1.4.6 |
| macOS 도구 | `/usr/bin/security`, `/usr/bin/python3`, `/usr/bin/sandbox-exec` 사용 가능 |
| 빈 shadow HOME | `security default-keychain`은 exit 1. search list는 실사용 HOME과 달랐다. |
| 별도 Keychain A/B | 같은 service/account에 서로 다른 합성 marker 저장 후, 각 HOME에서 자기 marker만 조회했다. |
| 실사용 HOME에서 합성 항목 조회 | exit 44로 찾지 못했다. 실제 Antigravity 항목은 조회하지 않았다. |
| 실제 설정 보존 | 모든 단계 전후 default, search list, security preference 파일의 존재 여부와 존재 시 바이트 해시가 동일했다. |
| native offline 조회 | 전체 네트워크 차단에서는 permission 오류, 로컬 IPC 허용 후에는 로그인 흐름을 감지해 즉시 종료했다. native 저장소 선택 차이는 관측하지 못했다. |
| 실제 A/B 로그인 | 사용자가 같은 Google 계정으로 공식 URL·코드 로그인을 각각 완료했다. |
| 실제 인증 저장 | 각 HOME의 `.gemini/antigravity-cli/antigravity-oauth-token`, 서로 다른 inode·0600. private Keychain의 `gemini/antigravity` 항목은 없음. 값은 읽거나 복사하지 않았다. |
| 새 연결의 동시 quota | 두 프로필 모두 bucket 5개, 모델 턴 0. 두 실행 시간 구간의 겹침을 확인했다. |
| 새 연결의 동시 stream-json | 두 프로필 모두 init 수신, 프롬프트 0. 두 실행 시간 구간의 겹침을 확인했다. |
| Keychain·SSH 의존 | 두 private Keychain이 잠긴 상태였으며 해제하지 않았다. SSH 환경값 3개를 제거한 비TTY 실행에서도 위 두 검사가 성공했다. |

원격 접속은 다음 옵션으로 제한했다. 비밀번호·host key 변경·새 키 등록은 수행하지 않았다.

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 macair ...
```

## 성공한 Keychain 검증

원격 `/usr/bin/python3`로 임시 디렉토리를 만들고, 그 아래 A/B 두 개의 HOME을 준비했다.
각 HOME의 `Library/Keychains`와 `Library/Preferences`는 실제 디렉토리이며 실사용 HOME의
Keychain 또는 `com.apple.security.plist`를 연결하거나 복사하지 않았다.

각 계정에서 다음 `security` 명령을 실행했다. `HOME`은 각 자식 프로세스의 환경에만
지정했다. 테스트 비밀번호는 실행 중 임의 생성한 합성 값이며 저장하거나 출력하지 않았다.

```text
create-keychain -p <synthetic-password> <shadow-home>/Library/Keychains/account.keychain-db
set-keychain-settings <shadow-home>/Library/Keychains/account.keychain-db
default-keychain -s <shadow-home>/Library/Keychains/account.keychain-db
unlock-keychain -p <synthetic-password> <shadow-home>/Library/Keychains/account.keychain-db
add-generic-password -s <unique-test-service> -a synthetic-account -w <marker-for-this-home>
find-generic-password -s <unique-test-service> -wa synthetic-account
```

마지막 add/find에는 Keychain 경로를 명시하지 않았다. native CLI의 후보 backend와 같이
실행 환경의 default/search list에 의존하는 작업이다. A/B에서 같은 service와 account를
사용하고 저장한 marker 값만 바꿨다. 출력에는 값 대신 일치 여부만 기록했다.

각 작업 후 실사용 HOME의 `security default-keychain`, `security list-keychains`와 security
preference 파일의 존재 여부 및 존재 시 해시를 시작 시점과 비교했다. 모두 일치했고, A/B의 search list에는 서로의
HOME이 포함되지 않았다. 실사용 HOME에서는 합성 항목을 찾지 못했다. 마지막에는 생성한 임시
디렉토리만 삭제하고 실사용 설정이 그대로인지 다시 확인했다.

이는 해당 macOS·SSH 세션에서 관측한 결과다. 다른 OS 버전이나 GUI/launchd 세션에서도
동일하게 동작한다는 보장은 아니다.

## native `agy` 확인과 한계

설치된 native binary에서 비밀 정보가 아닌 문자열 `/usr/bin/security`, `keyring_darwin.go`,
`go-keyring-base64:`의 존재를 확인했다. 전체 의존 패키지명 `github.com/zalando/go-keyring`은
찾지 못했다. 문자열만으로 해당 라이브러리 사용이나 현재 인증 경로를 단정하지 않는다.
빈 임시 HOME에서의 `agy --help`는 exit 0이었고 파일을 생성하지 않았다.

추가로 별도 Keychain 두 개를 준비하고 한쪽에만 service `gemini` / account `antigravity`의
의도적으로 잘못된 합성 JSON을 저장했다. 실제 사용자 항목이나 토큰은 읽거나 옮기지 않았다.
다음 명령을 양쪽 HOME에서 실행했다.

```text
sandbox-exec -f <temporary-offline-profile> /opt/homebrew/bin/agy --print /usage --output-format json
```

실험에는 다음 제약을 적용했다.

- sandbox의 `deny network*`로 네트워크를 차단했다. 브라우저를 실행하는 `open`과
  `osascript`를 거부하고 `BROWSER=/usr/bin/false`, 닫힌 stdin을 사용했다.
- 실제 HOME 전체 읽기·쓰기 거부와, 실제 `.gemini`·Keychains·Preferences 읽기만 거부하는
  구성을 모두 확인했다. 실제 HOME과 `/opt/homebrew` 쓰기도 막아 실제 설정과 설치된 CLI를
  갱신하지 못하게 했다.
- 출력 크기와 실행 시간을 제한하고 OAuth URL·로그인 요청을 감지하면 종료하도록 했다.
  stdout/stderr 원문을 출력·저장하지 않고 종료 코드·크기·분류만 기록했다.

전체 네트워크 차단 구성의 최종 시도는 양쪽 HOME 모두 약 0.1초에 exit 1,
71 byte의 permission 오류로 끝났다.
keyring, JSON parse, quota 응답의 차이를 얻지 못했고 로그인 URL이나 업데이트 처리의 징후도
관측하지 못했다. native 인증 조회를 입증하지 못했다. `deny network*`는 로컬 IPC도 거부하므로
CLI 시작 준비를 먼저 막았을 가능성이
있다. 이 결과를 인증 격리 실패의 증거로 삼을 수도 없다.

이후 `deny network-outbound`에 Unix socket만 허용하는 규칙을 추가해 로컬 IPC와 TCP
bind/listen을 허용했다. 별도 Python smoke에서 localhost bind/listen 성공과 외부 IP의 TCP
connect `EPERM` 차단을 확인했다. 이 구성에서는 두 HOME 모두 로그인 흐름 문자열을 감지했고,
약 0.1~0.7초에 바로 종료했다. URL·인증 정보는 출력하지 않았고 Google 인증 연결도 차단된
상태였다. stdout/stderr와 임시 로그를 분류해도 Keychain/JSON parse 차이는 얻지 못했다.
마지막으로 자식 프로세스 이름과 테스트 HOME 상속 여부를 짧게 관측했지만 `security` 실행을
잡지 못했다. 짧은 프로세스를 놓칠 수 있으므로 미관측을 Keychain 미사용의 증거로 삼지 않는다.

모든 시도 후 임시 HOME·Keychain을 삭제하고 실사용 default/search list/preference가 그대로인지
확인했다. 로그인 URL을 안내하는 경로는 즉시 종료했고 실제 Google 계정 인증·로그아웃·quota
호출·운영 agent reload는 수행하지 않았다.

## 초기 Keychain 경로에 남은 확인 조건

1. 외부 통신을 차단한 실험에서 native CLI의 자격 증명 읽기·쓰기가 shadow Keychain에
   도달하는지 확인한다. 필요한 로컬 IPC만 허용하고 외부 INET 통신은 계속 차단한다.
2. 후속 실로그인은 아래처럼 완료했으나 CLI는 파일에 인증을 저장했다. native Keychain 경로를
   채택한다면 해당 저장소 선택을 별도로 입증해야 한다. 서로 다른 계정 식별자와 `/usage`의
   계정 일치도 아직 미검증이며, 자격 증명 자체를 ZeroSub로 옮기지 않는다.
3. A/B 동시 실행, CLI 소유 token refresh, daemon/SSH 세션 재시작 뒤에도 default/search list와
   계정 경계가 유지되는지 확인한다.
4. Keychain 준비·unlock 실패 시 해당 관리 계정을 사용 불가로 처리한다. 실사용 Keychain으로
   fallback한 채 세션을 계속하지 않는다. 잠금과 접근 허가 문제를 구분해 표시한다.

기존 공개 구현은 `HOME/Library/Keychains`와
`HOME/Library/Preferences/com.apple.security.plist`를 분리한다. 이는 이번 합성 시험과
일치한다. 다만 해당 구현은 빈 Keychain password와 자동 잠금 해제를 사용하고 초기화 실패를
로그로 남긴 뒤 계속한다. ZeroSub의 실패 처리 조건에 그대로 적용하지 않는다.

## 근거와 검증 범위

- [공식 인증 문서](https://antigravity.google/docs/install?tab=cli): CLI는 native Keychain을
  사용하며 저장된 인증이 없으면 공식 로그인 흐름으로 진행한다.
- [공식 문제 해결 문서](https://antigravity.google/docs/cli/troubleshooting/): macOS Keychain
  잠금·접근 허가와 SSH 환경 주의점을 설명한다. 이번에는 실사용 Keychain 설정을 바꾸지 않았다.
- [Apple `security` 명령 정의](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.1):
  default/search list와 Keychain 경로를 생략한 find 작업의 의미를 확인했다.
- [go-keyring macOS backend](https://github.com/zalando/go-keyring/blob/master/keyring_darwin.go):
  `security`를 사용하는 공개 backend와 동작을 비교했다. native binary의 의존성을 확정하는 자료는 아니다.
- [공개 Paseo 구현](https://github.com/lefos13/paseo-plugin-antigravity-cli/blob/1d43a3855cf62e1bdb1ea334e7fc36941a357e35/server/accounts.ts):
  shadow HOME·Keychain 구현 비교 대상이다. 이 구현을 실행하거나 설치하지 않았다.

최초 합성 검증에서는 이 문서만 추가했다. 실행 코드 변경이 없어 해당 단계에서는
typecheck/test/mobile audit을 실행하지 않았다. 링크·기재 경로와 `git diff --check`를 확인했다.

## 후속 실제 로그인 검증 도구

사용자 요청으로 macair에서 같은 Google 계정을 별도 A/B 프로필에 각각 공식 로그인하는
검증을 수행했다. 현재 할 수 없는 서로 다른 계정과 만료 후 갱신 검증은 보류한다.
다음 도구는 수동 호스트 검증용이며 플러그인의 인증 launcher가 아니다.

- [Mac 프로필 도구](../scripts/agy-macos-profile.py): `prepare`, `login`, `status`, `usage`, `session`.
- [합성 회귀 테스트](../scripts/agy-macos-profile-test.py): 비밀 전달·경로·잠금·환경·입력 검증과
  명시적으로 선택하는 임시 Keychain 통합 시험.
- quota 정규화와 프로세스 제한은 [Linux 도구](../scripts/agy-linux-profile.py), 프롬프트 없이
  stream-json init만 확인하는 부분은 [기존 init 검사](../scripts/verify-agy-live-file.py)를 재사용한다.

인증은 Mac의 `~/.local/state/zerosub-agy-check/{a,b}` 아래에 공식 CLI가 직접 저장한다.
Linux의 인증 파일이나 실제 Mac 로그인 Keychain을 복사하지 않는다. `prepare`는 별도 비TTY
SSH 연결의 stdin에서만 시험 Keychain 암호를 받고, `security -i`의 stdin으로 전달한다.
암호를 argv·환경 변수·로그·Mac의 평문 파일에 넣지 않는다. 이후 로그인 터미널에는
준비된 프로필 경로만 전달하고 Google 인증은 사용자가 직접 완료한다.

새 SSH 연결에서는 `prepare` 직후라도 private Keychain이 다시 잠긴 상태였다. 따라서 다른
연결에서 한 unlock을 로그인·조회 연결에 재사용하지 않는다. `login`은 같은 SSH TTY 안에서
잠긴 private Keychain을 Apple의 `security unlock-keychain <private 경로>` 암호 프롬프트로
해제하고, 상태 확인 뒤 공식 CLI를 실행한다. Mac 암호는 터미널에만 직접 입력한다.
`status/usage/session --unlock-stdin`은 같은 비TTY SSH 연결의 stdin에서 받은 암호를 기존
`security -i`의 stdin으로 전달해 해제한 뒤 검사한다. `login --unlock-stdin`은 거부한다.
기존 프로필이나 인증을 다시 만들지 않고 프로필 잠금 안에서 처리하며, 해제 실패 시 CLI를
실행하지 않는다. 이 도구의 연결별 unlock은 제품의 무인 재시작 정책을 확정한 것이 아니다.

프로필마다 flock을 사용하고 private HOME·Keychain·Preferences의 링크와 소유권을 검사한다.
사용자 domain의 default/search list는 자기 Keychain 하나만 허용한다. implicit search에
추가되는 `/Library/Keychains/System.keychain`은 해당 native 인증 항목이 없을 때만 허용하고,
기존 사용자 로그인 Keychain이 섞이면 중단한다. 모든 작업 전후 실사용 HOME의 default,
search list와 security preference 지문을 비교한다. 인증 항목은 attributes-only 명령의 종료
코드와 파일 metadata만 확인하며 값은 읽지 않는다.

Mac 합성 시험은 다음처럼 명시적으로 실행한다. Google 로그인이나 native CLI는 실행하지
않으며, 시험에서 생성한 임시 프로필만 정리한다.

```sh
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 scripts/agy-macos-profile-test.py
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 scripts/agy-macos-profile-test.py --macos-integration
```

연결별 잠금 해제와 터미널 식별 보완 후 macair에서 위 통합 시험 22개가 통과했다. 기존 A/B 프로필에서도
각각 새 비TTY SSH 연결의 `status --unlock-stdin`으로 `private_keychain_unlocked: true`와
`real_keychain_settings_unchanged: true`를 확인했다. 이 시점에는 두 프로필 모두 인증 항목과
인증 파일이 없었다. `AGY Mac 로그인 A` 사용자 터미널에서 Apple 암호 입력 후 `agy`까지
실행됐지만 사용자는 도구의 안내 문구만 보고했다. 아래 합성 PTY 실험으로 DA2 응답 대기와
터미널 식별 환경을 보완했다. 수정한 환경에서 사용자가 A/B 로그인을 각각 완료했고 아래의
새 연결 검사를 통과했다. 실사용 터미널 출력·OAuth URL·코드는 캡처하지 않았다.
Keychain 해제, 안내 표시, 실제 CLI 로그인 성공, 인증 저장 위치를 각각 구분한다.

로컬 합성 회귀는 21개 통과·Mac 통합 1개 생략이며, 별도로 `npm run typecheck`,
`npm test -- --silent`(150개), `npm run audit:mobile`이 통과했다. Linux 도구와 플러그인
실행 코드는 수정하지 않아 Linux 실로그인 검증은 반복하지 않았다. 제품 설치·재로드도
수행하지 않았다. 후속 실로그인 검증은 다음 절에 기록한다.

비밀번호 인자를 생략할 때 Apple 도구가 자체 암호 입력 함수를 호출하는 것은
[Apple unlock 구현](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_unlock.c)에서
확인했다. 다른 SSH 연결에서 해제 상태를 유지해 준다는 가정은 사용하지 않는다.

## SSH 터미널에서 로그인 안내가 보이지 않은 원인

같은 미로그인 B 프로필과 `agy 1.4.6`을 사용하고, OAuth 입력 없이 출력 크기·제어 요청과
안내 유무만 분류했다. 합성 PTY 출력은 메모리에서 분류 후 폐기했으며 원문·URL·코드를
파일이나 보고서에 남기지 않았다. 각 실행은 제한 시간 후 종료했고 실사용 Keychain 설정은
그대로였다. 사용자 A 터미널의 출력은 캡처하지 않았다.

| 조건 | 관측 |
| --- | --- |
| controlling TTY가 없는 실행 | 0.5초 안에 stderr로 공식 URL·코드 입력 안내. `/dev/null`과 `/dev/stderr` 로그 목적지에서 모두 표시됨. |
| 세 스트림이 TTY, `TERM_PROGRAM` 없음 | 출력 4바이트가 DA2 식별 요청 `ESC[>c`였으며 안내가 나오지 않음. |
| 같은 실행에서 표준 DA2 응답만 제공 | 추가 OAuth 입력 없이 공식 URL·코드 입력 안내가 즉시 표시됨. |
| stdin만 DEVNULL 또는 `SSH_TTY`만 제거 | DA2 요청 후 대기 유지. |
| stdout DEVNULL, 또는 stdout DEVNULL·stderr PIPE | controlling TTY에 DA2 요청 후 대기 유지. 스트림 변경은 채택하지 않음. |
| 세 스트림 TTY에 `TERM_PROGRAM=Paseo`만 추가 | DA2 요청 없이 공식 URL·코드 입력 안내가 표시됨. |
| `TERM=dumb`, `LC_TERMINAL=iTerm2`, `NO_COLOR=1` | 각각 표시 문제를 해소하지 못함. |

따라서 합성 환경에서의 정지는 native CLI의 터미널 식별 응답 대기로 확인했다. Paseo/SSH
터미널 경로에서 응답을 받지 못하는 구간은 더 세분화하지 않았다. `profile_env`가 호출자의
`TERM_PROGRAM`을 형식 검증 후 선택적으로 보존하도록 수정했다. 변수 값이 없을 때 기본값을
만들지 않고, 실제 Paseo 터미널에서 시작하는 SSH 명령에만 `Paseo`를 명시한다.
CLI가 이 값으로 어느 내부 분기를 택하는지는 확정하지 않았다.

```sh
ssh -t -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 macair \
  env TERM_PROGRAM=Paseo PYTHONDONTWRITEBYTECODE=1 \
  /usr/bin/python3 .local/state/zerosub-agy-check/bin/agy-macos-profile.py login a
```

`login`은 TTY를 그대로 상속한 공식 `agy --print /usage --output-format json`을 실행한다.
사용자는 CLI 안내의 URL과 코드를 직접 처리하고 조회 후 자동 종료를 기다린다. 결과는
저장 인증 metadata와 명령 종료 코드로 확인하며, 종료 코드가 0이 아니면 저장 인증이 있어도
성공으로 보고하지 않는다. 실제 quota는 후속 비대화형 `usage --unlock-stdin`으로 정규화한다.
[공식 변경 이력](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)은
print 모드의 `/dev/tty` 코드 입력과 `/usage`의 모델 턴 없는 조회를 설명한다.

현재 로그인 도구에 stdout 리다이렉션·DA2 자동 응답·PTY 프록시를 추가하지 않았다. 이전 A
실행에 한 번 수동 응답을 보낸 결과도 실제 인증 성공으로 간주하지 않았다. 안내 표시 우회는
현재 CLI 버전의 실측 결과다. 이 보완 뒤 실제 사용자 로그인·저장 위치·새 연결 quota와
stream-json init도 다음처럼 확인했다. CLI 버전 변경 시 이 단말 식별 조건도 다시 검증한다.

## 같은 실제 계정의 A/B 로그인·재실행 결과

사용자가 수정된 `AGY Mac 로그인 A/B` 터미널에서 같은 Google 계정으로 공식 로그인을
각각 완료하고 자동 종료를 확인했다. 이후 새 SSH 연결에서 다음을 검증했다.

1. A의 `status/usage/session`을 차례로 실행했다. 파일 인증 존재, private Keychain 항목 없음,
   bucket 5개·모델 턴 0, init 수신·프롬프트 0을 확인했고 실제 HOME의 보안 설정은 동일했다.
2. A의 Keychain을 해제하지 않는 새 연결에서도 quota와 init이 성공했다. 검사 시작 시
   private Keychain은 잠겨 있었고 인증 파일 권한은 `0600`이었다.
3. B 로그인 뒤 A/B를 별도 프로세스로 동시에 검사했다. 각 프로필의 잠금과 임시 실행
   디렉토리를 사용했고, 각 native 환경에서 `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`를
   제거했다. 두 private Keychain이 잠겨 있는 상태 그대로 해제 없이 실행했다.
4. 두 프로필 모두 quota bucket 5개·모델 턴 0, stream-json init·프롬프트 0이었다. quota
   프로세스끼리와 init 프로세스끼리 실제 실행 시간 구간이 겹쳤다. 인증 파일의 device/inode
   조합은 서로 달랐고 각 `0600`·단일 링크·사용자 소유 파일이었다. 값은 읽거나 복사하지 않았다.
5. 모든 단계에서 실사용 HOME의 default/search list와 security preference 지문은 같았다.

3번은 Paseo와 같은 stream-json 옵션의 비TTY 실행에 SSH 전용 환경값이 필요하지 않음을
확인한 것이다. 운영 Paseo 데몬을 재시작하거나 플러그인에 연결한 통합 검증은 아니다.
프로필 도구의 일반 `usage/session`은 여전히 Keychain 해제를 요구하는 보수적 준비 경로이며,
2·3번은 동일한 환경·제한 실행 함수를 사용하되 unlock을 생략한 수동 검사였다.

현재 macOS에서는 상주 Keychain unlock 없이 관리 HOME의 공식 CLI 파일 인증을 재사용하는
경로를 우선 구현 후보로 삼을 근거가 생겼다. 실제 Keychain에 native 인증을 저장한 것으로
보고하지 않는다. 같은 계정을 썼으므로 quota는 공유되며, 서로 다른 계정의 라우팅·로그아웃
격리·만료 후 CLI 자체 갱신은 미검증이다. OS 재부팅·운영 Paseo 재시작도 수행하지 않았다.
