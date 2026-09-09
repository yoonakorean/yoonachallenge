import { AuthService } from './services/auth.js';
import { FirestoreService } from './services/firebase.js';

let authMode = 'login';
let currentCategory = 'korean';
let currentSelectedLevel = '1A';
let currentSelectedUnit = 1;      // 問題十：統一為 Number
let currentSelectedStage = 1;
let currentUserData = null;
let currentCalendarDate = new Date();
let currentUid = null;

// 權限來源（依 Memberships 判斷，供所有程度切換入口共用）
let currentMemberships = [];
let currentAllowedCourseIds = [];

// 好友系統即時狀態
let currentPendingRequests = [];
let currentFriendUids = [];
let pendingUnsub = null;
let friendsUnsub = null;

// 問題五：統一預設頭像網址（無 Google 頭像／Email 註冊時使用）
const DEFAULT_AVATAR_URL = 'https://lh3.googleusercontent.com/a/default-user';

/* =========================================================
 * 多語系語言清單（可擴充，不寫死在畫面上）
 * 新增語言：這裡加一筆＋Sheets 對應表格加一個 _語言代碼 欄位即可
 * ========================================================= */
const LANGUAGE_REGISTRY = [
    { code: 'zh', label: '中文' },
    { code: 'en', label: 'English' }
];
const DEFAULT_LANGUAGE = 'zh';

// 取某個欄位在目前使用者母語下的翻譯內容；該語言沒填則退回中文，避免開天窗
function tr(row, baseField, langCode) {
    if (!row) return '';
    const lang = langCode || DEFAULT_LANGUAGE;
    return row[`${baseField}_${lang}`] || row[`${baseField}_${DEFAULT_LANGUAGE}`] || '';
}
function getCurrentLanguage() {
    return (currentUserData && currentUserData.nativeLanguage) || DEFAULT_LANGUAGE;
}

/* =========================================================
 * Google Sheets 資料來源（直接讀取真實網址，不使用內建備援資料）
 * ========================================================= */
const SHEET_NAMES = {
    courseMap:        'CourseMap',
    stageMap:         'StageMap',
    vocabulary:       'Vocabulary',
    grammarPoints:    'GrammarPoints',
    grammarRules:     'GrammarRules',
    speakingQa:       'SpeakingQA',
    unitKeySentences: 'UnitKeySentences'
};

// 課程內容 GAS 代理網址（見 CourseContentProxy.gs 的部署說明）。
// 部署後把拿到的網址（結尾 /exec）貼在這裡，其餘程式碼不需要更動。
const GAS_SHEETS_PROXY_URL = 'https://script.google.com/macros/s/AKfycby--0EkUk1MSaYd_jmFg8Z4XZ6qB16cOf6tZw3ilO0EEBthHf5I7AJA8DHJBjYJu-tD/exec';

// 讀取診斷紀錄：每張表的讀取結果都會留一筆，畫面上會把有問題的表清楚列出來
const sheetLoadDiagnostics = {};

async function fetchSheetRows(sheetName, sheetLabel) {
    if (!GAS_SHEETS_PROXY_URL) {
        sheetLoadDiagnostics[sheetLabel] = { ok: false, reason: '尚未設定 GAS_SHEETS_PROXY_URL（請先部署 CourseContentProxy.gs 並填入網址）' };
        return null;
    }
    const url = `${GAS_SHEETS_PROXY_URL}?sheet=${encodeURIComponent(sheetName)}`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            sheetLoadDiagnostics[sheetLabel] = { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
            return null;
        }
        let data;
        try {
            data = await res.json();
        } catch (parseErr) {
            sheetLoadDiagnostics[sheetLabel] = { ok: false, reason: `JSON 解析失敗：${parseErr.message}` };
            return null;
        }
        if (data && data.error) {
            sheetLoadDiagnostics[sheetLabel] = { ok: false, reason: data.error };
            return null;
        }
        sheetLoadDiagnostics[sheetLabel] = { ok: true, rowCount: Array.isArray(data) ? data.length : 0 };
        return Array.isArray(data) ? data : [];
    } catch (err) {
        // fetch 本身失敗：常見成因是 GAS 網址無效、或網路完全連不上（GAS 代理本身不會有 CORS/登入導轉問題）
        sheetLoadDiagnostics[sheetLabel] = { ok: false, reason: `讀取發生錯誤：${err.message}` };
        return null;
    }
}

function renderSheetDiagnosticsBanner() {
    const failed = Object.entries(sheetLoadDiagnostics).filter(([, v]) => !v.ok);
    if (!failed.length) return '';
    return `
        <div style="background:#fdf0f0; border:1px solid #f5c2c2; border-radius:12px; padding:14px; margin-bottom:16px; text-align:left;">
            <div style="font-weight:800; color:var(--duo-red); margin-bottom:6px;"><i class="fa-solid fa-triangle-exclamation"></i> Google Sheets 讀取診斷</div>
            ${failed.map(([label, v]) => `<div style="font-size:0.82rem; color:#7a2e2e; margin-top:4px;">・${label}：${v.reason}</div>`).join('')}
        </div>
    `;
}

/* =========================================================
 * 六種關卡類型，固定順序＋圖示（可擴充：StageMap 沒填的關卡不會顯示）
 * ========================================================= */
const ACTIVITY_REGISTRY = [
    { activityId: 'warmup',   icon: 'fa-compass',    displayName: '課程暖身' },
    { activityId: 'shadow',   icon: 'fa-headset',    displayName: '句子跟讀' },
    { activityId: 'chunk',    icon: 'fa-dumbbell',   displayName: '字塊' },
    { activityId: 'speaking', icon: 'fa-microphone', displayName: '口說' },
    { activityId: 'dialogue', icon: 'fa-comments',   displayName: '對話' },
    { activityId: 'challenge',icon: 'fa-trophy',     displayName: '綜合挑戰' }
];
const PASS_THRESHOLD = 0.8; // 統一 80% 過關門檻

let courseMapRows = null, stageMapRows = null, vocabularyRows = null;
let grammarPointsRows = null, grammarRulesRows = null, speakingQaRows = null, unitKeySentencesRows = null;
let sheetDataLoaded = false;

async function loadAllSheetData() {
    if (sheetDataLoaded) return;
    const [cm, sm, vb, gp, gr, sq, ks] = await Promise.all([
        fetchSheetRows(SHEET_NAMES.courseMap, 'CourseMap'),
        fetchSheetRows(SHEET_NAMES.stageMap, 'StageMap'),
        fetchSheetRows(SHEET_NAMES.vocabulary, 'Vocabulary'),
        fetchSheetRows(SHEET_NAMES.grammarPoints, 'GrammarPoints'),
        fetchSheetRows(SHEET_NAMES.grammarRules, 'GrammarRules'),
        fetchSheetRows(SHEET_NAMES.speakingQa, 'SpeakingQA'),
        fetchSheetRows(SHEET_NAMES.unitKeySentences, 'UnitKeySentences')
    ]);
    courseMapRows = cm; stageMapRows = sm; vocabularyRows = vb;
    grammarPointsRows = gp; grammarRulesRows = gr; speakingQaRows = sq; unitKeySentencesRows = ks;
    sheetDataLoaded = true;
}

function trailingNumber(id) {
    const m = String(id || '').match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
}

/* =========================================================
 * Members/{uid}/lessonProgress/{lessonId} 記憶體快取
 * ========================================================= */
let lessonProgressCache = {};

async function loadLessonProgressFor(lessonIds) {
    if (!currentUid) return;
    await Promise.all(lessonIds.map(async (lid) => {
        if (lessonProgressCache[lid]) return;
        const data = await FirestoreService.getLessonProgress(currentUid, lid);
        lessonProgressCache[lid] = data || { activities: {} };
    }));
}

function getActivitiesForLesson(lessonId) {
    const stagesForLesson = (stageMapRows || []).filter(r => r.lessonId === lessonId);
    const activeTypes = new Set(stagesForLesson.map(r => r.activityType));
    return ACTIVITY_REGISTRY.filter(a => activeTypes.has(a.activityId));
}

function getActivityStatus(lessonId, activityId, isFirstInLesson) {
    const saved = lessonProgressCache[lessonId]?.activities?.[activityId]?.status;
    if (saved) return saved;
    return isFirstInLesson ? 'available' : 'locked';
}

// 完成一個 Activity：記錄結果、依 Registry 順序解鎖下一個已設定的 Activity
async function completeActivity(lessonId, activityId, passed, correctCount, totalCount) {
    if (!lessonProgressCache[lessonId]) lessonProgressCache[lessonId] = { activities: {} };
    const activities = { ...(lessonProgressCache[lessonId].activities || {}) };
    activities[activityId] = {
        status: passed ? 'completed' : 'needs_review',
        correctCount, totalCount,
        lastAttemptAt: new Date().toISOString()
    };

    const orderedActive = getActivitiesForLesson(lessonId);
    const idx = orderedActive.findIndex(a => a.activityId === activityId);
    if (idx >= 0 && idx < orderedActive.length - 1) {
        const nextId = orderedActive[idx + 1].activityId;
        if (!activities[nextId] || activities[nextId].status === 'locked') {
            activities[nextId] = { ...(activities[nextId] || {}), status: 'available' };
        }
    }
    lessonProgressCache[lessonId].activities = activities;
    if (currentUid) await FirestoreService.saveLessonProgress(currentUid, lessonId, activities);
}

/* =========================================================
 * 語音（TTS 播放 + 語音辨識判定），從 Learning Lab 已驗證的邏輯移植
 * ========================================================= */
let cachedFemaleVoiceApp = null;
function pickFemaleKoreanVoiceApp() {
    if (cachedFemaleVoiceApp) return cachedFemaleVoiceApp;
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    const krVoices = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith('ko'));
    cachedFemaleVoiceApp = krVoices.find(v => /female|여성|yuna|여자/i.test(v.name)) || krVoices[0] || null;
    return cachedFemaleVoiceApp;
}
function speakKoreanApp(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ko-KR'; utter.rate = 0.92; utter.pitch = 1.05;
    const v = pickFemaleKoreanVoiceApp();
    if (v) utter.voice = v;
    window.speechSynthesis.speak(utter);
}
if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => { cachedFemaleVoiceApp = null; };
}
const SpeechRecognitionCtorApp = window.SpeechRecognition || window.webkitSpeechRecognition;
function normalizeKrApp(s) { return String(s || '').replace(/\s+/g, '').replace(/[.,!?~]/g, ''); }
function judgeKoreanAnswerApp(spoken, target) {
    const s = normalizeKrApp(spoken), t = normalizeKrApp(target);
    if (!s) return false;
    return s === t || s.includes(t) || t.includes(s);
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 📦 問題十：learningProgress 模組（新增）
 * 不新增 Firestore 欄位，僅包裝現有 Members 欄位
 * lastCourseId / lastLevel / lastLesson / lastUnit / lastStage
 */
const learningProgress = {
    get(member) {
        return {
            lastCourseId: member?.lastCourseId || null,
            lastLevel: member?.lastLevel || null,
            lastLesson: member?.lastLesson || null,
            lastUnit: Number(member?.lastUnit) || 1,
            lastStage: Number(member?.lastStage) || 1
        };
    },
    async save(uid, patch) {
        if (!uid) return;
        try {
            await FirestoreService.updateMember(uid, { ...patch, updatedAt: new Date().toISOString().split('T')[0] });
        } catch (err) {
            console.error('儲存學習進度失敗:', err);
        }
    }
};

/**
 * 📱 3. 計算與更新連續登入天數 (Streak)
 * 問題十一：不使用 Math.abs；若 diffDays < 0（裝置時間異常），
 * 不更新 Streak、不新增打卡、不更新 Firestore（由呼叫端略過寫入）。
 */
function checkAndUpdateStreak(userData) {
    const today = new Date().toISOString().split('T')[0];
    const streak = userData.streak || 1;
    const lastLogin = userData.lastLoginDate || '';

    if (!lastLogin) {
        return { streak, lastLoginDate: today, anomalous: false };
    }

    const lastDate = new Date(lastLogin);
    const currentDate = new Date(today);
    const diffTime = currentDate - lastDate; // 不取絕對值
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
        console.warn('偵測到裝置時間異常（本機時間早於上次登入紀錄），本次不更新 Streak');
        return { streak, lastLoginDate: lastLogin, anomalous: true };
    }

    let newStreak = streak;
    if (diffDays === 1) {
        newStreak = streak + 1; // 連續登入加 1 天
    } else if (diffDays > 1) {
        newStreak = 1; // 中斷則重置為 1 天
    }
    // diffDays === 0：當日已打卡過，維持不變

    return { streak: newStreak, lastLoginDate: today, anomalous: false };
}

/**
 * 🗺️ 動態渲染學習地圖
 */
function shuffleApp(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// 目前正在畫面上顯示的 Unit（首頁地圖一次只顯示一個 Unit）
let currentDisplayedUnitId = null;

async function renderMapUnits(category, level) {
    const container = document.getElementById('units-map-list');
    if (!container) return;
    container.innerHTML = `<p style="text-align:center;color:#9ca3af;padding:24px;">課程載入中...</p>`;

    await loadAllSheetData();

    const diagBanner = renderSheetDiagnosticsBanner();
    if (!courseMapRows || !stageMapRows) {
        container.innerHTML = diagBanner || `<p style="text-align:center;color:var(--duo-red);padding:20px;">課程地圖資料讀取失敗。</p>`;
        return;
    }

    const lessonsForCourse = courseMapRows.filter(r => r.courseId === level);
    if (!lessonsForCourse.length) {
        container.innerHTML = diagBanner + `<p style="text-align:center;color:#9ca3af;padding:20px;">目前 ${escapeHtml(level)} 尚未在 CourseMap 設定課程內容。</p>`;
        return;
    }

    await loadLessonProgressFor(lessonsForCourse.map(l => l.lessonId));

    // 決定要顯示哪個 Unit：優先顯示「最近一次有完成紀錄」的那個 Lesson 所屬的 Unit；全新學生顯示第一個 Unit
    if (!currentDisplayedUnitId) {
        let mostRecentLessonId = null, mostRecentTime = 0;
        Object.entries(lessonProgressCache).forEach(([lid, data]) => {
            Object.values(data.activities || {}).forEach(act => {
                if (act.lastAttemptAt) {
                    const t = new Date(act.lastAttemptAt).getTime();
                    if (t > mostRecentTime) { mostRecentTime = t; mostRecentLessonId = lid; }
                }
            });
        });
        const matchedLesson = mostRecentLessonId ? lessonsForCourse.find(l => l.lessonId === mostRecentLessonId) : null;
        const sortedUnitIds = [...new Set(lessonsForCourse.map(l => l.unitId))].sort((a, b) => trailingNumber(a) - trailingNumber(b));
        currentDisplayedUnitId = matchedLesson ? matchedLesson.unitId : sortedUnitIds[0];
    }

    renderHomeMapForUnit(currentDisplayedUnitId, lessonsForCourse, diagBanner);
}

function renderHomeMapForUnit(unitId, lessonsForCourse, diagBanner) {
    const container = document.getElementById('units-map-list');
    if (!container) return;

    const lessonsInUnit = lessonsForCourse.filter(l => l.unitId === unitId).sort((a, b) => trailingNumber(a.lessonId) - trailingNumber(b.lessonId));
    const unitTitle = tr(lessonsInUnit[0] || {}, 'unitTitle', getCurrentLanguage());
    const unitNumber = trailingNumber(unitId);

    container.innerHTML = `
        ${diagBanner || ''}
        <button class="unit-header-bar" id="btn-open-unit-overview">
            <span class="unit-header-title">第 ${unitNumber} 單元： ${escapeHtml(unitTitle)}</span>
        </button>
        <button class="unit-header-list-btn" id="btn-open-key-sentences" style="position:relative; top:-58px; float:right; margin-right:4px;">
            <i class="fa-solid fa-list"></i>
        </button>
        <div style="clear:both;"></div>
        ${lessonsInUnit.map(lesson => renderLessonBlock(lesson)).join('')}
    `;

    document.getElementById('btn-open-unit-overview')?.addEventListener('click', () => openUnitOverview());
    document.getElementById('btn-open-key-sentences')?.addEventListener('click', () => openUnitKeySentences(unitId));
    bindActivityButtons();
}

function renderLessonBlock(lesson) {
    const activities = getActivitiesForLesson(lesson.lessonId);
    const lessonTitle = tr(lesson, 'lessonTitle', getCurrentLanguage()) || lesson.lessonTitle;

    if (!activities.length) {
        return `
            <div class="lesson-divider">${escapeHtml(lessonTitle)}</div>
            <p style="text-align:center;color:#9ca3af;font-size:0.82rem;">此課尚未在 StageMap 設定任何關卡</p>
        `;
    }

    const nodesHtml = activities.map((act, idx) => {
        const status = getActivityStatus(lesson.lessonId, act.activityId, idx === 0);
        const locked = status === 'locked';
        return `
            <button class="activity-node status-${status}" data-lesson="${escapeHtml(lesson.lessonId)}" data-activity="${act.activityId}" ${locked ? 'disabled' : ''} title="${escapeHtml(act.displayName)}">
                <i class="fa-solid ${act.icon}"></i>
                ${status === 'completed' ? '<span class="activity-badge"><i class="fa-solid fa-check"></i></span>' : ''}
                ${status === 'needs_review' ? '<span class="activity-badge">!</span>' : ''}
            </button>
        `;
    }).join('');

    return `
        <div class="lesson-divider">${escapeHtml(lessonTitle)}</div>
        <div class="activity-column">${nodesHtml}</div>
    `;
}

function bindActivityButtons() {
    document.querySelectorAll('.activity-node').forEach(btn => {
        btn.addEventListener('click', () => {
            const lessonId = btn.getAttribute('data-lesson');
            const activityId = btn.getAttribute('data-activity');
            openActivity(lessonId, activityId);
        });
    });
}

/* =========================================================
 * 📚 單元總覽：所有 Unit 清單＋完成進度條
 * ========================================================= */
function openUnitOverview() {
    const mapView = document.getElementById('map-view');
    const overviewView = document.getElementById('unit-overview-view');
    mapView?.classList.add('hidden');
    overviewView?.classList.remove('hidden');

    const lessonsForCourse = (courseMapRows || []).filter(r => r.courseId === currentSelectedLevel);
    const unitMap = {};
    lessonsForCourse.forEach(row => {
        if (!unitMap[row.unitId]) unitMap[row.unitId] = { unitId: row.unitId, unitTitle: tr(row, 'unitTitle', getCurrentLanguage()), lessons: [] };
        unitMap[row.unitId].lessons.push(row);
    });
    const units = Object.values(unitMap).sort((a, b) => trailingNumber(a.unitId) - trailingNumber(b.unitId));

    const listEl = document.getElementById('unit-overview-list');
    if (!listEl) return;
    listEl.innerHTML = units.map(unit => {
        let totalActs = 0, doneActs = 0;
        unit.lessons.forEach(lesson => {
            const acts = getActivitiesForLesson(lesson.lessonId);
            totalActs += acts.length;
            acts.forEach(act => {
                const status = getActivityStatus(lesson.lessonId, act.activityId, acts.indexOf(act) === 0);
                if (status === 'completed') doneActs++;
            });
        });
        const pct = totalActs ? Math.round((doneActs / totalActs) * 100) : 0;
        return `
            <button class="unit-overview-card" data-unit-jump="${escapeHtml(unit.unitId)}">
                <div class="unit-overview-title">第 ${trailingNumber(unit.unitId)} 單元：${escapeHtml(unit.unitTitle)}</div>
                <div class="unit-overview-progress-track"><div class="unit-overview-progress-fill" style="width:${pct}%;"></div></div>
            </button>
        `;
    }).join('');

    listEl.querySelectorAll('[data-unit-jump]').forEach(card => {
        card.addEventListener('click', () => {
            currentDisplayedUnitId = card.getAttribute('data-unit-jump');
            overviewView?.classList.add('hidden');
            mapView?.classList.remove('hidden');
            renderMapUnits(currentCategory, currentSelectedLevel);
        });
    });
}
document.getElementById('btn-unit-overview-back')?.addEventListener('click', () => {
    document.getElementById('unit-overview-view')?.classList.add('hidden');
    document.getElementById('map-view')?.classList.remove('hidden');
});

/* =========================================================
 * 📖 單元句型頁面：重點語句（唯讀預覽）
 * ========================================================= */
function openUnitKeySentences(unitId) {
    const mapView = document.getElementById('map-view');
    const ksView = document.getElementById('unit-key-sentences-view');
    mapView?.classList.add('hidden');
    ksView?.classList.remove('hidden');

    const listEl = document.getElementById('unit-key-sentences-list');
    if (!listEl) return;

    if (!unitKeySentencesRows) {
        listEl.innerHTML = `<p style="text-align:center;color:#9ca3af;padding:20px;">尚未設定重點語句資料來源（UnitKeySentences 網址還沒串接）。</p>`;
        return;
    }
    const rows = unitKeySentencesRows.filter(r => r.unitId === unitId);
    if (!rows.length) {
        listEl.innerHTML = `<p style="text-align:center;color:#9ca3af;padding:20px;">這個單元尚未設定重點語句。</p>`;
        return;
    }
    listEl.innerHTML = rows.map((r, idx) => `
        <div class="key-sentence-bubble-row ${idx % 2 === 1 ? 'align-right' : ''}">
            <div class="key-sentence-bubble">
                <div class="ks-kr"><button class="mini-play-btn" data-speak="${escapeHtml(r.kr)}" style="border:none;background:none;color:var(--duo-blue);"><i class="fa-solid fa-volume-high"></i></button> ${escapeHtml(r.kr)}</div>
                <div class="ks-tr">${escapeHtml(tr(r, 'translation', getCurrentLanguage()))}</div>
            </div>
        </div>
    `).join('');
    listEl.querySelectorAll('[data-speak]').forEach(btn => {
        btn.addEventListener('click', () => speakKoreanApp(btn.getAttribute('data-speak')));
    });
}
document.getElementById('btn-key-sentences-back')?.addEventListener('click', () => {
    document.getElementById('unit-key-sentences-view')?.classList.add('hidden');
    document.getElementById('map-view')?.classList.remove('hidden');
});

/* =========================================================
 * Activity 派送器：目前只有「課程暖身」真正實作，其餘關卡先顯示誠實的「尚未開放」
 * ========================================================= */
async function openActivity(lessonId, activityId) {
    const mapView = document.getElementById('map-view');
    const gameView = document.getElementById('game-view');
    const content = document.getElementById('activity-player-content');
    if (!content) return;

    mapView?.classList.add('hidden');
    gameView?.classList.remove('hidden');

    if (activityId === 'warmup') {
        await runWarmupActivity(lessonId, content);
    } else {
        const activityMeta = ACTIVITY_REGISTRY.find(a => a.activityId === activityId);
        content.innerHTML = `
            <div class="unit-card" style="text-align:center;">
                <div style="font-size:2rem;color:var(--duo-blue);margin-bottom:10px;"><i class="fa-solid fa-hammer"></i></div>
                <h3 style="margin:0 0 8px;color:#1f2937;">「${escapeHtml(activityMeta?.displayName || '')}」尚未開放</h3>
                <p style="font-size:0.85rem;color:#6b7280;">這個關卡類型還在建置中，敬請期待。</p>
            </div>
        `;
    }
}

/* =========================================================
 * 📖 課程暖身：單字 + 句型規則 + 8 題隨機口說測驗（80% 過關）
 * ========================================================= */
let warmupQuizState = { queue: [], total: 0, correct: 0, current: null };
let warmupRecognizer = null, warmupListening = false, warmupListenTimeout = null;

async function runWarmupActivity(lessonId, content) {
    const lang = getCurrentLanguage();
    const words = (vocabularyRows || []).filter(r => r.lessonId === lessonId);
    const points = (grammarPointsRows || []).filter(r => r.lessonId === lessonId);
    const rules = (grammarRulesRows || []).filter(r => r.lessonId === lessonId);
    const qaPool = (speakingQaRows || []).filter(r => r.lessonId === lessonId && (r.stageId === 'warmup' || !r.stageId));

    const missing = [];
    if (!vocabularyRows) missing.push('Vocabulary');
    if (!grammarPointsRows) missing.push('GrammarPoints');
    if (!grammarRulesRows) missing.push('GrammarRules');
    if (!speakingQaRows) missing.push('SpeakingQA');

    content.innerHTML = `
        ${renderSheetDiagnosticsBanner()}
        <div class="unit-card">
            <h3 style="margin:0 0 12px;color:#1f2937;"><i class="fa-solid fa-book-open" style="color:var(--duo-blue);"></i> 單字</h3>
            <div id="warmup-vocab-list" style="display:flex;flex-direction:column;gap:8px;"></div>
        </div>
        <div class="unit-card" style="margin-top:14px;">
            <h3 style="margin:0 0 12px;color:#1f2937;"><i class="fa-solid fa-diagram-project" style="color:var(--duo-blue);"></i> 句型規則</h3>
            <div id="warmup-grammar-block"></div>
        </div>
        <button class="btn-3d btn-3d-primary" id="btn-start-warmup-quiz" style="width:100%;padding:14px;margin-top:16px;">
            <i class="fa-solid fa-microphone"></i> 開始暖身測驗（隨機 8 題）
        </button>
        <div id="warmup-quiz-zone" style="margin-top:16px;"></div>
    `;

    // 單字清單
    const vocabList = document.getElementById('warmup-vocab-list');
    if (words.length) {
        vocabList.innerHTML = words.map(w => `
            <button class="btn-3d btn-3d-secondary" data-speak="${escapeHtml(w.kr)}" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;text-align:left;">
                <span><b style="font-size:1.05rem;">${escapeHtml(w.kr_pron || w.kr)}</b> <span style="color:#9ca3af;font-size:0.8rem;">(${escapeHtml(w.pos || '')})</span></span>
                <span style="display:flex;align-items:center;gap:8px;">
                    <span style="color:#6b7280;font-size:0.85rem;">${escapeHtml(tr(w, 'meaning', lang))}</span>
                    <i class="fa-solid fa-volume-high" style="color:var(--duo-blue);"></i>
                </span>
            </button>
        `).join('');
        vocabList.querySelectorAll('[data-speak]').forEach(btn => {
            btn.addEventListener('click', () => speakKoreanApp(btn.getAttribute('data-speak')));
        });
    } else {
        vocabList.innerHTML = `<p style="color:#9ca3af;font-size:0.85rem;">這一課尚未在 Vocabulary 設定單字。</p>`;
    }

    // 句型規則 + 例句
    const grammarBlock = document.getElementById('warmup-grammar-block');
    let grammarHtml = '';
    if (points.length) {
        grammarHtml += `<p style="color:#4b5563;font-size:0.9rem;line-height:1.7;margin-bottom:14px;">${escapeHtml(tr(points[0], 'description', lang))}</p>`;
    }
    if (rules.length) {
        grammarHtml += rules.map(r => `
            <div style="background:#f9fafb;border-radius:12px;padding:10px 14px;margin-bottom:8px;">
                <div style="font-weight:800;color:#1f2937;">${escapeHtml(tr(r, 'conditionLabel', lang))}</div>
                <div style="color:#9ca3af;font-size:0.8rem;margin-top:4px;">${escapeHtml(r.samples || '')}</div>
            </div>
        `).join('');
    }
    grammarBlock.innerHTML = grammarHtml || `<p style="color:#9ca3af;font-size:0.85rem;">這一課尚未在 GrammarPoints／GrammarRules 設定句型內容。</p>`;

    // 開始測驗
    document.getElementById('btn-start-warmup-quiz')?.addEventListener('click', () => {
        if (!qaPool.length) {
            alert('這一課尚未在 SpeakingQA 設定暖身測驗題目，無法開始。');
            return;
        }
        startWarmupQuiz(lessonId, qaPool);
    });
}

function startWarmupQuiz(lessonId, qaPool) {
    const picked = shuffleApp(qaPool).slice(0, Math.min(8, qaPool.length));
    warmupQuizState = { queue: picked, total: picked.length, correct: 0, current: null, lessonId };
    showWarmupQuizQuestion();
}

function showWarmupQuizQuestion() {
    const zone = document.getElementById('warmup-quiz-zone');
    if (!zone) return;

    if (!warmupQuizState.queue.length) {
        finishWarmupQuiz();
        return;
    }
    const qa = warmupQuizState.queue[0];
    warmupQuizState.current = qa;
    const questionText = qa.question || qa.questionA || '';

    zone.innerHTML = `
        <div class="unit-card" style="text-align:center;">
            <div style="font-size:0.8rem;color:#9ca3af;margin-bottom:8px;">第 ${warmupQuizState.total - warmupQuizState.queue.length + 1} / ${warmupQuizState.total} 題</div>
            <button class="btn-3d btn-3d-secondary" id="btn-warmup-quiz-play" style="padding:12px 24px;"><i class="fa-solid fa-volume-high"></i> 播放題目</button>
            <button class="btn-3d btn-3d-primary" id="btn-warmup-quiz-mic" style="width:76px;height:76px;border-radius:50%;margin:18px auto 8px;display:flex;align-items:center;justify-content:center;font-size:1.3rem;"><i class="fa-solid fa-microphone"></i></button>
            <p style="font-size:0.82rem;color:#6b7280;" id="warmup-quiz-mic-label">先播放題目，再按麥克風回答</p>
            <div id="warmup-quiz-feedback" style="margin-top:10px;font-weight:800;"></div>
        </div>
    `;
    if (!questionText) {
        zone.innerHTML += `<p style="text-align:center;color:var(--duo-red);font-size:0.82rem;margin-top:8px;">這一題在 SpeakingQA 沒有設定「question」題目欄位，無法播放語音。</p>`;
    }
    document.getElementById('btn-warmup-quiz-play')?.addEventListener('click', () => { if (questionText) speakKoreanApp(questionText); });
    document.getElementById('btn-warmup-quiz-mic')?.addEventListener('click', handleWarmupQuizMicClick);
}

function handleWarmupQuizMicClick() {
    if (warmupListening) return;
    const qa = warmupQuizState.current;
    if (!qa) return;

    if (!SpeechRecognitionCtorApp) {
        const ok = confirm(`（此瀏覽器不支援自動語音辨識）\n請回答「${qa.answerB}」，說出來了嗎？`);
        handleWarmupQuizResult(ok);
        return;
    }
    let recognizer;
    try { recognizer = new SpeechRecognitionCtorApp(); } catch (e) { alert('語音辨識初始化失敗，請重新整理頁面再試一次。'); return; }
    warmupRecognizer = recognizer;
    recognizer.lang = 'ko-KR'; recognizer.interimResults = false; recognizer.maxAlternatives = 3;
    warmupListening = true;
    const micBtn = document.getElementById('btn-warmup-quiz-mic');
    const micLabel = document.getElementById('warmup-quiz-mic-label');
    micBtn?.classList.add('recording');
    if (micLabel) micLabel.innerText = '聽你說...';

    const finish = (correct) => {
        clearTimeout(warmupListenTimeout);
        warmupListening = false;
        micBtn?.classList.remove('recording');
        handleWarmupQuizResult(correct);
    };
    warmupListenTimeout = setTimeout(() => {
        if (!warmupListening) return;
        try { recognizer.stop(); } catch (e) {}
        warmupListening = false;
        micBtn?.classList.remove('recording');
        if (micLabel) micLabel.innerText = '沒聽清楚，再按一次試試';
    }, 6000);

    recognizer.onresult = (event) => {
        const alts = Array.from(event.results[0]).map(r => r.transcript);
        finish(alts.some(a => judgeKoreanAnswerApp(a, qa.answerB)));
    };
    recognizer.onerror = () => {
        clearTimeout(warmupListenTimeout);
        warmupListening = false;
        micBtn?.classList.remove('recording');
        if (micLabel) micLabel.innerText = '沒聽清楚，再按一次試試';
    };
    recognizer.onend = () => { warmupListening = false; micBtn?.classList.remove('recording'); };
    try { recognizer.start(); } catch (e) { finish(false); }
}

function handleWarmupQuizResult(correct) {
    if (correct) warmupQuizState.correct++;
    const fb = document.getElementById('warmup-quiz-feedback');
    if (fb) {
        fb.style.color = correct ? 'var(--duo-green)' : 'var(--duo-red)';
        fb.innerText = correct ? '答對了！' : `再聽一次：${warmupQuizState.current.answerB}`;
    }
    if (!correct) speakKoreanApp(warmupQuizState.current.answerB);
    warmupQuizState.queue.shift();
    setTimeout(showWarmupQuizQuestion, 1200);
}

async function finishWarmupQuiz() {
    const zone = document.getElementById('warmup-quiz-zone');
    const percent = warmupQuizState.total ? Math.round((warmupQuizState.correct / warmupQuizState.total) * 100) : 0;
    const passed = warmupQuizState.total > 0 && (warmupQuizState.correct / warmupQuizState.total) >= PASS_THRESHOLD;

    await completeActivity(warmupQuizState.lessonId, 'warmup', passed, warmupQuizState.correct, warmupQuizState.total);

    if (zone) {
        zone.innerHTML = `
            <div class="unit-card" style="text-align:center;">
                <div style="font-size:2.2rem;color:${passed ? 'var(--duo-gold)' : '#9ca3af'};margin-bottom:8px;">
                    <i class="fa-solid ${passed ? 'fa-trophy' : 'fa-rotate-right'}"></i>
                </div>
                <h3 style="margin:0 0 6px;color:#1f2937;">${passed ? '暖身完成！' : '再練習一次吧'}</h3>
                <p style="color:#6b7280;font-size:0.9rem;">答對 ${warmupQuizState.correct}/${warmupQuizState.total}（${percent}%）${passed ? '，已通過 80% 門檻' : '，需達 80% 以上才算過關'}</p>
                <button class="btn-3d btn-3d-primary" id="btn-warmup-back-to-map" style="width:100%;padding:12px;margin-top:14px;">返回地圖</button>
            </div>
        `;
        document.getElementById('btn-warmup-back-to-map')?.addEventListener('click', () => {
            document.getElementById('game-view')?.classList.add('hidden');
            document.getElementById('map-view')?.classList.remove('hidden');
            renderMapUnits(currentCategory, currentSelectedLevel);
        });
    }
}

function updateUIProfile(data) {
    currentUserData = data;

    // 更新頂部 Bar
    const lblUsername = document.getElementById('lbl-username');
    if (lblUsername) lblUsername.innerText = data.nickname || '學生';

    const lblLoginDays = document.getElementById('lbl-login-days');
    if (lblLoginDays) lblLoginDays.innerText = data.streak || 1;

    const lblDashStreak = document.getElementById('dash-streak-days');
    if (lblDashStreak) lblDashStreak.innerText = data.streak || 1;

    const lblFocusHours = document.getElementById('dash-focus-hours');
    if (lblFocusHours) lblFocusHours.innerText = (data.focusHours || 0.0).toFixed(1);

    const lblUserLevel = document.getElementById('lbl-user-level');
    if (lblUserLevel) lblUserLevel.innerText = currentSelectedLevel || data.lastLevel || '1A';

    const lblCoins = document.getElementById('lbl-coins');
    if (lblCoins) lblCoins.innerText = data.coins || 0;

    const lblXp = document.getElementById('lbl-xp');
    if (lblXp) lblXp.innerText = data.xp || 0;

    const lblEnergy = document.getElementById('lbl-energy');
    if (lblEnergy) lblEnergy.innerText = data.energy !== undefined ? data.energy : 100;

    // 問題七：個人資料頁 — 只顯示 暱稱／Email／已開通程度／到期日／Energy／XP／Streak
    const profAvatar = document.getElementById('profile-user-avatar');
    if (profAvatar) profAvatar.src = data.photoURL || DEFAULT_AVATAR_URL;

    const profNick = document.getElementById('profile-nickname');
    if (profNick) profNick.innerText = data.nickname || '學生';

    const profEmail = document.getElementById('profile-email');
    if (profEmail) profEmail.innerText = data.email || '';

    // 不顯示 realName / role / status：保留元素與 id，僅隱藏該列（不刪除 HTML）
    document.getElementById('profile-realname')?.closest('div')?.classList.add('hidden');
    document.getElementById('profile-role')?.closest('div')?.classList.add('hidden');
    document.getElementById('profile-status')?.closest('div')?.classList.add('hidden');

    // 已開通程度／到期日：全部列出（資料來源 Memberships，不新增資料結構）
    const membershipsList = document.getElementById('profile-memberships-list');
    if (membershipsList) {
        if (!currentMemberships.length) {
            membershipsList.innerHTML = `<span style="font-size:0.82rem;color:#9ca3af;">目前尚無已開通課程</span>`;
        } else {
            membershipsList.innerHTML = currentMemberships.map(m => `
                <span class="course-badge-pill">${escapeHtml(m.courseId)}｜到期日 ${escapeHtml(m.expireDate || '未定')}${m.status !== 'active' ? '（已停用）' : ''}</span>
            `).join('');
        }
    }

    // 新增：剩餘能量 (Energy) 顯示列（沿用 Users 舊集合欄位，僅新增顯示元素，不新增資料結構）
    let profEnergyRow = document.getElementById('profile-energy-row');
    if (!profEnergyRow) {
        const anchor = document.getElementById('profile-xp')?.closest('div');
        if (anchor && anchor.parentNode) {
            profEnergyRow = document.createElement('div');
            profEnergyRow.id = 'profile-energy-row';
            profEnergyRow.style.cssText = 'display:flex;justify-content:space-between;font-size:0.9rem;';
            profEnergyRow.innerHTML = `<span style="color:#6b7280;">剩餘能量：</span><span style="color:var(--duo-lightning);font-weight:bold;"><i class="fa-solid fa-bolt-lightning"></i> <span id="profile-energy">100</span></span>`;
            anchor.parentNode.insertBefore(profEnergyRow, anchor);
        }
    }
    const profEnergy = document.getElementById('profile-energy');
    if (profEnergy) profEnergy.innerText = data.energy !== undefined ? data.energy : 100;

    const profXp = document.getElementById('profile-xp');
    if (profXp) profXp.innerText = data.xp || 0;

    const profStreak = document.getElementById('profile-streak');
    if (profStreak) profStreak.innerText = data.streak || 1;

    // 舊版程度選單（目前 HTML 無此元素，保留相容、不影響其他功能）
    const levelSelect = document.getElementById('select-level-course');
    if (levelSelect) levelSelect.value = currentSelectedLevel || '1A';

    const lvlLbl = document.getElementById('lbl-global-rank-level');
    if (lvlLbl) lvlLbl.innerText = currentSelectedLevel || '1A'; // 僅為資訊顯示，不作為排行榜篩選條件
}

/**
 * 📅 渲染簽到月曆 (Dashboard)
 */
function renderCalendar(date) {
    const calendarDaysContainer = document.getElementById('calendar-days-container');
    if (!calendarDaysContainer) return;
    calendarDaysContainer.innerHTML = '';

    const year = date.getFullYear();
    const month = date.getMonth();

    const titleLbl = document.getElementById('lbl-calendar-month-title');
    if (titleLbl) titleLbl.textContent = `${year}年 ${month + 1}月`;

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
        const emptyCell = document.createElement('div');
        emptyCell.className = 'calendar-day empty';
        calendarDaysContainer.appendChild(emptyCell);
    }

    const attendance = currentUserData?.attendance || [];

    for (let day = 1; day <= daysInMonth; day++) {
        const dayCell = document.createElement('div');
        dayCell.className = 'calendar-day';
        dayCell.textContent = day;

        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (attendance.includes(dateStr)) {
            dayCell.classList.add('checked');
        }

        calendarDaysContainer.appendChild(dayCell);
    }
}

/**
 * 🔒 問題五：統一程度切換權限檢查（所有入口共用同一函式）
 * 已授權：切換程度、更新地圖、更新目前程度顯示
 * 未授權：不切換、保持原程度、關閉 Modal、顯示 modal-locked
 */
function tryApplyLevelSwitch(levelId, { closeModalEl } = {}) {
    const allowed = currentAllowedCourseIds.includes(levelId);

    if (allowed) {
        currentSelectedLevel = levelId;
        const lblUserLevel = document.getElementById('lbl-user-level');
        if (lblUserLevel) lblUserLevel.innerText = levelId;
        renderMapUnits(currentCategory, currentSelectedLevel);
        const lvlLbl = document.getElementById('lbl-global-rank-level');
        if (lvlLbl) lvlLbl.innerText = levelId;
        if (currentUid) learningProgress.save(currentUid, { lastLevel: levelId, lastCourseId: currentCategory });
        closeModalEl?.classList.add('hidden');
        return true;
    } else {
        closeModalEl?.classList.add('hidden');
        const msgLbl = document.getElementById('lbl-locked-msg');
        if (msgLbl) msgLbl.innerText = `您的帳號尚未開通「${levelId}」程度，如需開通請聯繫後台管理員！`;
        document.getElementById('modal-locked')?.classList.remove('hidden');
        return false; // 保持目前程度不變，不更新地圖／排行榜／其他資料
    }
}

/* =========================================================
 * 🏆 問題九：排行榜與好友系統
 * ========================================================= */
async function renderGlobalLeaderboard() {
    const container = document.getElementById('content-rank-global');
    if (!container) return;
    const list = await FirestoreService.getGlobalLeaderboard(50);

    if (!list.length) {
        container.innerHTML = `<p style="font-size: 0.9rem; color: #6b7280; margin: 0;">目前尚無排行榜資料</p>`;
        return;
    }

    // 排序：XP → Streak → 完成課程數（completedCourses 欄位若未來新增即可直接生效，目前保留介面）
    const sorted = [...list].sort((a, b) => {
        const xpDiff = (b.xp || 0) - (a.xp || 0);
        if (xpDiff !== 0) return xpDiff;
        const streakDiff = (b.streak || 0) - (a.streak || 0);
        if (streakDiff !== 0) return streakDiff;
        return (b.completedCourses || 0) - (a.completedCourses || 0);
    });

    container.innerHTML = sorted.map((m, idx) => `
        <div style="display:flex; align-items:center; gap:10px; padding:8px 4px; border-bottom:1px solid #f3f4f6; text-align:left;">
            <div style="width:22px; text-align:center; font-weight:bold; color:${idx < 3 ? 'var(--duo-gold)' : '#9ca3af'};">${idx + 1}</div>
            <img src="${m.photoURL || DEFAULT_AVATAR_URL}" style="width:36px; height:36px; border-radius:50%; object-fit:cover;" alt="">
            <div style="flex:1;">
                <div style="font-weight:bold; color:#374151; font-size:0.88rem;">${escapeHtml(m.nickname || '學生')}</div>
                <div style="font-size:0.72rem; color:#9ca3af;">${escapeHtml(m.lastLevel || '-')}</div>
            </div>
            <div style="text-align:right; font-size:0.76rem; color:#6b7280;">
                <div><i class="fa-solid fa-star" style="color: var(--duo-gold);"></i> ${m.xp || 0}</div>
                <div><i class="fa-solid fa-fire" style="color: var(--duo-fire-red);"></i> ${m.streak || 0} 天</div>
            </div>
        </div>
    `).join('');
}

async function renderFriendsLeaderboard() {
    const listContainer = document.getElementById('friends-list-container');
    if (!listContainer) return;

    if (!currentFriendUids.length) {
        listContainer.innerHTML = `<p style="font-size:0.85rem; color:#9ca3af; text-align:center; margin: 10px 0;">目前還沒有好友，快去新增吧！</p>`;
        return;
    }

    const members = await Promise.all(currentFriendUids.map(uid => FirestoreService.getMember(uid)));
    const valid = members.filter(Boolean).sort((a, b) => (b.xp || 0) - (a.xp || 0)); // 依 XP 由高到低（不顯示排名）

    listContainer.innerHTML = valid.map(m => `
        <div style="display:flex; align-items:center; gap:10px; padding:8px 4px; border-bottom:1px solid #f3f4f6; text-align:left;">
            <img src="${m.photoURL || DEFAULT_AVATAR_URL}" style="width:36px; height:36px; border-radius:50%; object-fit:cover;" alt="">
            <div style="flex:1;">
                <div style="font-weight:bold; color:#374151; font-size:0.88rem;">${escapeHtml(m.nickname || '學生')}</div>
                <div style="font-size:0.72rem; color:#9ca3af;">${escapeHtml(m.lastLevel || '-')}</div>
            </div>
            <div style="text-align:right; font-size:0.76rem; color:#6b7280;">
                <div><i class="fa-solid fa-star" style="color: var(--duo-gold);"></i> ${m.xp || 0}</div>
                <div><i class="fa-solid fa-fire" style="color: var(--duo-fire-red);"></i> ${m.streak || 0} 天</div>
            </div>
        </div>
    `).join('');
}

function renderPendingRequests() {
    const container = document.getElementById('pending-friend-requests-container');
    const badge = document.getElementById('profile-notif-badge');
    if (!container) return;

    if (!currentPendingRequests.length) {
        container.classList.add('hidden');
        container.innerHTML = '';
        badge?.classList.add('hidden');
        return;
    }

    badge?.classList.remove('hidden');
    container.classList.remove('hidden');
    container.innerHTML = currentPendingRequests.map(r => `
        <div class="friend-request-card">
            <span style="font-weight:bold; color:#374151;">${escapeHtml(r.fromNickname || r.fromEmail)} 想加你為好友</span>
            <div style="display:flex; gap:8px;">
                <button class="btn-3d btn-3d-primary" data-accept="${r.id}" style="flex:1; padding:6px; font-size:0.8rem !important;">接受</button>
                <button class="btn-3d btn-3d-secondary" data-reject="${r.id}" style="flex:1; padding:6px; font-size:0.8rem !important;">拒絕</button>
            </div>
        </div>
    `).join('');
}

function startFriendSystem() {
    if (!currentUid) return;
    pendingUnsub?.();
    friendsUnsub?.();

    pendingUnsub = FirestoreService.listenPendingRequests(currentUid, (list) => {
        currentPendingRequests = list;
        renderPendingRequests();
    });

    friendsUnsub = FirestoreService.listenFriends(currentUid, (list) => {
        currentFriendUids = list.map(x => x.id);
        renderFriendsLeaderboard();
    });
}

function stopFriendSystem() {
    pendingUnsub?.();
    friendsUnsub?.();
    pendingUnsub = null;
    friendsUnsub = null;
    currentPendingRequests = [];
    currentFriendUids = [];
}

/* =========================================================
 * 🧭 導覽與所有 Modal 事件綁定（僅於 initApp 時呼叫一次，避免重複綁定）
 * ========================================================= */
function setupNavigationAndModals() {
    const mapView = document.getElementById('map-view');
    const profileView = document.getElementById('profile-view');
    const gameView = document.getElementById('game-view');

    const modalLocked = document.getElementById('modal-locked');
    const modalWarmupAsk = document.getElementById('modal-warmup-ask');
    const modalLogoutConfirm = document.getElementById('modal-logout-confirm');
    const modalStreakDashboard = document.getElementById('modal-streak-dashboard');

    // 打卡 Dashboard 觸發與導覽
    const btnStreakTrigger = document.getElementById('btn-streak-trigger');
    const btnCloseStreakModal = document.getElementById('btn-close-streak-modal');
    const btnCalPrev = document.getElementById('btn-cal-prev');
    const btnCalNext = document.getElementById('btn-cal-next');

    if (btnStreakTrigger && modalStreakDashboard) {
        btnStreakTrigger.addEventListener('click', () => {
            modalStreakDashboard.classList.remove('hidden');
            renderCalendar(currentCalendarDate);
        });
    }

    if (btnCloseStreakModal && modalStreakDashboard) {
        btnCloseStreakModal.addEventListener('click', () => {
            modalStreakDashboard.classList.add('hidden');
        });
    }

    if (btnCalPrev) {
        btnCalPrev.addEventListener('click', () => {
            currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
            renderCalendar(currentCalendarDate);
        });
    }

    if (btnCalNext) {
        btnCalNext.addEventListener('click', () => {
            currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
            renderCalendar(currentCalendarDate);
        });
    }

    // 問題五：右上角程度選單 — 永久可用，不可隱藏、不可停用
    const btnLevelTrigger = document.getElementById('btn-level-trigger');
    const modalLevel = document.getElementById('modal-select-initial-level');
    const btnCloseLevel = document.getElementById('btn-close-level-modal');
    if (btnLevelTrigger && modalLevel) {
        btnLevelTrigger.addEventListener('click', () => {
            modalLevel.classList.remove('hidden');
        });
    }
    if (btnCloseLevel && modalLevel) {
        btnCloseLevel.addEventListener('click', () => {
            modalLevel.classList.add('hidden');
        });
    }

    // 問題五：唯一的程度切換確認入口 — 首次選擇程度與右上角切換程度共用同一組事件與同一套權限檢查
    document.getElementById('btn-confirm-initial-level')?.addEventListener('click', () => {
        const selectedLevel = document.getElementById('initial-level-select')?.value || currentSelectedLevel;
        tryApplyLevelSwitch(selectedLevel, { closeModalEl: modalLevel });
    });

    // 舊版程度選單（若頁面存在則同樣套用同一套權限檢查；目前 HTML 無此元素，保留相容不影響其他功能）
    document.getElementById('select-level-course')?.addEventListener('change', (e) => {
        const selected = e.target.value;
        const ok = tryApplyLevelSwitch(selected);
        if (!ok) e.target.value = currentSelectedLevel;
    });

    // 📱 修改暱稱 (一年限制)
    const modalEditNickname = document.getElementById('modal-edit-nickname');
    document.getElementById('btn-open-edit-nickname')?.addEventListener('click', () => {
        const lastChange = currentUserData?.lastNicknameChange;
        if (lastChange) {
            const lastDate = new Date(lastChange);
            const now = new Date();
            const diffDays = Math.ceil((now - lastDate) / (1000 * 60 * 60 * 24));
            if (diffDays < 365) {
                alert(`一年內僅能修改一次暱稱！距離下次可修改還有 ${365 - diffDays} 天。`);
                return;
            }
        }
        modalEditNickname?.classList.remove('hidden');
    });

    document.getElementById('btn-cancel-nickname')?.addEventListener('click', () => {
        modalEditNickname?.classList.add('hidden');
    });

    document.getElementById('btn-save-nickname')?.addEventListener('click', async () => {
        const newNick = document.getElementById('input-edit-nickname')?.value.trim();
        const errEl = document.getElementById('edit-nickname-error-msg');
        if (!newNick || newNick.length < 2 || newNick.length > 12) {
            if (errEl) { errEl.innerText = '暱稱長度需為 2～12 字'; errEl.classList.remove('hidden'); }
            else alert('請輸入有效暱稱（2～12字）！');
            return;
        }
        errEl?.classList.add('hidden');

        const today = new Date().toISOString().split('T')[0];
        await FirestoreService.updateMember(currentUserData.uid, {
            nickname: newNick,
            lastNicknameChange: today
        });

        currentUserData.nickname = newNick;
        currentUserData.lastNicknameChange = today;
        updateUIProfile(currentUserData);
        modalEditNickname?.classList.add('hidden');
        alert("暱稱修改成功！");
    });

    // 👤 問題八：首次登入設定暱稱 Modal（保留手動輸入，不自動產生暱稱；2~12字限制）
    document.getElementById('btn-save-initial-nickname')?.addEventListener('click', async () => {
        const val = document.getElementById('input-setup-nickname')?.value.trim() || '';
        const errEl = document.getElementById('nickname-error-msg');
        if (val.length < 2 || val.length > 12) {
            if (errEl) { errEl.innerText = '暱稱長度需為 2～12 字'; errEl.classList.remove('hidden'); }
            return;
        }
        errEl?.classList.add('hidden');

        const nativeLanguage = document.getElementById('select-native-language')?.value || DEFAULT_LANGUAGE;
        const today = new Date().toISOString().split('T')[0];
        try {
            await FirestoreService.updateMember(currentUid, {
                nickname: val, profileCompleted: true, lastNicknameChange: today, updatedAt: today,
                nativeLanguage
            });
            currentUserData = { ...currentUserData, nickname: val, profileCompleted: true, lastNicknameChange: today, nativeLanguage };
            document.getElementById('modal-setup-nickname')?.classList.add('hidden');
            continueIntoApp();
        } catch (err) {
            alert(`設定暱稱失敗: ${err.message}`);
        }
    });

    // 母語下拉選單：動態依 LANGUAGE_REGISTRY 產生，不寫死在 HTML 裡
    const langSelect = document.getElementById('select-native-language');
    if (langSelect && !langSelect.dataset.populated) {
        langSelect.innerHTML = LANGUAGE_REGISTRY.map(l => `<option value="${l.code}">${escapeHtml(l.label)}</option>`).join('');
        langSelect.dataset.populated = '1';
    }

    // 🔑 修改密碼功能（HTML 若無對應元素則此區塊為安全的無作用程式，不影響其他功能）
    const modalChangePassword = document.getElementById('modal-change-password');
    document.getElementById('btn-open-change-password')?.addEventListener('click', () => {
        modalChangePassword?.classList.remove('hidden');
    });

    document.getElementById('btn-cancel-password')?.addEventListener('click', () => {
        modalChangePassword?.classList.add('hidden');
    });

    document.getElementById('btn-save-password')?.addEventListener('click', async () => {
        const newPass = document.getElementById('input-new-password')?.value.trim();
        if (!newPass || newPass.length < 6) return alert("密碼至少需為 6 位數！");

        try {
            await AuthService.updatePassword(newPass);
            alert("密碼修改成功！下次登入請使用新密碼。");
            modalChangePassword?.classList.add('hidden');
        } catch (err) {
            alert(`修改密碼失敗: ${err.message}`);
        }
    });

    // 視圖切換事件：地圖／個人資料頁（問題九：個人資料頁預設開啟排行榜分頁）
    document.getElementById('btn-profile-trigger')?.addEventListener('click', () => {
        mapView?.classList.add('hidden');
        gameView?.classList.add('hidden');
        profileView?.classList.remove('hidden');

        document.getElementById('sub-page-leaderboard')?.classList.remove('hidden');
        document.getElementById('sub-page-profile')?.classList.add('hidden');
        document.getElementById('btn-view-leaderboard')?.classList.add('active');
        document.getElementById('btn-view-profile')?.classList.remove('active');
        document.getElementById('content-rank-friends')?.classList.remove('hidden');
        document.getElementById('content-rank-global')?.classList.add('hidden');
        document.getElementById('tab-leaderboard-friends')?.classList.add('active');
        document.getElementById('tab-leaderboard-global')?.classList.remove('active');

        renderFriendsLeaderboard();
    });

    document.getElementById('btn-profile-back-map')?.addEventListener('click', () => {
        profileView?.classList.add('hidden');
        mapView?.classList.remove('hidden');
    });

    // 排行榜／個人資料 互相切換（不重新整理頁面）
    document.getElementById('btn-view-leaderboard')?.addEventListener('click', () => {
        document.getElementById('btn-view-leaderboard')?.classList.add('active');
        document.getElementById('btn-view-profile')?.classList.remove('active');
        document.getElementById('sub-page-leaderboard')?.classList.remove('hidden');
        document.getElementById('sub-page-profile')?.classList.add('hidden');
    });

    document.getElementById('btn-view-profile')?.addEventListener('click', () => {
        document.getElementById('btn-view-profile')?.classList.add('active');
        document.getElementById('btn-view-leaderboard')?.classList.remove('active');
        document.getElementById('sub-page-profile')?.classList.remove('hidden');
        document.getElementById('sub-page-leaderboard')?.classList.add('hidden');
    });

    // 排行榜內：好友榜／全球總榜 切換（即時更新，不重新整理，不受目前程度影響）
    document.getElementById('tab-leaderboard-friends')?.addEventListener('click', () => {
        document.getElementById('tab-leaderboard-friends')?.classList.add('active');
        document.getElementById('tab-leaderboard-global')?.classList.remove('active');
        document.getElementById('content-rank-friends')?.classList.remove('hidden');
        document.getElementById('content-rank-global')?.classList.add('hidden');
        renderFriendsLeaderboard();
    });

    document.getElementById('tab-leaderboard-global')?.addEventListener('click', () => {
        document.getElementById('tab-leaderboard-global')?.classList.add('active');
        document.getElementById('tab-leaderboard-friends')?.classList.remove('active');
        document.getElementById('content-rank-global')?.classList.remove('hidden');
        document.getElementById('content-rank-friends')?.classList.add('hidden');
        renderGlobalLeaderboard();
    });

    // 新增好友 Modal
    document.getElementById('btn-open-add-friend')?.addEventListener('click', () => {
        document.getElementById('modal-add-friend')?.classList.remove('hidden');
    });

    document.getElementById('btn-cancel-add-friend')?.addEventListener('click', () => {
        document.getElementById('modal-add-friend')?.classList.add('hidden');
        const input = document.getElementById('input-friend-id');
        if (input) input.value = '';
    });

    document.getElementById('btn-submit-add-friend')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-submit-add-friend');
        const emailVal = document.getElementById('input-friend-id')?.value.trim();
        if (!emailVal) return alert('請輸入好友 Email');
        if (emailVal.toLowerCase() === (currentUserData?.email || '').toLowerCase()) {
            return alert('不可以加自己為好友唷！');
        }
        try {
            btn.disabled = true;
            const target = await FirestoreService.getMemberByEmail(emailVal);
            if (!target) { alert('找不到此 Email 對應的帳號，請確認對方已完成登入。'); return; }
            if (target.id === currentUid) { alert('不可以加自己為好友唷！'); return; }

            const alreadyFriend = await FirestoreService.isAlreadyFriend(currentUid, target.id);
            if (alreadyFriend) { alert('你們已經是好友囉！'); return; }

            const existingReq = await FirestoreService.findExistingRequest(currentUid, target.id);
            if (existingReq) { alert('已經有一筆待處理的好友邀請，請勿重複送出。'); return; }

            await FirestoreService.addFriendRequest({
                fromUid: currentUid,
                fromEmail: currentUserData.email,
                fromNickname: currentUserData.nickname,
                toUid: target.id
            });

            alert('好友邀請已送出！');
            document.getElementById('modal-add-friend')?.classList.add('hidden');
            document.getElementById('input-friend-id').value = '';
        } catch (err) {
            alert(`新增好友失敗: ${err.message}`);
        } finally {
            btn.disabled = false;
        }
    });

    // 待處理好友邀請：接受／拒絕（事件委派，僅綁定一次，避免重複綁定與記憶體洩漏）
    document.getElementById('pending-friend-requests-container')?.addEventListener('click', async (e) => {
        const acceptId = e.target.closest('[data-accept]')?.getAttribute('data-accept');
        const rejectId = e.target.closest('[data-reject]')?.getAttribute('data-reject');
        if (!acceptId && !rejectId) return;

        const id = acceptId || rejectId;
        const reqObj = currentPendingRequests.find(r => r.id === id);
        if (!reqObj) return;

        try {
            await FirestoreService.respondFriendRequest(id, !!acceptId, currentUid, reqObj.fromUid);
        } catch (err) {
            alert(`處理好友邀請失敗: ${err.message}`);
        }
    });

    document.getElementById('btn-close-locked-modal')?.addEventListener('click', () => {
        modalLocked?.classList.add('hidden');
    });

    // 課前暖身 Modal 控制
    const btnCloseWarmupAsk = document.getElementById('btn-close-warmup-ask');
    const btnWarmupYes = document.getElementById('btn-warmup-yes');
    const btnWarmupNo = document.getElementById('btn-warmup-no');

    if (btnCloseWarmupAsk && modalWarmupAsk) {
        btnCloseWarmupAsk.addEventListener('click', () => {
            modalWarmupAsk.classList.add('hidden');
        });
    }

    if (btnWarmupYes && modalWarmupAsk) {
        btnWarmupYes.addEventListener('click', () => {
            modalWarmupAsk.classList.add('hidden');
            alert("即將進入 Step 2 課前暖身頁面！");
        });
    }

    if (btnWarmupNo && modalWarmupAsk) {
        btnWarmupNo.addEventListener('click', () => {
            modalWarmupAsk.classList.add('hidden');
            if (gameView && mapView) {
                mapView.classList.add('hidden');
                gameView.classList.remove('hidden');
                renderGameView();
            }
        });
    }

    // 問題四：新增遊戲視圖返回地圖按鈕
    document.getElementById('btn-back-to-map')?.addEventListener('click', () => {
        gameView?.classList.add('hidden');
        mapView?.classList.remove('hidden');
    });

    document.getElementById('btn-trigger-logout')?.addEventListener('click', () => {
        modalLogoutConfirm?.classList.remove('hidden');
    });

    document.getElementById('btn-logout-no')?.addEventListener('click', () => {
        modalLogoutConfirm?.classList.add('hidden');
    });

    document.getElementById('btn-logout-yes')?.addEventListener('click', async () => {
        modalLogoutConfirm?.classList.add('hidden');
        stopFriendSystem();
        await AuthService.logout();
    });

    renderMapUnits(currentCategory, currentSelectedLevel);
}

/**
 * 問題四：遊戲視圖內容渲染（HTML 區塊為新增內容，此處填入目前選取的單元／階段資訊）
 */
function renderGameView() {
    const titleEl = document.getElementById('game-view-title');
    if (titleEl) titleEl.innerText = `第 ${currentSelectedUnit} 單元・階段 ${currentSelectedStage}`;
    if (currentUid) {
        learningProgress.save(currentUid, {
            lastUnit: currentSelectedUnit,
            lastStage: currentSelectedStage,
            lastCourseId: currentCategory,
            lastLevel: currentSelectedLevel
        });
    }
}

/* =========================================================
 * 🔑 問題二、三：登入 / 註冊 / Google 登入 / 忘記密碼
 * 統一流程：Firebase User → user.email → GAS 白名單 → Members → Firestore
 * ========================================================= */
function setupAuthEventListeners() {
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const btnSubmit = document.getElementById('btn-auth-submit');
    const btnGoogle = document.getElementById('btn-google-login');
    const btnForgot = document.getElementById('btn-forgot-password');
    const loginErrorMsg = document.getElementById('login-error-msg');

    function showLoginError(msg) {
        if (loginErrorMsg) { loginErrorMsg.innerText = msg; loginErrorMsg.classList.remove('hidden'); }
        else alert(msg);
    }

    tabLogin?.addEventListener('click', () => {
        authMode = 'login';
        tabLogin.classList.add('active');
        tabRegister?.classList.remove('active');
        if (btnSubmit) btnSubmit.innerText = '登入';
    });

    tabRegister?.addEventListener('click', () => {
        authMode = 'register';
        tabRegister.classList.add('active');
        tabLogin?.classList.remove('active');
        if (btnSubmit) btnSubmit.innerText = '註冊帳號';
    });

    btnSubmit?.addEventListener('click', async () => {
        const email = document.getElementById('email-input')?.value.trim();
        const password = document.getElementById('password-input')?.value.trim();

        if (!email || !password) return showLoginError("請輸入電子信箱與密碼！");
        loginErrorMsg?.classList.add('hidden');

        try {
            btnSubmit.disabled = true;
            if (authMode === 'login') {
                await AuthService.login(email, password);
            } else {
                await AuthService.register(email, password);
            }
            // 登入／註冊成功後，統一交由下方 onAuthStateChanged 處理 GAS 白名單 → Members → Firestore
        } catch (err) {
            showLoginError(`驗證失敗: ${err.message}`);
        } finally {
            btnSubmit.disabled = false;
        }
    });

    btnGoogle?.addEventListener('click', async () => {
        try {
            btnGoogle.disabled = true;
            await AuthService.loginWithGoogle();
        } catch (err) {
            showLoginError(`Google 登入失敗: ${err.message}`);
        } finally {
            btnGoogle.disabled = false;
        }
    });

    btnForgot?.addEventListener('click', () => {
        document.getElementById('modal-forgot-password')?.classList.remove('hidden');
    });

    document.getElementById('btn-cancel-forgot-password')?.addEventListener('click', () => {
        document.getElementById('modal-forgot-password')?.classList.add('hidden');
    });

    document.getElementById('btn-send-reset-email')?.addEventListener('click', async () => {
        const email = document.getElementById('input-forgot-email')?.value.trim();
        if (!email) return alert('請輸入電子信箱');
        try {
            await AuthService.sendPasswordReset(email);
            alert('已寄送重設密碼信件，請至信箱查收。');
            document.getElementById('modal-forgot-password')?.classList.add('hidden');
        } catch (err) {
            alert(`寄送失敗: ${err.message}`);
        }
    });

    AuthService.onAuthStateChanged(async (user) => {
        if (user) {
            await handlePostAuthSuccess(user);
        } else {
            currentUid = null;
            currentUserData = null;
            stopFriendSystem();
            document.getElementById('login-modal')?.classList.remove('hidden');
            document.getElementById('main-app')?.classList.add('hidden');
        }
    });
}

/**
 * 統一登入後流程：GAS 白名單驗證 → 寫入 Members → 同步 Memberships
 */
async function handlePostAuthSuccess(user) {
    const whitelist = await AuthService.checkWhitelist(user.email);

    if (whitelist.status !== 'success') {
        if (whitelist.status === 'not_allowed') {
            alert('此 Email 尚未開通權限，無法建立資料，請聯繫後台管理員開通後再登入。');
        } else {
            alert(`白名單驗證失敗：${whitelist.message || '請稍後再試'}`);
        }
        await AuthService.logout();
        return;
    }

    const gasMember = whitelist.member || {};
    const gasMemberships = whitelist.memberships || [];
    currentUid = user.uid;

    let member = await FirestoreService.getMember(user.uid);
    const today = new Date().toISOString().split('T')[0];
    const streakData = checkAndUpdateStreak(member || {});
    const progress = learningProgress.get(member);

    const memberPatch = {
        uid: user.uid,
        email: user.email,
        realName: gasMember.realName || member?.realName || '',
        role: gasMember.role || member?.role || 'student',
        status: gasMember.status || member?.status || 'active',
        photoURL: member?.photoURL || user.photoURL || DEFAULT_AVATAR_URL,
        nickname: member?.nickname || '',
        profileCompleted: member?.profileCompleted || false,
        xp: member?.xp || 0,
        lastNicknameChange: member?.lastNicknameChange || '',
        lastCourseId: progress.lastCourseId,
        lastLevel: progress.lastLevel,
        lastLesson: progress.lastLesson,
        lastUnit: progress.lastUnit,
        lastStage: progress.lastStage,
        createdAt: member?.createdAt || today,
        updatedAt: today
    };

    // 問題十一：僅在非異常情況下才寫入 Streak / lastLoginDate
    if (!streakData.anomalous) {
        memberPatch.streak = streakData.streak;
        memberPatch.lastLoginDate = streakData.lastLoginDate;
    } else {
        memberPatch.streak = member?.streak || 1;
        memberPatch.lastLoginDate = member?.lastLoginDate || today;
    }

    await FirestoreService.saveMember(user.uid, memberPatch);
    member = { ...member, ...memberPatch };

    // 同步 Memberships（依 GAS 白名單回傳的課程清單）
    const existingMemberships = await FirestoreService.getMemberships(user.uid);
    for (const m of gasMemberships) {
        const existing = existingMemberships.find(x => x.courseId === m.courseId);
        await FirestoreService.upsertMembership(user.uid, m.courseId, {
            uid: user.uid,
            courseId: m.courseId,
            expireDate: m.expireDate,
            status: m.status,
            purchaseDate: existing?.purchaseDate || today,
            source: existing?.source || 'gas',
            updatedAt: today
        });
    }
    currentMemberships = await FirestoreService.getMemberships(user.uid);
    currentAllowedCourseIds = currentMemberships
        .filter(m => m.status === 'active' && (!m.expireDate || m.expireDate >= today))
        .map(m => m.courseId);

    // 舊版 Users：僅讀取 Energy 等舊欄位，維持相容（不寫入新格式）
    const legacyUser = await FirestoreService.getUserData(user.uid);
    currentUserData = { ...member, energy: legacyUser?.energy !== undefined ? legacyUser.energy : 100 };

    // 問題八：首次登入（尚未完成暱稱設定）→ 顯示設定暱稱 Modal，不自動產生暱稱
    if (!member.profileCompleted || !member.nickname) {
        document.getElementById('modal-setup-nickname')?.classList.remove('hidden');
        return; // 待使用者於 Modal 內完成後，由該按鈕事件呼叫 continueIntoApp()
    }

    continueIntoApp();
}

/**
 * 完成登入前置作業（GAS 白名單 + Members + 暱稱設定）後，正式進入主畫面
 */
function continueIntoApp() {
    currentSelectedLevel = (currentUserData.lastLevel && currentAllowedCourseIds.includes(currentUserData.lastLevel))
        ? currentUserData.lastLevel
        : (currentAllowedCourseIds[0] || currentSelectedLevel);
    currentSelectedUnit = Number(currentUserData.lastUnit) || 1;
    currentSelectedStage = Number(currentUserData.lastStage) || 1;

    document.getElementById('login-modal')?.classList.add('hidden');
    document.getElementById('main-app')?.classList.remove('hidden');

    updateUIProfile(currentUserData);
    renderMapUnits(currentCategory, currentSelectedLevel);
    startFriendSystem();
}

export function initApp() {
    setupAuthEventListeners();
    setupNavigationAndModals();
}

initApp();
