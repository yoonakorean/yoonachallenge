import { AuthService } from './services/auth.js';
import { FirestoreService } from './services/firebase.js';

let authMode = 'login'; 
let currentCategory = 'korean';
let currentSelectedLevel = '1A';
let currentSelectedUnit = 1;
let currentUserData = null;
let currentCalendarDate = new Date();

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

/**
 * 📱 3. 計算與更新連續登入天數 (Streak)
 */
function checkAndUpdateStreak(userData) {
    const today = new Date().toISOString().split('T')[0];
    let streak = userData.streak || 1;
    const lastLogin = userData.lastLoginDate || '';

    if (lastLogin) {
        const lastDate = new Date(lastLogin);
        const currentDate = new Date(today);
        const diffTime = Math.abs(currentDate - lastDate);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays === 1) {
            streak += 1; // 連續登入加 1 天
        } else if (diffDays > 1) {
            streak = 1;  // 中斷則重置為 1 天
        }
    }

    return { streak, lastLoginDate: today };
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
            currentSelectedUnit = target.getAttribute('data-unit');
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
    
    // 更新頂部 Bar (📱 2. 同一行資訊)
    const lblUsername = document.getElementById('lbl-username');
    if (lblUsername) lblUsername.innerText = data.nickname || '學生';

    const lblLoginDays = document.getElementById('lbl-login-days');
    if (lblLoginDays) lblLoginDays.innerText = data.streak || 1;

    const lblDashStreak = document.getElementById('dash-streak-days');
    if (lblDashStreak) lblDashStreak.innerText = data.streak || 1;

    const lblFocusHours = document.getElementById('dash-focus-hours');
    if (lblFocusHours) lblFocusHours.innerText = (data.focusHours || 0.0).toFixed(1);

    const lblUserLevel = document.getElementById('lbl-user-level');
    if (lblUserLevel) lblUserLevel.innerText = data.allowedLevel || '1A';

    const lblCoins = document.getElementById('lbl-coins');
    if (lblCoins) lblCoins.innerText = data.coins || 0;

    const lblXp = document.getElementById('lbl-xp');
    if (lblXp) lblXp.innerText = data.xp || 0;

    const lblEnergy = document.getElementById('lbl-energy');
    if (lblEnergy) lblEnergy.innerText = data.energy !== undefined ? data.energy : 100;

    // 更新個人檔案頁面
    const profNick = document.getElementById('profile-nickname');
    if (profNick) profNick.innerText = data.nickname || '學生';

    const profEmail = document.getElementById('profile-email');
    if (profEmail) profEmail.innerText = data.email || '';

    const profLevel = document.getElementById('profile-allowed-level');
    if (profLevel) profLevel.innerText = data.allowedLevel || '1A';

    const profExpire = document.getElementById('profile-expire-date');
    if (profExpire) profExpire.innerText = data.expireAt || '未定';

    const profCoins = document.getElementById('profile-coins');
    if (profCoins) profCoins.innerText = data.coins || 0;

    const profXp = document.getElementById('profile-xp');
    if (profXp) profXp.innerText = data.xp || 0;

    const profStreak = document.getElementById('profile-streak');
    if (profStreak) profStreak.innerText = data.streak || 1;

    // 設定程度選單
    const levelSelect = document.getElementById('select-level-course');
    if (levelSelect) levelSelect.value = data.allowedLevel || '1A';
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

    // 程度觸發彈窗按鈕
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

    // 🔒 程度切換檢查：選取的程度若高於會員 allowedLevel 則鎖定
    document.getElementById('select-level-course')?.addEventListener('change', (e) => {
        const selected = e.target.value;
        const allowed = currentUserData?.allowedLevel || '1A';

        if (selected > allowed) {
            const msgLbl = document.getElementById('lbl-locked-msg');
            if (msgLbl) msgLbl.innerText = `您的帳號目前權限為 ${allowed}，無法存取 ${selected} 程度。如需開通請聯繫後台管理員！`;
            modalLocked?.classList.remove('hidden');
            e.target.value = currentSelectedLevel; // 重置回原程度
        } else {
            currentSelectedLevel = selected;
            renderMapUnits(currentCategory, currentSelectedLevel);
        }
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
        if (!newNick) return alert("請輸入有效暱稱！");

        const today = new Date().toISOString().split('T')[0];
        await FirestoreService.updateUserData(currentUserData.uid, {
            nickname: newNick,
            lastNicknameChange: today
        });

        currentUserData.nickname = newNick;
        currentUserData.lastNicknameChange = today;
        updateUIProfile(currentUserData);
        modalEditNickname?.classList.add('hidden');
        alert("暱稱修改成功！");
    });

    // 🔑 修改密碼功能
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

    // 視圖切換事件
    document.getElementById('btn-profile-trigger')?.addEventListener('click', () => {
        mapView?.classList.add('hidden');
        gameView?.classList.add('hidden');
        profileView?.classList.remove('hidden');
    });

    document.getElementById('btn-profile-back-map')?.addEventListener('click', () => {
        profileView?.classList.add('hidden');
        mapView?.classList.remove('hidden');
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
            }
        });
    }

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
        await AuthService.logout();
    });

    renderMapUnits(currentCategory, currentSelectedLevel);
}

function setupAuthEventListeners() {
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const registerFields = document.getElementById('register-extended-fields');
    const btnSubmit = document.getElementById('btn-auth-submit');
    const loginModal = document.getElementById('login-modal');
    const mainApp = document.getElementById('main-app');

    tabLogin?.addEventListener('click', () => {
        authMode = 'login';
        tabLogin.style.fontWeight = 'bold';
        tabLogin.style.borderBottom = '2px solid var(--duo-blue)';
        tabRegister.style.fontWeight = 'normal';
        tabRegister.style.borderBottom = 'none';
        registerFields?.classList.add('hidden');
    });

    tabRegister?.addEventListener('click', () => {
        authMode = 'register';
        tabRegister.style.fontWeight = 'bold';
        tabRegister.style.borderBottom = '2px solid var(--duo-blue)';
        tabLogin.style.fontWeight = 'normal';
        tabLogin.style.borderBottom = 'none';
        registerFields?.classList.remove('hidden');
    });

    btnSubmit?.addEventListener('click', async () => {
        const email = document.getElementById('email-input')?.value.trim();
        const password = document.getElementById('password-input')?.value.trim();

        if (!email || !password) return alert("請輸入電子信箱與密碼！");

        try {
            btnSubmit.disabled = true;
            if (authMode === 'login') {
                await AuthService.login(email, password);
            } else {
                const nickname = document.getElementById('nickname-input')?.value.trim();
                if (!nickname) return alert("請輸入暱稱！");
                await AuthService.register(email, password, { nickname });
            }
        } catch (err) {
            alert(`驗證失敗: ${err.message}`);
        } finally {
            btnSubmit.disabled = false;
        }
    });

    AuthService.onAuthStateChanged(async (user) => {
        if (user) {
            loginModal?.classList.add('hidden');

            // 讀取會員 Firestore 資料
            let userData = await FirestoreService.getUserData(user.uid);

            // 👑 檢查帳號到期日
            const today = new Date().toISOString().split('T')[0];
            if (userData && userData.expireAt && userData.expireAt < today) {
                alert("您的帳號使用期限已到期！學習紀錄已保存，請聯繫後台管理員重新開通。");
                await AuthService.logout();
                return;
            }

            // 🌟 首次登入選取程度處理
            if (!userData || !userData.allowedLevel) {
                document.getElementById('modal-select-initial-level')?.classList.remove('hidden');
                
                const btnConfirm = document.getElementById('btn-confirm-initial-level');
                if (btnConfirm) {
                    btnConfirm.onclick = async () => {
                        const selectedLevel = document.getElementById('initial-level-select')?.value || '1A';
                        const streakData = checkAndUpdateStreak(userData || {});
                        
                        const newUserData = {
                            uid: user.uid,
                            email: user.email,
                            nickname: userData?.nickname || user.email.split('@')[0],
                            allowedLevel: selectedLevel,
                            xp: 0,
                            coins: 0,
                            energy: 100,
                            expireAt: '2026-12-31', // 預設到期日
                            ...streakData
                        };

                        await FirestoreService.saveUserData(user.uid, newUserData);
                        document.getElementById('modal-select-initial-level')?.classList.add('hidden');
                        
                        mainApp?.classList.remove('hidden');
                        updateUIProfile(newUserData);
                        renderMapUnits(currentCategory, selectedLevel);
                    };
                }
            } else {
                // 已存在程度資料，更新連續登入紀錄
                const streakData = checkAndUpdateStreak(userData);
                await FirestoreService.updateUserData(user.uid, streakData);
                userData = { ...userData, ...streakData };

                mainApp?.classList.remove('hidden');
                currentSelectedLevel = userData.allowedLevel;
                updateUIProfile(userData);
                renderMapUnits(currentCategory, currentSelectedLevel);
            }

        } else {
            loginModal?.classList.remove('hidden');
            mainApp?.classList.add('hidden');
        }
    });
}

export function initApp() {
    setupAuthEventListeners();
    setupNavigationAndModals();
}

initApp();
