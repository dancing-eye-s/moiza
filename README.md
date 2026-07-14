# 모이자고 (MOIZA-GO)

모바일 우선 그룹 일정 조율 웹앱. 3일 단위 시간 입력, 전체 후보 집계, 수정 가능한 공유 문구, 좌표 기반 중간지점, 참여자 장소 추천, 운영자 일정 확정과 결과 공유를 지원한다. 마감 Cron·Gmail 발송 API도 포함되어 있으며 Gmail 자격증명이 없으면 발송을 건너뛴다.

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
| `GEOCODER_BASE_URL` | 선택 사항. 기본 OpenStreetMap Nominatim 검색 API를 대체할 지오코딩 엔드포인트 |
| `GEOCODER_USER_AGENT` | 선택 사항. 지오코딩 요청 식별용 User-Agent |

Sheets 자격증명이 없으면 로컬 JSON, Gmail 자격증명이 없으면 `/api/cron/deadline`이 발송을 건너뛰고 로그만 남긴다.

## 구조

- `server.js` — HTTP 핸들러 (로컬 실행 + Vercel 서버리스 겸용), REST API 라우팅
- `store.js` — Sheets/로컬 JSON 백엔드 추상화 (이벤트·참여자·가용시간·장소·확정 상태)
- `geocoder.js` — 한국 지역 좌표화, 요청 캐시·속도 제한, 중간지점 허브 계산
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
