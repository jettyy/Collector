# trend-alert-bot

10분마다 여러 출처에서 급상승 키워드를 수집하고, 연예·정치·가십·소송 같은 휘발성 주제를 걸러낸 뒤 **정보성 키워드만 텔레그램으로 알림**합니다. 이력은 **브라우저 대시보드**(`http://localhost:3000`)에서 확인합니다. PC 한 대에서 상주 실행하는 것을 전제로 합니다.

## 빠른 시작

```bash
git clone <repo-url>
cd Collector
npm install
cp .env.example .env   # 값 채우기
npm start
```

Node.js 18 이상 (LTS 권장)과, AI 분류용으로 **구독 계정(Pro/Max)에 로그인된 Claude Code**가 필요합니다 (아래 "Claude 구독 계정 연결" 참고). `better-sqlite3`는 Windows/macOS/Linux용 빌드가 미리 포함되어 있어 별도 컴파일 없이 설치됩니다.

### PC 재부팅 후에도 계속 돌리기 (pm2)

```bash
npm i -g pm2
pm2 start src/index.js --name trend-bot
pm2 save
pm2 startup        # 출력되는 명령을 그대로 실행 (Windows는 pm2-windows-startup 사용)
pm2 logs trend-bot # 로그 확인
```

## 환경변수

| 이름 | 설명 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather에서 발급받은 봇 토큰 |
| `TELEGRAM_CHAT_ID` | 알림을 받을 방의 chat id. 봇을 방에 초대한 뒤 `/chatid`를 보내면 알려줍니다 |
| `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` | [네이버 개발자센터](https://developers.naver.com/apps)에서 "검색" API를 사용하는 애플리케이션을 등록 |
| `PORT` | 대시보드 포트 (기본 3000) |
| `BLOG_BOT_CHATS` | 선택. `이름:chat_id` 쉼표 목록. 알림의 "블로그봇에 전달" 버튼이 이 방들로 `주제: OOO`를 보냅니다 |

나머지 옵션(수집 주기, 점수 기준, 재알림 간격, 정치 제외 여부 등)은 `.env.example`에 기본값과 함께 정리되어 있습니다. 키가 비어 있어도 프로그램은 동작합니다:

- 텔레그램 키가 없으면 알림 없이 수집과 대시보드만 동작합니다.
- Claude Code가 없거나 로그인이 풀려 있으면 규칙 기반 휴리스틱으로 분류합니다 (정확도는 떨어집니다).
- 네이버 검색 키가 없으면 관련 기사 매칭을 건너뜁니다.

대시보드 오른쪽 위 배지에서 각 설정 상태를 확인할 수 있습니다.

## 단계별 동작 확인

```bash
npm run collect -- naverNews      # 수집기 하나의 결과만 출력 (naverNews | googleTrends | signalbz | naverDatalab)
npm run collect                   # 모든 수집기
npm run once                      # 전체 파이프라인 1회 실행 (텔레그램 발송 없이 dry-run, DB에는 저장)
node src/cli.js run --only=naverNews,googleTrends --dry
node src/cli.js run               # 실제 알림까지 1회 실행
npm test                          # 파서/필터/스코어링/DB diff 테스트 (외부 API 호출 없음)
```

## 동작 흐름

```
node-cron (*/10 * * * *)
 └ collectors 병렬 수집 (하나가 실패해도 나머지는 계속)
    ├ signalbz      시그널 실시간 검색어 (API → HTML 폴백)
    ├ googleTrends  구글 트렌드 "Trending now" RSS (한국) + 관련 뉴스
    ├ naverNews     네이버 섹션별 헤드라인(섹션 메타 포함) + 언론사별 많이 본 뉴스
    └ naverDatalab  데이터랩 쇼핑인사이트 분야별 인기 검색어
 └ scorer.groupItems   같은 키워드끼리 묶고, 기사 제목에 키워드가 들어 있으면 증거로 연결
 └ categoryFilter      1차: 네이버 섹션으로 연예/스포츠/정치 제외, 경제/생활문화/IT 포함, 사회는 AI로
 └ articleMatcher      관련 기사 검색 (AI 판정용 제목 확보, 1시간 캐시)
 └ aiClassifier        2차: Claude 배치 1회 호출로 "정보성/제외" 판정 + 기사 제목을 짧은 주제어로 요약
 └ scorer              주제어 병합 → 출처 교차 가중치 점수 → 직전 주기와 비교(diff)
 └ DB 저장 → telegramBot 알림
```

### 점수와 알림 규칙

- 출처별 가중치: 구글트렌드 1.2, 시그널 1.0, 네이버뉴스 0.8, 데이터랩 0.6. 순위가 높을수록 최대 1.5배까지 올라갑니다.
- **교차 보너스**: 출처가 하나 늘 때마다 ×1.5 (출처 2개면 ×1.5, 3개면 ×2.0).
- 네이버: 여러 기사가 묶이거나, 헤드라인 클러스터가 크거나, 많이 본 뉴스에도 오르면 가점을 받습니다. 구글: 검색량(트래픽)에 비례해 가점.
- `MIN_SCORE_TO_NOTIFY`(기본 1.2) 이상인 **정보성** 키워드만 알림 대상입니다. 기본값에서는 구글트렌드는 단독으로도 통과하고, 시그널은 12위 안이면 통과합니다. 네이버뉴스와 데이터랩은 단독으로는 통과하지 못해 교차 확인이 필요합니다.
- **신규 등장만 알림**: 직전 주기에도 있던 키워드는 알림을 다시 보내지 않고 `seen_count`만 늘립니다. 단, 이전에는 기준 미달이었다가 다른 출처에서도 잡혀 기준을 넘으면 "교차 확인으로 승격" 알림을 한 번 보냅니다.
- **재알림 방지**: 같은 키워드는 `RENOTIFY_HOURS`(기본 6시간) 안에 다시 알리지 않습니다.
- **첫 실행**: 처음 설치했을 때 이미 떠 있는 키워드가 한꺼번에 알림으로 오지 않도록, 첫 주기에는 기준선만 저장합니다 (`NOTIFY_ON_FIRST_RUN=true`로 끌 수 있음).
- 한 주기 최대 `MAX_ALERTS_PER_RUN`(기본 5)건까지만 보내며, 점수가 높은 순서로 고릅니다.

### Claude 구독 계정 연결 (API 키 불필요)

AI 분류는 이 PC에 설치된 **Claude Code CLI를 `claude -p`(비대화형 모드)로 호출**합니다. 그래서 API 요금이 아니라 로그인한 **구독 계정(Pro/Max)의 사용량**으로 처리됩니다.

```bash
# 1) Claude Code 설치 (택1)
npm install -g @anthropic-ai/claude-code
#    또는 공식 설치 스크립트: https://docs.claude.com/ko/docs/claude-code/setup

# 2) 구독 계정으로 로그인 (브라우저 창이 열림)
claude auth login

# 3) 확인: "loggedIn": true, "authMethod"가 구독 로그인(oauth)이어야 함
claude auth status
```

- 봇은 호출할 때 환경변수의 `ANTHROPIC_API_KEY`를 **일부러 빼고** 실행합니다. 그래서 `.env`나 시스템에 API 키가 남아 있어도 API로 과금되지 않습니다.
- 도구 사용은 끈 상태(`--tools ""`)로, 분류 전용 시스템 프롬프트와 JSON 스키마만 넘겨 호출합니다. 세션 기록은 남기지 않습니다.
- pm2로 띄울 때는 `claude auth login`을 한 **같은 OS 사용자 계정**으로 실행해야 로그인 정보를 읽습니다.
- `claude`가 PATH에 없으면 `CLAUDE_CLI_PATH`에 전체 경로를 지정하세요 (예: Windows `C:\Users\me\AppData\Roaming\npm\claude.cmd`).

**사용량**
- 10분 주기당 1회 배치 호출 (항목이 80개를 넘으면 나눠서 호출). 1회 호출은 보통 5~15초 걸립니다.
- 한 번 판정한 키워드와 헤드라인은 `LABEL_CACHE_HOURS`(기본 12시간) 동안 캐시에서 재사용합니다. 그래서 두 번째 주기부터는 새로 등장한 항목만 보냅니다.
- 구독 사용량은 평소 Claude/Claude Code 사용과 **같은 한도를 공유**합니다. 아끼려면 `CLAUDE_MODEL=sonnet`(또는 `haiku`)을 쓰세요. 비워 두면 Claude Code 기본 모델을 씁니다.
- 한도에 걸리거나 로그인이 만료되면 해당 주기는 휴리스틱으로 대체됩니다. 대시보드의 "AI 분류(구독)" 배지가 취소선으로 바뀌고, 마우스를 올리면 사유가 보입니다.

**API 키로 쓰고 싶다면**: `AI_PROVIDER=api`, `ANTHROPIC_API_KEY=...`로 설정합니다 (기본 모델 `claude-opus-5`, 종량 과금). `AI_PROVIDER=off`로 두면 AI 없이 휴리스틱만 씁니다.

## 텔레그램 알림

```
🔥 신규 트렌드: 청년도약계좌
출처: 구글트렌드, 네이버뉴스 (교차 2건)
점수: 3.4 · 분류: 경제
관련기사:
• 청년도약계좌 10월 신청 시작… 소득 기준 완화
• 청년도약계좌 정부 기여금 확대
[📝 요리블로그] [📝 IT블로그] [📝 생활블로그]
[📝 전체 전달]
[🙈 무시]
```

- 버튼을 누르면 해당 블로그봇 방으로 `주제: 청년도약계좌`가 전송됩니다 (`FORWARD_TEMPLATE`로 형식 변경 가능). 알림 메시지의 버튼은 "✅ 전달됨"으로 바뀝니다.
- `/status`: 최근 실행 요약. `/chatid`: 현재 방의 chat id.
- 버튼 콜백을 받기 위해 봇이 long polling으로 동작합니다. 같은 토큰으로 다른 프로그램이 polling 중이면 충돌하니, 이 봇 전용 토큰을 쓰세요.

> ⚠️ **텔레그램 제약: 봇은 다른 봇이 보낸 메시지를 받지 못합니다.** 기존 블로그봇이 그룹방에서 "사람이 보낸 `주제: OOO`"를 읽어 동작하는 구조라면, 이 봇이 보낸 메시지에는 반응하지 않습니다. 이 경우 방법은 두 가지입니다: (1) 블로그봇이 채널 게시물(`channel_post`)을 받도록 하고 이 봇을 해당 채널 관리자로 추가하거나, (2) 블로그봇이 이 봇의 DB나 대시보드 API(`/api/keywords?notified=1`)를 직접 조회하게 하세요.

## 대시보드

`http://localhost:3000`

- 키워드 목록: 최근 알림 순으로 정렬됩니다. 출처, 분류, 판정 근거, 관련 기사, 연속 감지 횟수, 블로그봇 전달/무시 상태를 보여줍니다.
- 시간대별 신규 감지량 그래프: 정보성/제외 누적 막대이며, "표로 보기" 전환을 지원합니다.
- 기간, 분류(정보성/제외/전체), 출처별 토글, "알림 보낸 것만" 필터와 키워드 검색. 필터 상태는 브라우저에 저장됩니다.
- **발행 완료 체크박스**: 블로그로 발행한 키워드를 표시합니다 (DB `published`).
- "지금 수집" 버튼으로 즉시 1회 실행하고, "최근 실행 기록"에서 수집기별 오류를 확인할 수 있습니다.

기본적으로 이 PC에서만 접속됩니다 (`HOST=127.0.0.1`). 인증이 없으므로 외부에 공개할 때는 주의하세요.

### API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/keywords?hours=24&label=정보성&sources=googleTrends,naverNews&notified=1` | 키워드 이력 (관련 기사 포함) |
| PATCH | `/api/keywords/:id` `{ "published": true }` | 발행 완료 표시 |
| GET | `/api/stats/hourly?hours=24` | 시간대별 신규 감지량 |
| GET | `/api/stats/sources?hours=24` | 출처별 감지 수 |
| GET | `/api/runs` | 최근 실행 기록 |
| POST | `/api/run` | 즉시 1회 실행 |

## 출처별 참고사항

- **signal.bz**: 페이지 구조가 자주 바뀝니다. URL과 셀렉터는 `src/collectors/signalbz.js`의 `ENDPOINTS`/`SELECTORS` 상수만 고치면 됩니다. 네이버 셀렉터도 `naverNews.js`의 `SELECTORS`에 모여 있습니다.
- **구글 트렌드**: `google-trends-api` 패키지의 실시간 트렌드 기능은 구글 쪽 변경으로 더 이상 동작하지 않습니다. 대신 공식 RSS(`trends.google.com/trending/rss?geo=KR`)를 사용합니다.
- **네이버 데이터랩**: 네이버의 "급상승 검색어"는 2021년 2월에 종료되었습니다. 그래서 쇼핑인사이트의 분야별 인기 검색어(일 단위)를 대신 수집하고, `NAVER_DATALAB_CATEGORIES`로 분야를 고릅니다. 일 단위 데이터라 새로 순위에 진입한 키워드만 diff로 잡힙니다. 가중치가 낮아 단독으로는 알림이 가지 않습니다.
- **네이버 뉴스**: 섹션 홈의 헤드라인은 여러 언론사가 동시에 다루는 기사 묶음이라 급상승 신호로 씁니다. 섹션 정보가 붙어 있어 1차 필터에 활용됩니다.

## 폴더 구조

```
src/
├── collectors/        수집기 (공통 인터페이스: async collect() → [{ keyword, source, rank, rawMeta }])
├── filters/           categoryFilter(1차), aiClassifier(2차), claudeClient(구독 CLI / API 호출)
├── enrich/            articleMatcher (네이버 뉴스 검색 API)
├── scoring/           scorer (그룹핑, 교차 가중치, 신규/지속 diff)
├── notify/            telegramBot
├── db/                schema.sql, db.js (SQLite, data/trend.db)
├── server/            Express 대시보드 서버 + API
├── scheduler.js       10분 주기 오케스트레이터
├── cli.js             단계별 확인용 CLI
├── config.js          환경변수 → 설정
└── index.js           진입점 (서버 + 봇 + 스케줄러)
public/                대시보드 (정적 HTML/JS + Chart.js CDN)
test/                  node:test 테스트 + HTML/RSS fixture
```

DB 이력은 30일이 지나면 매일 새벽 자동으로 정리됩니다.
