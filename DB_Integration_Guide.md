# Tote Scanner DB 연동 가이드

현재 제공해주신 **Tote Scanner** 애플리케이션의 구조를 분석한 결과, 백엔드(`server.js`)에는 이미 SQLite 데이터베이스(`better-sqlite3`)와 REST API가 완벽하게 구현되어 있습니다. 하지만 모바일 프론트엔드(`tote_scanner_mobile.html`)는 현재 브라우저의 로컬 스토리지(`localStorage`)를 사용하여 데이터를 저장하고 있습니다. 

따라서 "DB를 애플리케이션에 적용한다"는 것은 **프론트엔드(HTML)가 백엔드(Node.js)의 API를 호출하여 실제 SQLite DB에 데이터를 저장하고 불러오도록 연동하는 작업**을 의미합니다.

아래는 프론트엔드 코드를 수정하여 백엔드 DB와 연동하는 구체적인 방법입니다.

## 1. API 엔드포인트 설정

`tote_scanner_mobile.html` 파일의 상단(React 코드 시작 부분)에 백엔드 서버의 API 주소를 상수로 정의합니다.

```javascript
// 백엔드 API 기본 주소 설정 (배포 환경에 맞게 IP/도메인 변경 필요)
const API_BASE_URL = "http://localhost:3001/api";
```

## 2. DB 객체 수정 (localStorage -> Fetch API)

기존에 `localStorage`를 사용하던 `DB` 객체를 백엔드 API와 통신하도록 비동기(Promise) 함수로 변경해야 합니다.

**기존 코드:**
```javascript
const DB={
  getJobs:()=>{try{return JSON.parse(localStorage.getItem("ts_jobs")||"[]")}catch{return[]}},
  addJob:(j)=>{const a=DB.getJobs();a.unshift(j);localStorage.setItem("ts_jobs",JSON.stringify(a.slice(0,500)))},
  // ...
};
```

**수정된 코드:**
```javascript
const DB = {
  // 서버에서 작업 목록 가져오기
  getJobs: async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/jobs`);
      if (!res.ok) throw new Error("Failed to fetch jobs");
      return await res.json();
    } catch (e) {
      console.error(e);
      return [];
    }
  },
  
  // 서버에 새 작업(Manifest) 생성하기
  createJob: async (manifestNo, label, totes) => {
    try {
      const res = await fetch(`${API_BASE_URL}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest_no: manifestNo, label, totes })
      });
      return await res.json();
    } catch (e) {
      console.error(e);
      return null;
    }
  },

  // 스캔 완료 결과 서버에 전송하기
  completeJob: async (jobId, mode, scanned, missed) => {
    try {
      const res = await fetch(`${API_BASE_URL}/jobs/${jobId}/complete/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scanned, missed })
      });
      return await res.json();
    } catch (e) {
      console.error(e);
      return null;
    }
  },
  
  getCfg:()=>{try{return JSON.parse(localStorage.getItem("ts_cfg")||"{}")}catch{return{}}},
  saveCfg:(s)=>localStorage.setItem("ts_cfg",JSON.stringify(s)),
};
```

## 3. Manifest 로드 로직 수정 (App 컴포넌트)

CSV 파일을 업로드하거나 데모 데이터를 로드할 때, 백엔드 DB에 작업을 생성하고 반환된 `jobId`를 상태로 관리해야 합니다.

**수정 포인트 (`loadManifest` 함수):**
```javascript
// App 컴포넌트 내부에 jobId 상태 추가
const [currentJobId, setCurrentJobId] = useState(null);

const loadManifest = async (totes, label, no) => {
  if(!totes){
    setManifest(null); setLSess(null); setOSess(null); setCurrentJobId(null);
    return;
  }
  
  // 1. 백엔드 DB에 Job 생성 요청
  const jobData = await DB.createJob(no, label, totes);
  
  if (jobData && jobData.id) {
    setCurrentJobId(jobData.id); // 서버에서 발급한 DB ID 저장
    setManifest({totes, label, manifestNo:no});
    setLSess(mkSess(totes));
    setOSess(mkSess(totes));
    showToast(totes.length+" totes loaded to DB");
  } else {
    showToast("Failed to create job in DB", "error");
  }
};
```
*(주의: `loadManifest`가 비동기 함수가 되므로, 이를 호출하는 `ManifestScreen`의 `load` 함수도 `async/await` 처리가 필요할 수 있습니다.)*

## 4. 스캔 완료 로직 수정 (App 컴포넌트)

스캔을 완료하고 저장할 때, 로컬 스토리지가 아닌 백엔드 API로 스캔된 데이터와 누락된 데이터를 전송합니다. 백엔드(`server.js`)에 이미 이메일 발송 로직이 구현되어 있으므로, 프론트엔드의 EmailJS 대신 백엔드의 이메일 기능을 활용하는 것이 좋습니다.

**수정 포인트 (`confirmComplete` 함수):**
```javascript
const confirmComplete = async (mode, v) => {
  const sess = mode === "load" ? lSess : oSess;
  const setSess = mode === "load" ? setLSess : setOSess;
  const time = new Date().toLocaleTimeString("en-GB", {hour12:false});
  
  const scannedTotes = [...sess.scannedSet].map(id => ({
    toteId: id, 
    storeId: sess.toteMap.get(id)
  }));
  const missedTotes = v.notScanned;

  // 백엔드 API 호출하여 완료 처리 (이메일 발송도 백엔드에서 자동 처리됨)
  const result = await DB.completeJob(currentJobId, mode, scannedTotes, missedTotes);

  if (result && result.success) {
    setSess(s => ({...s, completed: true, log: [...s.log, {time, msg: "SAVED TO DB", type: v.missing === 0 ? "ok" : "warn"}]}));
    setModal(null);
    
    if(v.missing === 0) showToast("Complete! Saved to DB", "ok");
    else showToast(v.missing + " missed · Saved to DB & Admin notified", "warn");
  } else {
    showToast("Failed to save to DB", "error");
  }
};
```

## 5. History 화면 수정

기존에는 동기적으로 `DB.getJobs()`를 호출했지만, 이제 비동기로 서버에서 데이터를 가져와야 합니다.

**수정 포인트 (`HistoryScreen` 컴포넌트):**
```javascript
const HistoryScreen = () => {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchJobs = async () => {
      const data = await DB.getJobs();
      setJobs(data);
      setLoading(false);
    };
    fetchJobs();
  }, []);

  if (loading) return <div style={{color: "white", padding: 20}}>Loading history from DB...</div>;
  
  // ... 기존 렌더링 로직 유지 (jobs 배열 사용) ...
};
```

## 요약

위와 같이 수정하면 프론트엔드가 백엔드의 `server.js`와 완벽하게 통신하게 됩니다. 
1. **데이터 영속성:** 앱을 껐다 켜거나 다른 기기에서 접속해도 SQLite DB에 데이터가 안전하게 보관됩니다.
2. **중앙 집중화:** 여러 대의 PDA나 모바일 기기에서 동시에 스캔 작업을 진행하고 하나의 DB로 데이터를 모을 수 있습니다.
3. **보안:** 이메일 발송 로직이 프론트엔드(EmailJS)에서 백엔드(Nodemailer)로 이동하여 보안이 강화됩니다.
