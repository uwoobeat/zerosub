# native Antigravity Linux 인증 저장소 격리 검증

검증일: 2026-10-24. native `agy` 1.4.6, Linux x86_64, GNOME Keyring 50.0에서
실제 계정 대신 합성 표식을 사용했다. ZeroSub 실행 코드와 운영 Paseo 설정은 변경하지 않았다.

## 결과

**서로 다른 private D-Bus와 GNOME Keyring을 지정하면 native `agy`의 인증 조회를
분리할 수 있었다. HOME만 바꾸고 D-Bus를 유지하면 같은 Keyring을 읽었다.**
후속 실로그인에서는 **같은 Google 계정을 A/B 두 프로필에 각각 로그인**했고,
새 프로세스의 동시 quota 조회와 D-Bus 없는 native stream-json 초기화까지 성공했다.
서로 다른 두 Google 계정의 라우팅·quota 일치 및 만료 후 갱신은 아직 검증하지 않았다.

| 검사 | 관측 결과 |
| --- | --- |
| private D-Bus 두 개 동시 실행 | 서로 다른 Unix socket 주소를 사용했다. |
| 같은 service/username, 다른 표식 | `gemini` / `antigravity`에 각자 저장한 값만 조회했다. |
| native `agy`의 저장소 조회 | 두 프로필 각각 `org.freedesktop.Secret.Item.GetSecret` 요청을 관측했다. |
| HOME만 바꾼 대조 실험 | 기존 private D-Bus를 유지하면 기존 Keyring을 조회했다. HOME만으로 충분하지 않다. |
| Keyring 데몬 재시작 | 같은 프로필·암호로 재시작한 뒤 각 표식이 유지됐다. |
| 파일 권한 | 프로필 디렉토리 0700, 생성된 Keyring 파일은 group/other 접근 없음. |
| native의 인터넷 연결 | TCP connect는 Landlock, Internet datagram/raw socket과 io_uring은 seccomp로 차단했다. |
| 실제 로그인·계정별 quota | 실행하지 않았다. offline native 종료는 성공한 인증이나 quota 조회를 뜻하지 않는다. |

현재 호스트의 기본 D-Bus·Keyring·CLI 인증 파일을 읽거나 복사하지 않았다. 별도 임시 프로필에
새 표식을 넣었으며 모든 native 출력은 버렸다. D-Bus monitor는 GetSecret **요청 헤더만**
관측하고 secret 응답은 수집하지 않았다. 실험 후 임시 디렉토리와 프로세스 그룹을 정리했다.

## 재현 도구

[`scripts/verify-agy-linux-isolation.py`](../scripts/verify-agy-linux-isolation.py)는 이 검증을
재현하는 진단 도구다. 실제 로그인이나 운영 계정 실행용 launcher가 아니다. 프로필과 암호를
매번 새로 만들고 종료 시 삭제하므로 실제 계정 로그인을 이 도구 안에서 진행하면 안 된다.

의존 도구는 system Python의 `dbus` 모듈, `dbus-run-session`, `dbus-monitor`,
`gnome-keyring-daemon`이다. 이번 호스트에는 이미 설치되어 있어 패키지를 추가하지 않았다.
`--agy`는 Linux x86_64/aarch64와 Landlock network ABI 4 이상 및 seccomp를 요구한다.
제한을 설치할 수 없으면 native 실행 전에 실패한다.

```sh
# 합성 데이터의 저장소 분리·재시작 검사
/usr/bin/python3 scripts/verify-agy-linux-isolation.py

# 설치된 native CLI가 해당 저장소를 조회하는지도 offline으로 검사
/usr/bin/python3 scripts/verify-agy-linux-isolation.py --agy /home/uwoobeat/.local/bin/agy

# 실사용 bus 접근 거부와 커널 제한의 회귀 검사
/usr/bin/python3 scripts/verify-agy-linux-isolation-test.py
```

두 번째 명령의 정상 검사 결과에는 프로필별 `native.private_keyring_read: true`,
`home_only_control.private_keyring_read: true`, `restart_persistence: true`가 포함된다.
native는 인터넷이 차단돼 있으므로 10초 후 종료시켰고 exit 1이었다. 검증 성공의 기준은
인증 저장소 조회 관측이며 native exit 0이나 quota 응답이 아니다.

### 실행 환경과 수명

도구는 자식 프로세스 환경을 새로 만들어 `HOME`, XDG config/data/cache/runtime,
`TMPDIR`, private D-Bus만 지정한다. 부모의 인증 변수·SSH 변수·desktop bus를 상속하지 않는다.
`BROWSER=/usr/bin/false`와 닫힌 stdin을 사용하고 자동 업데이트를 비활성화한다.
사용자가 제공한 `.env`는 이 도구가 읽지 않는다.

각 프로필은 서비스 자동 활성화 경로가 없는 별도 D-Bus 설정을 사용한다. 암호는 실행 중
무작위로 생성해 GNOME Keyring의 stdin에만 전달한다. 명령 인자·문서·로그에 기록하지 않는다.
데몬 재시작은 같은 worker 안에서 기억한 암호를 사용했다.

따라서 이 결과는 **Paseo 서버 재시작 뒤의 자동 unlock까지 입증하지 않는다.** 제품 구현에는
Keyring 잠금 해제와 암호 보관 정책이 추가로 필요하다. 암호를 비워도 된다고 결론 내리거나,
실제 OAuth 토큰을 복사하는 방식으로 이 문제를 우회하지 않는다.

### 오프라인 제한의 대조 검사

처음에는 Unix socket만 허용했지만 native `agy`가 초기화 중 여는 TCP listener도 막혀
인증 조회 전에 종료됐다. 최종 구성은 TCP bind/listen과 Unix socket을 허용하면서 TCP connect를
모두 막는다. 외부뿐 아니라 loopback TCP connect도 막힌다. Internet UDP/raw socket과
io_uring을 통한 우회도 거부한다. x86_64/aarch64 이외의 ABI는 허용하지 않는다.

native 실행 전 별도 자식 프로세스로 다음을 확인한다.

- TCP listener를 만들 수 있다.
- loopback TCP connect가 EACCES로 거부된다.
- Internet UDP socket 생성이 EPERM으로 거부된다.
- Unix socket으로 값을 주고받을 수 있다.

이는 신뢰하는 공식 CLI를 대상으로 한 진단용 제한이다. 같은 OS 사용자 안의 악의적인
프로그램을 격리하는 제품 보안 경계나 완전한 filesystem sandbox로 제공하지 않는다.

## 다음 구현에서 필요한 것

1. 계정마다 private D-Bus와 Keyring 데몬 하나를 감독하고, 해당 계정의 세션·로그인·quota
   프로세스에 같은 환경을 연결한다. quota 조회마다 같은 파일에 별도 데몬을 띄우지 않는다.
2. 잠금 해제 정책을 정하고 daemon/Paseo 재시작 후의 동작을 검증한다. 준비 실패를 숨기거나
   다른 인증 환경에서 실행됐는데 해당 관리 계정으로 성공했다고 기록하지 않는다.
3. 실제 계정 A/B에 공식 CLI로 각각 로그인하고, 실행 계정과 같은 환경의 `/usage`를 비교한다.
   quota 잔량이 우연히 같다는 것만으로 identity 일치를 판단하지 않는다.
4. 공식 CLI 소유의 토큰 갱신, 동시 세션·조회, 재시작 후에도 계정 경계가 유지되는지 확인한다.
   기존 기본 CLI/App/IDE 인증을 보존한다. 실제 logout·삭제 검사는 별도 범위로 둔다.

OS namespace 분리 가능성은 확인됐지만, 이 조건을 만족하기 전에는 다계정 지원 완료나
자동 전환 가능으로 표시하지 않는다. macOS 결과는 [별도 보고서](antigravity-macos-isolation.md)를
참조한다.

## 근거

- [공식 인증 문서](https://antigravity.google/docs/install?tab=cli): Linux는 OS Secret Service/D-Bus를 사용한다.
- [공식 문제 해결 문서](https://antigravity.google/docs/cli/troubleshooting/): Linux Keyring 잠금 해제와 D-Bus 가용성이 필요하다.
- [`dbus-run-session`](https://dbus.freedesktop.org/doc/dbus-run-session.1.html): 별도 bus와 자식 수명을 연결하는 표준 실행 경로다.
- [Secret Service API](https://specifications.freedesktop.org/secret-service/latest/): collection, session, item 조회 계약이다.
- [Landlock network 문서](https://docs.kernel.org/userspace-api/landlock.html): ABI 4부터 TCP bind/connect 제한을 제공한다.

## 이번 변경 검증

위 세 명령을 실행했다. 저장소·native 조회 검사는 성공했으며, 안전 경계 테스트 3개도
통과했다. `npm run typecheck`, `npm test`(19개 파일·150개 테스트), `npm run audit:mobile`도
통과했다. Python 구문·문서 로컬 링크·공백 검사를 수행했다.

진단 도구와 문서 및 `.env` ignore 규칙만 추가했다. 플러그인 실행 코드·entrypoint·의존성·
배포 allowlist는 변경하지 않아 패키지 설치·Paseo reload·게시 검증은 수행하지 않았다.
위 합성 검증 시점에는 실제 Google 로그인을 하지 않았다. 이후의 같은 계정 실로그인 결과는
아래에 추가했다. token refresh·서로 다른 계정별 quota 일치는 미검증이다.

## 같은 실제 계정으로 두 프로필 검증

사용자가 동일 Google 계정을 두 독립 프로필에 각각 공식 로그인하는 검증을 승인했다.
합성 도구는 프로필을 삭제하므로 실로그인에 사용하지 않는다. 대신
[`agy-linux-profile.py`](../scripts/agy-linux-profile.py)를 사용한다.

검증 프로필은 `~/.local/state/zerosub-agy-check/a`와 `b`에 보존한다. 기존 CLI 홈이나
ZeroSub 운영 레지스트리를 연결하거나 복사하지 않는다. 각 호출은 해당 프로필의 flock을
보유한 채 private D-Bus와 GNOME Keyring을 실행하며 종료 시 데몬만 정리한다.
프로필과 CLI가 저장한 인증은 삭제하지 않는다.

테스트 Keyring의 잠금 해제에는 사용자가 제공한, Git에서 제외된 `.env`의
`UBCORE_PASSWORD`를 사용한다. Node의 `process.loadEnvFile()`로 읽고 필요한 값만 메모리
파이프로 받아 Keyring의 stdin에 전달한다. 비밀번호를 명령 인자·native 환경·결과에 넣지 않는다.
이는 이번 검증 도구의 암호 공급 방식이며 제품의 Keyring 암호 보관 정책을 확정하는 것이 아니다.

```sh
/usr/bin/python3 scripts/agy-linux-profile.py status a
/usr/bin/python3 scripts/agy-linux-profile.py login a
/usr/bin/python3 scripts/agy-linux-profile.py usage a
# 같은 절차를 b에도 각각 실행
/usr/bin/python3 scripts/agy-linux-profile.py status b
/usr/bin/python3 scripts/agy-linux-profile.py login b
/usr/bin/python3 scripts/agy-linux-profile.py usage b
```

`login`은 stdin/stdout/stderr 모두 사용자 TTY일 때만 허용한다. Paseo 로그인 전용 터미널에서
사용자가 직접 공식 Google 로그인을 완료하고 Ctrl+C로 native CLI를 종료한다. 도구와 에이전트는
로그인 터미널을 캡처하지 않고 코드 입력을 대신하지 않는다. native 로그 파일도 `/dev/null`로
지정한다. SSH 환경 표식은 CLI 자체의 원격 코드 흐름을 선택하기 위해 지정하며 자체 OAuth나
callback proxy를 구현하지 않는다.

`status`는 Secret Service의 항목 존재와 잠금 여부 및 공식 CLI 인증 파일의 metadata만
확인하며 secret 값을 읽지 않는다. `usage`는 Keyring 항목 또는 안전한 native 인증 파일이
있는 프로필에서만 실행한다. 응답을 1 MiB·45초로 제한하고
`SUCCESS`, `command.name`, `num_turns === 0`, quota fraction·ID·기간·날짜를 검증한 뒤 quota
필드만 출력한다. 전체 CLI JSON이나 에러·계정 이메일·토큰은 출력하지 않는다.

각 호출마다 도구와 D-Bus·Keyring을 새로 시작하므로 로그인 이후 별도 `status`/`usage` 호출의
성공은 도구 프로세스 재시작 후 인증 보존·잠금 해제의 증거가 된다. 운영 Paseo를 실제로
재시작하거나 제품의 재시작 처리를 검증하는 것과는 구분한다.

같은 Google 계정의 quota는 공유된다. 이 실험은 독립된 저장소와 공식 CLI 인증 유지 경로를
검증하며, 서로 다른 계정의 identity·잔량·자동 전환을 검증한 것으로 표시하지 않는다.

```sh
/usr/bin/python3 scripts/agy-linux-profile-test.py
```

검증 도구 회귀 검사는 TTY 요구, symlink 거부, 같은 프로필의 lock 경쟁, 생성 턴 거부,
잘못된 quota/날짜 거부, 동적 bucket 정규화와 불필요한 필드 비출력을 확인한다.
Paseo의 `AGY 로그인 A`와 `AGY 로그인 B` 터미널에서 사용자가 같은 Google 계정으로 각각
로그인하고 native CLI를 종료했다. 이후 결과는 다음과 같다.

### 실로그인 결과와 Linux 파일 저장 경로

| 검사 | 결과 |
| --- | --- |
| A 저장 방식 | 예상한 Keyring 항목은 없고, 공식 CLI가 별도 HOME 안에 `antigravity-oauth-token` 파일을 생성했다. |
| B 저장 방식 | A와 다른 HOME에 같은 종류의 파일을 생성했다. |
| 인증 파일 경계 | 다른 경로·inode, symlink 없음, 각각 0600. 내용은 읽거나 비교하지 않았다. |
| 새 프로세스의 A/B 동시 quota 조회 | 두 프로필 모두 SUCCESS, `num_turns: 0`, 5개 bucket. |
| B 로그인 이후 A 재사용 | A도 별도 재로그인 없이 quota 조회 성공. |
| A에서 D-Bus 환경 변수 생략 | native 인증 파일 open 관측, D-Bus 연결 관측 0, quota 5개 조회 성공. |
| A/B에서 `DBUS_SESSION_BUS_ADDRESS=""` | 새 프로세스에서 동시에 quota 5개 조회 성공. 각 파일 open 관측, D-Bus 연결 관측 0. |
| A/B의 native stream-json | 두 프로필 동시에 `init` 수신, native 파일 open 관측, D-Bus 연결 관측 0. 프롬프트 전송 0회. |

실제 파일은 각 `home/.gemini/antigravity-cli/antigravity-oauth-token`에 있다. 초기 도구는
Keyring 항목만 검사해 저장된 인증을 찾지 못했다. 파일 metadata도 확인하도록 보완한 뒤
공식 CLI의 성공한 quota 응답으로 재사용 가능성을 확인했다. 이 경로를 모든 버전의 공개
파일 계약으로 일반화하지 않고, 이번 native 1.4.6·Linux 호스트의 실측 결과로 취급한다.

[`verify-agy-live-file.py`](../scripts/verify-agy-live-file.py)는 이미 로그인된 프로필에
private HOME/XDG 경로와 빈 D-Bus 주소를 지정한다. 별도 Keyring·D-Bus 데몬이나 `.env`의
잠금 해제 암호 없이 검증한다. `strace`는 openat/connect만 기록하고, file 내용이나
read/write 버퍼를 수집하지 않는다. syscall 기록은 임시 디렉토리에서 사용한 뒤 삭제한다.

```sh
/usr/bin/python3 scripts/verify-agy-live-file.py a usage
/usr/bin/python3 scripts/verify-agy-live-file.py b usage
/usr/bin/python3 scripts/verify-agy-live-file.py a session
/usr/bin/python3 scripts/verify-agy-live-file.py b session
/usr/bin/python3 scripts/verify-agy-live-file-test.py
```

session 검사는 설치된 Paseo 0.12.0 driver의 `--input-format stream-json`,
`--output-format stream-json`, `--add-dir`, `--disable-slash-commands`,
`--dangerously-skip-permissions`를 동일하게 사용한다. 사용자 프롬프트는 보내지 않고 init만
확인한 뒤 종료한다. 운영 Paseo agent 생성·reload나 모델 응답 검증은 수행하지 않았다.

공식 changelog [1.1.3](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md#113)은
D-Bus 부재 시 Keyring 우회를, [1.1.26](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md#1126)은
Keyring 우회/불가 시 native logout의 파일 정리 경로를 설명한다. 이번에는 logout을 실행하지 않았다.

이 결과로 Linux의 **private HOME + 명시적인 headless 파일 인증**을 우선 구현 후보로
검토할 수 있다. 세션 환경 patch의 `null`은 daemon 값 상속이므로 D-Bus 차단에 사용할 수 없다.
빈 문자열을 지정하는 경로가 현버전의 quota와 stream-json 양쪽에서 동작했다.
native 파일이 없거나 손상된 경우의 동작·새 파일 로그인·만료 후 갱신도 별도로 확인해야 한다.
일반 desktop bus를 상속한 상태에서 HOME만 바꾸는 방식이 안전하다고 결론 내리지 않는다.

도구 회귀 검사 14개(합성 경계 3개·live 도구 8개·stream reader 3개)가 통과했다.
실제 서로 다른 계정 identity, 만료 후 공식 CLI refresh, macOS 실로그인 및 ZeroSub 제품
연결은 남아 있다. 이번 결과는 동일 계정의 두 독립 로그인·인증 보존·동시 초기화 검증이다.
