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

// 教材課程對照庫
const MULTI_LANG_COURSES = {
    'korean': {
        '0A': [{ id: 1, title: '單元 1：母音 기초', requiredWords: [] }],
        '1A': [
            { id: 1, title: '單元 1：有 / 沒有 (있다/없다)', requiredWords: [{ wordId: 'k_101', word: '책', meaning: '書本' }] },
            { id: 2, title: '單元 2：數量詞 (개/명)', requiredWords: [] }
        ],
        '1B': [{ id: 1, title: '單元 1：日常動詞與時態', requiredWords: [] }]
    }
};

// 問題五：統一預設頭像網址（無 Google 頭像／Email 註冊時使用）
const DEFAULT_AVATAR_URL = 'https://lh3.googleusercontent.com/a/default-user';

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
function renderMapUnits(category, level) {
    const container = document.getElementById('units-map-list');
    if (!container) return;

    const categoryData = MULTI_LANG_COURSES[category] || {};
    const units = categoryData[level] || [
        { id: 1, title: `單元 1：${level} 基礎課程`, requiredWords: [] }
    ];

    container.innerHTML = units.map(unit => `
        <div class="unit-card">
            <div class="unit-header">
                <div class="unit-title"><i class="fa-solid fa-map-location-dot" style="color: var(--duo-blue);"></i> ${unit.title}</div>
            </div>
            <div class="stages-path">
                <button class="stage-btn-3d" data-unit="${unit.id}" data-stage="1"><i class="fa-solid fa-star"></i> 階段 1</button>
                <button class="stage-btn-3d locked" data-unit="${unit.id}" data-stage="2"><i class="fa-solid fa-lock"></i> 階段 2</button>
                <button class="stage-btn-3d locked" data-unit="${unit.id}" data-stage="3"><i class="fa-solid fa-lock"></i> 階段 3</button>
            </div>
        </div>
    `).join('');

    bindMapStageButtons();
}

function bindMapStageButtons() {
    const modalLocked = document.getElementById('modal-locked');
    const modalWarmupAsk = document.getElementById('modal-warmup-ask');

    document.querySelectorAll('.stage-btn-3d').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.currentTarget;
            currentSelectedUnit = Number(target.getAttribute('data-unit')); // 問題十：統一為 Number
            currentSelectedStage = Number(target.getAttribute('data-stage'));
            const isLocked = target.classList.contains('locked');

            if (isLocked) {
                const msgLbl = document.getElementById('lbl-locked-msg');
                if (msgLbl) msgLbl.innerText = "完成前面關卡，或聯繫後台管理員開通權限唷！";
                modalLocked?.classList.remove('hidden');
            } else {
                modalWarmupAsk?.classList.remove('hidden');
            }
        });
    });
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

        const today = new Date().toISOString().split('T')[0];
        try {
            await FirestoreService.updateMember(currentUid, {
                nickname: val, profileCompleted: true, lastNicknameChange: today, updatedAt: today
            });
            currentUserData = { ...currentUserData, nickname: val, profileCompleted: true, lastNicknameChange: today };
            document.getElementById('modal-setup-nickname')?.classList.add('hidden');
            continueIntoApp();
        } catch (err) {
            alert(`設定暱稱失敗: ${err.message}`);
        }
    });

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
