# 모이자고 (MOIZA-GO)

모바일 우선 그룹 일정 조율 웹앱. M1(생성 퍼널·참여·히트맵·Sheets 연동), M2(수정 가능한 공유 문구·베스트타임), M4(초대장 캔버스), 장소 추천까지 구현되어 있고, M3(마감 Cron·Gmail 발송)은 API가 동작하지만 Gmail 자격증명이 없으면 발송을 건너뛴다.

## 로컬 실행

```bash
node server.js
# http://localhost:4175
```

Google Sheets 자격증명이 없으면 `data/state.json`에 로컬로 저장된다 (개발용 폴백, git에는 커밋되지 않음).

## 환경 변수 (.env)

| 변수 | 용도 |
|------|------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Sheets 서비스 계정 키 JSON (한 줄) |
| `GOOGLE_SHEETS_ID` | 스프레드시트 ID |
| `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` / `GMAIL_OAUTH_REFRESH_TOKEN` | 결과 이메일 발송용 Gmail API OAuth 자격증명 |
| `GMAIL_SENDER_EMAIL` | 발신자로 표시할 이메일 |
| `PUBLIC_BASE_URL` | 이메일 내 결과 페이지 링크에 사용할 배포 도메인 |

Sheets 자격증명이 없으면 로컬 JSON, Gmail 자격증명이 없으면 `/api/cron/deadline`이 발송을 건너뛰고 로그만 남긴다.

## 구조

- `server.js` — HTTP 핸들러 (로컬 실행 + Vercel 서버리스 겸용), REST API 라우팅
- `store.js` — Sheets/로컬 JSON 백엔드 추상화 (이벤트·참여자·가용시간·초대장)
- `google.js` — Sheets API 연동 (서비스 계정 JWT 인증)
- `mailer.js` — Gmail API 결과 이메일 발송
- `schedule.js` — 슬롯 그리드 생성 + 베스트타임 랭킹 계산 (서버·이메일 공용)
- `script.js` — 클라이언트 SPA (경로 기반 라우팅, 생성 퍼널, 참여/그리드/히트맵, 초대장 캔버스, 공유 바텀시트)
- `styles.css` — 토스 스타일 디자인 시스템

## 남은 작업 (오픈 이슈, PRD 11절 참고)

1. Kakao JS SDK 앱 키 연동 (현재는 `window.Kakao` 미설정 시 카카오 공유 버튼 자동 숨김)
2. Gmail 발신 계정 자격증명 실제 연결 및 발송 테스트
3. 30일 자동 삭제 Cron(`/api/cron/purge`)의 프로덕션 스케줄 검증 (Vercel Cron 설정은 `vercel.json`에 포함)
4. 결과 이미지 공유용 캔버스 디자인 고도화 (현재는 텍스트 위주 단순 카드)
