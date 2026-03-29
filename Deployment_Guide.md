# Tote Scanner 모바일 앱 배포 가이드

현재 개발하신 애플리케이션은 **Node.js 백엔드**와 **단일 HTML 파일 기반의 프론트엔드(React CDN 사용)**로 구성되어 있습니다. 이 구조를 실제 모바일 환경(스마트폰 또는 물류용 PDA)에서 사용할 수 있도록 배포하는 방법을 단계별로 안내해 드립니다.

## 1. 백엔드(서버) 배포

모바일 기기들이 공통된 데이터베이스에 접근하려면, 현재 로컬(`localhost`)에서 돌아가는 Node.js 서버를 외부에서 접근 가능한 클라우드 서버에 배포해야 합니다.

### 추천 호스팅 서비스
* **Render (render.com)** 또는 **Railway (railway.app)**: 설정이 매우 간단하며 Node.js 환경을 완벽히 지원합니다.
* **AWS EC2** 또는 **DigitalOcean**: 더 많은 제어권이 필요할 때 적합합니다.

### 배포 절차 (Render 기준 예시)
1. 코드를 GitHub 저장소에 업로드합니다. (단, `.env` 파일과 `tote_scanner.db` 파일은 제외해야 합니다. `.gitignore`에 추가하세요.)
2. Render에 로그인하여 **New Web Service**를 생성하고 GitHub 저장소를 연결합니다.
3. Build Command를 `npm install`로, Start Command를 `node server.js`로 설정합니다.
4. Environment Variables(환경 변수) 설정 메뉴에서 `.env` 파일에 있던 내용(`SMTP_HOST`, `SMTP_USER`, `ADMIN_EMAIL` 등)을 입력합니다.
5. **주의사항:** Render의 무료/일반 티어는 서버가 재시작될 때마다 로컬 파일(SQLite DB)이 초기화될 수 있습니다. 실제 운영 환경에서는 Render의 **Disk(영구 저장소)** 기능을 추가하여 DB 경로(`DB_PATH`)를 해당 디스크로 설정하거나, SQLite 대신 PostgreSQL/MySQL 같은 외부 DB로 마이그레이션하는 것을 권장합니다.

---

## 2. 프론트엔드(모바일 앱) 배포 방안

현재 작성된 `tote_scanner_mobile.html`을 모바일 기기에서 앱처럼 실행하는 방법은 크게 두 가지가 있습니다.

### 방안 A: PWA (Progressive Web App) 방식 - 가장 추천하는 방법
물류 창고 내부에서 사용하는 툴이라면 앱스토어 심사 없이 즉시 배포 및 업데이트가 가능한 PWA 방식이 가장 효율적입니다.

**적용 방법:**
1. 백엔드 서버가 배포되면, 서버 주소(예: `https://my-tote-scanner.onrender.com`)로 접속하여 모바일 브라우저(Chrome, Safari)에서 HTML 파일을 엽니다.
2. 브라우저 메뉴에서 **"홈 화면에 추가 (Add to Home Screen)"**를 선택합니다.
3. 스마트폰 바탕화면에 일반 앱처럼 아이콘이 생성되며, 실행 시 브라우저 주소창이 사라진 전체 화면(Full Screen) 모드로 작동합니다.

**추가 설정 (선택사항):**
더 완벽한 앱 경험을 위해 HTML 파일의 `<head>` 태그 안에 웹 앱 매니페스트를 추가할 수 있습니다.
```html
<link rel="manifest" href="/manifest.json">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
```

### 방안 B: Capacitor를 이용한 네이티브 앱(APK) 패키징
안드로이드 기기나 PDA에 직접 설치할 수 있는 `.apk` 파일이 필요하다면, 웹 기술을 네이티브 앱으로 감싸주는 **Capacitor**를 사용할 수 있습니다.

**적용 방법:**
1. 로컬 PC에 Node.js가 설치된 상태에서 빈 폴더를 만들고 Capacitor 프로젝트를 초기화합니다.
   ```bash
   npm init @capacitor/app
   npm install @capacitor/core @capacitor/cli
   npm install @capacitor/android
   npx cap add android
   ```
2. 프로젝트 폴더 내에 `www` 폴더를 만들고, 그 안에 `tote_scanner_mobile.html` 파일을 `index.html`로 이름을 변경하여 넣습니다.
3. `capacitor.config.json` 파일에서 `webDir`을 `"www"`로 설정합니다.
4. 프론트엔드 코드 내의 API 호출 주소를 `localhost`가 아닌 **실제 배포된 백엔드 서버의 URL**로 모두 변경합니다.
5. 다음 명령어를 실행하여 안드로이드 프로젝트를 동기화합니다.
   ```bash
   npx cap sync android
   ```
6. Android Studio를 열어 생성된 `android` 폴더를 로드한 후, **Build > Build Bundle(s) / APK(s) > Build APK(s)**를 클릭하여 `.apk` 파일을 추출합니다.
7. 생성된 APK 파일을 모바일 기기나 PDA로 옮겨 설치합니다.

---

## 3. 요약 및 권장 워크플로우

1. **API 주소 변경:** `tote_scanner_mobile.html` 내의 모든 API 요청 주소를 클라우드 서버 주소로 변경합니다.
2. **백엔드 배포:** 코드를 GitHub에 올리고 Render나 AWS를 통해 Node.js 서버를 구동합니다.
3. **앱 배포:** 
   - 초기 테스트 및 빠른 배포를 위해서는 **방안 A (PWA / 홈 화면에 추가)**를 사용하세요.
   - 바코드 스캐너 하드웨어 연동이나 독립적인 설치 파일이 반드시 필요하다면 **방안 B (Capacitor로 APK 빌드)**를 진행하세요.
