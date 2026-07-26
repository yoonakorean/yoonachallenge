import { AuthService } from './services/auth.js';
import { FirestoreService } from './services/firebase.js';

// 🔗 Google Apps Script 白名單 API 網址 (請填入您部署完成的 URL)
const GAS_API_URL = "https://script.google.com/macros/s/YOUR_GAS_DEPLOYMENT_ID/exec";

let authMode = 'login'; 
let currentCategory = 'korean';
let currentSelectedLevel = '1A';
let currentSelectedUnit = 1;
let currentUserData = null;
let friendRequestsUnsubscribe = null;

let viewYear = 2026;
let viewMonth = 6; 

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

// 向 Google 試算表查詢會員白名單
async function fetchSheetPermissions(email) {
    if (!GAS_API_URL || GAS_API_URL.includes("YOUR_GAS_DEPLOYMENT_ID")) {
        console.warn("GAS_API_URL 未設定，使用預設全權限運作。");
        return null;
    }

    try {
        const response = await fetch(`${GAS_API_URL}?email=${encodeURIComponent(email)}`);
        const data = await response.json();
        if (data && data.status === 'success') {
            return data;
        }
    } catch (err) {
        console.error("讀取 Google 試算表失敗:", err);
    }
    return null;
}

function checkAndUpdateStreak(userData) {
    const today = new Date().toISOString().split('T')[0];
    let streak = userData.streak || 1;
    const lastLogin = userData.lastLoginDate || '';
    let loginHistory = userData.loginHistory || [];

    if (!loginHistory.includes(today)) {
        loginHistory.push(today);
    }

    if (lastLogin) {
        const lastDate = new Date(lastLogin);
        const currentDate = new Date(today);
        const diffDays = Math.ceil(Math.abs(currentDate - lastDate) / (1000 * 60 * 60 * 24));

        if (diffDays === 1) streak += 1;
        else if (diffDays > 1) streak = 1;
    }

    return { streak, lastLoginDate: today, loginHistory };
}

function renderStreakCalendar(loginHistory = [], year = viewYear, month = viewMonth) {
    const container = document.getElementById('calendar-days-container');
    const monthTitle = document.getElementById('lbl-calendar-month-title');
    if (!container) return;

    if (monthTitle) {
        monthTitle.innerText = `${year}年 ${month + 1}月`;
    }

    container.innerHTML = '';
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
        const emptyCell = document.createElement('div');
        emptyCell.className = 'calendar-day';
        container.appendChild(emptyCell);
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const dayCell = document.createElement('div');
        dayCell.className = 'calendar-day';
        dayCell.innerText = day;

        const monthStr = String(month + 1).padStart(2, '0');
        const dayStr = String(day).padStart(2, '0');
        const dateKey = `${year}-${monthStr}-${dayStr}`;

        if (loginHistory.includes(dateKey)) {
            dayCell.classList.add('active-login');
        }

        container.appendChild(dayCell);
    }
}

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
        btn.onclick = (e) => {
            const target = e.currentTarget;
            currentSelectedUnit = target.getAttribute('data-unit');
            const isLocked = target.classList.contains('locked');

            if (isLocked) {
                document.getElementById('lbl-locked-msg').innerText = "完成前面關卡才可以解鎖唷！";
                modalLocked?.classList.remove('hidden');
            } else {
                modalWarmupAsk?.classList.remove('hidden');
            }
        };
    });
}

function updateUIProfile(data) {
    currentUserData = data;
    
    const allowedList = data.allowedLevels || ['0A', '1A', '1B', '2A', '2B', '3A', '3B', '4A'];

    document.getElementById('lbl-username').innerText = data.nickname || '學生';
    document.getElementById('lbl-login-days').innerText = data.streak || 1;
    document.getElementById('lbl-user-level').innerText = currentSelectedLevel;
    document.getElementById('lbl-energy').innerText = data.energy || 100;
    document.getElementById('lbl-xp').innerText = data.xp || 0;

    document.getElementById('profile-nickname').innerText = data.nickname || '學生';
    document.getElementById('profile-email').innerText = data.email || '';
    document.getElementById('profile-allowed-level').innerText = allowedList.join(', ');
    document.getElementById('profile-expire-date').innerText = data.expireAt || '未定';
    document.getElementById('profile-energy').innerText = data.energy || 100;
    document.getElementById('profile-xp').innerText = data.xp || 0;
    document.getElementById('profile-streak').innerText = data.streak || 1;

    document.getElementById('lbl-global-rank-level').innerText = currentSelectedLevel;

    document.getElementById('dash-streak-days').innerText = data.streak || 1;
    document.getElementById('dash-focus-hours').innerText = (data.focusHours || 0.0).toFixed(1);
}

// 👂 即時監聽好友邀請通知 (1秒內顯示紅點與卡片)
function listenForFriendRequests(uid) {
    if (friendRequestsUnsubscribe) friendRequestsUnsubscribe();

    const db = firebase.firestore();
    friendRequestsUnsubscribe = db.collection('users').doc(uid).collection('friendRequests')
        .onSnapshot(snapshot => {
            const requests = [];
            snapshot.forEach(doc => {
                requests.push({ id: doc.id, ...doc.data() });
            });

            const badge = document.getElementById('profile-notif-badge');
            const container = document.getElementById('pending-friend-requests-container');

            if (requests.length > 0) {
                badge?.classList.remove('hidden');
                container?.classList.remove('hidden');
                
                container.innerHTML = `
                    <div style="font-weight:bold; color:var(--duo-blue); margin-bottom:8px;">📩 待處理的好友邀請 (${requests.length})</div>
                    ${requests.map(req => `
                        <div class="friend-request-card">
                            <div style="font-size:0.9rem; color:#374151;"><strong>${req.fromNickname || req.fromEmail}</strong> 想要加你為好友！</div>
                            <div style="display:flex; gap:8px;">
                                <button class="btn-3d btn-3d-primary btn-accept-friend" data-id="${req.id}" data-email="${req.fromEmail}" data-nick="${req.fromNickname}" style="flex:1; padding:6px; font-size:0.8rem !important;">接受</button>
                                <button class="btn-3d btn-3d-secondary btn-reject-friend" data-id="${req.id}" style="flex:1; padding:6px; font-size:0.8rem !important;">拒絕</button>
                            </div>
                        </div>
                    `).join('')}
                `;

                bindFriendRequestActions(uid);
            } else {
                badge?.classList.add('hidden');
                container?.classList.add('hidden');
                container.innerHTML = '';
            }
        });
}

function bindFriendRequestActions(uid) {
    const db = firebase.firestore();

    document.querySelectorAll('.btn-accept-friend').forEach(btn => {
        btn.onclick = async (e) => {
            const reqId = e.target.getAttribute('data-id');
            const friendEmail = e.target.getAttribute('data-email');
            const friendNick = e.target.getAttribute('data-nick');

            // 1. 將好友加入目前用戶的好友清單
            await db.collection('users').doc(uid).collection('friends').doc(reqId).set({
                email: friendEmail,
                nickname: friendNick,
                addedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            // 2. 刪除該筆邀請紀錄
            await db.collection('users').doc(uid).collection('friendRequests').doc(reqId).delete();

            alert(`已成功接受 ${friendNick || friendEmail} 的好友邀請！`);
        };
    });

    document.querySelectorAll('.btn-reject-friend').forEach(btn => {
        btn.onclick = async (e) => {
            const reqId = e.target.getAttribute('data-id');
            await db.collection('users').doc(uid).collection('friendRequests').doc(reqId).delete();
        };
    });
}

function setupNavigationAndModals() {
    const mapView = document.getElementById('map-view');
    const profileView = document.getElementById('profile-view');
    const gameView = document.getElementById('game-view');

    const modalLocked = document.getElementById('modal-locked');
    const modalWarmupAsk = document.getElementById('modal-warmup-ask');
    const modalStreakDashboard = document.getElementById('modal-streak-dashboard');
    const modalLogoutConfirm = document.getElementById('modal-logout-confirm');
    const modalLevelSelect = document.getElementById('modal-select-initial-level');

    const streakBtn = document.getElementById('btn-streak-trigger');
    if (streakBtn) {
        streakBtn.onclick = () => {
            const now = new Date();
            viewYear = now.getFullYear();
            viewMonth = now.getMonth();
            renderStreakCalendar(currentUserData?.loginHistory || [], viewYear, viewMonth);
            modalStreakDashboard?.classList.remove('hidden');
        };
    }

    document.getElementById('btn-close-streak-modal').onclick = () => {
        modalStreakDashboard?.classList.add('hidden');
    };

    document.getElementById('btn-cal-prev').onclick = () => {
        viewMonth--;
        if (viewMonth < 0) {
            viewMonth = 11;
            viewYear--;
        }
        renderStreakCalendar(currentUserData?.loginHistory || [], viewYear, viewMonth);
    };

    document.getElementById('btn-cal-next').onclick = () => {
        viewMonth++;
        if (viewMonth > 11) {
            viewMonth = 0;
            viewYear++;
        }
        renderStreakCalendar(currentUserData?.loginHistory || [], viewYear, viewMonth);
    };

    // 切換程度選單 (保留選單顯示，若無權限一樣彈窗提示)
    const levelTrigger = document.getElementById('btn-level-trigger');
    if (levelTrigger) {
        levelTrigger.onclick = () => {
            const select = document.getElementById('initial-level-select');
            if (select) select.value = currentSelectedLevel;
            modalLevelSelect?.classList.remove('hidden');
        };
    }

    document.getElementById('btn-close-level-modal').onclick = () => {
        modalLevelSelect?.classList.add('hidden');
    };

    document.getElementById('btn-confirm-initial-level').onclick = () => {
        const selected = document.getElementById('initial-level-select').value;
        const allowedList = currentUserData?.allowedLevels || ['0A', '1A', '1B', '2A', '2B', '3A', '3B', '4A'];

        if (!allowedList.includes(selected)) {
            modalLevelSelect?.classList.add('hidden');
            document.getElementById('lbl-locked-msg').innerText = `您的帳號目前尚未開通 ${selected} 程度權限。如需開通請聯繫後台管理員！`;
            modalLocked?.classList.remove('hidden');
        } else {
            currentSelectedLevel = selected;
            renderMapUnits(currentCategory, currentSelectedLevel);
            document.getElementById('lbl-user-level').innerText = selected;
            document.getElementById('lbl-global-rank-level').innerText = selected;
            modalLevelSelect?.classList.add('hidden');
        }
    };

    const btnProfileTrigger = document.getElementById('btn-profile-trigger');
    const subPageLeaderboard = document.getElementById('sub-page-leaderboard');
    const subPageProfile = document.getElementById('sub-page-profile');
    const btnViewLeaderboard = document.getElementById('btn-view-leaderboard');
    const btnViewProfile = document.getElementById('btn-view-profile');

    function switchSubPage(target) {
        if (target === 'leaderboard') {
            btnViewLeaderboard?.classList.add('active');
            btnViewProfile?.classList.remove('active');
            subPageLeaderboard?.classList.remove('hidden');
            subPageProfile?.classList.add('hidden');
        } else if (target === 'profile') {
            btnViewProfile?.classList.add('active');
            btnViewLeaderboard?.classList.remove('active');
            subPageProfile?.classList.remove('hidden');
            subPageLeaderboard?.classList.add('hidden');
        }
    }

    if (btnProfileTrigger) {
        btnProfileTrigger.onclick = () => {
            mapView?.classList.add('hidden');
            gameView?.classList.add('hidden');
            profileView?.classList.remove('hidden');
            switchSubPage('leaderboard');
        };
    }

    if (btnViewLeaderboard) btnViewLeaderboard.onclick = () => switchSubPage('leaderboard');
    if (btnViewProfile) btnViewProfile.onclick = () => switchSubPage('profile');

    const tabFriends = document.getElementById('tab-leaderboard-friends');
    const tabGlobal = document.getElementById('tab-leaderboard-global');
    const contentFriends = document.getElementById('content-rank-friends');
    const contentGlobal = document.getElementById('content-rank-global');

    if (tabFriends && tabGlobal) {
        tabFriends.onclick = () => {
            tabFriends.classList.add('active');
            tabGlobal.classList.remove('active');
            contentFriends?.classList.remove('hidden');
            contentGlobal?.classList.add('hidden');
        };

        tabGlobal.onclick = () => {
            tabGlobal.classList.add('active');
            tabFriends.classList.remove('active');
            contentGlobal?.classList.remove('hidden');
            contentFriends?.classList.add('hidden');
        };
    }

    // 發送好友邀請
    const modalAddFriend = document.getElementById('modal-add-friend');
    document.getElementById('btn-open-add-friend').onclick = () => {
        modalAddFriend?.classList.remove('hidden');
    };

    document.getElementById('btn-cancel-add-friend').onclick = () => {
        modalAddFriend?.classList.add('hidden');
    };

    document.getElementById('btn-submit-add-friend').onclick = async () => {
        const friendEmail = document.getElementById('input-friend-id')?.value.trim();
        if (!friendEmail) return alert("請輸入好友的 Email！");
        if (friendEmail === currentUserData.email) return alert("不能新增自己為好友喔！");

        try {
            const db = firebase.firestore();
            const targetUserQuery = await db.collection('users').where('email', '==', friendEmail).get();

            if (targetUserQuery.empty) {
                return alert("找不到該 Email 的使用者，請確認對方已註冊帳號！");
            }

            const targetDoc = targetUserQuery.docs[0];
            const targetUid = targetDoc.id;

            // 寫入對方的 friendRequests 集合
            await db.collection('users').doc(targetUid).collection('friendRequests').doc(currentUserData.uid).set({
                fromEmail: currentUserData.email,
                fromNickname: currentUserData.nickname || currentUserData.email.split('@')[0],
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            alert(`已成功向 [${friendEmail}] 發送好友邀請！`);
            modalAddFriend?.classList.add('hidden');
            document.getElementById('input-friend-id').value = '';
        } catch (err) {
            alert(`發送邀請失敗: ${err.message}`);
        }
    };

    // 修改暱稱 Modal
    const modalEditNickname = document.getElementById('modal-edit-nickname');
    document.getElementById('btn-open-edit-nickname').onclick = () => {
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
    };

    document.getElementById('btn-cancel-nickname').onclick = () => modalEditNickname?.classList.add('hidden');

    document.getElementById('btn-save-nickname').onclick = async () => {
        const newNick = document.getElementById('input-new-nickname')?.value.trim();
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
    };

    // 修改密碼 Modal
    const modalChangePassword = document.getElementById('modal-change-password');
    document.getElementById('btn-open-change-password').onclick = () => modalChangePassword?.classList.remove('hidden');
    document.getElementById('btn-cancel-password').onclick = () => modalChangePassword?.classList.add('hidden');

    document.getElementById('btn-save-password').onclick = async () => {
        const newPass = document.getElementById('input-new-password')?.value.trim();
        if (!newPass || newPass.length < 6) return alert("密碼至少需為 6 位數！");

        try {
            await AuthService.updatePassword(newPass);
            alert("密碼修改成功！下次登入請使用新密碼。");
            modalChangePassword?.classList.add('hidden');
        } catch (err) {
            alert(`修改密碼失敗: ${err.message}`);
        }
    };

    document.getElementById('btn-profile-back-map').onclick = () => {
        profileView?.classList.add('hidden');
        mapView?.classList.remove('hidden');
    };

    document.getElementById('btn-close-locked-modal').onclick = () => modalLocked?.classList.add('hidden');
    document.getElementById('btn-close-warmup-ask').onclick = () => modalWarmupAsk?.classList.add('hidden');

    document.getElementById('btn-warmup-yes').onclick = () => {
        modalWarmupAsk?.classList.add('hidden');
        alert("即將進入 Step 2 課前暖身頁面！");
    };

    document.getElementById('btn-warmup-no').onclick = () => {
        modalWarmupAsk?.classList.add('hidden');
        mapView?.classList.add('hidden');
        gameView?.classList.remove('hidden');
    };

    document.getElementById('btn-back-to-map').onclick = () => {
        gameView?.classList.add('hidden');
        mapView?.classList.remove('hidden');
    };

    document.getElementById('btn-trigger-logout').onclick = () => modalLogoutConfirm?.classList.remove('hidden');
    document.getElementById('btn-logout-no').onclick = () => modalLogoutConfirm?.classList.add('hidden');

    document.getElementById('btn-logout-yes').onclick = async () => {
        if (friendRequestsUnsubscribe) friendRequestsUnsubscribe();
        modalLogoutConfirm?.classList.add('hidden');
        await AuthService.logout();
    };

    renderMapUnits(currentCategory, currentSelectedLevel);
}

function setupAuthEventListeners() {
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const registerFields = document.getElementById('register-extended-fields');
    const btnSubmit = document.getElementById('btn-auth-submit');
    const loginModal = document.getElementById('login-modal');
    const mainApp = document.getElementById('main-app');

    tabLogin.onclick = () => {
        authMode = 'login';
        tabLogin.classList.add('active');
        tabRegister.classList.remove('active');
        registerFields?.classList.add('hidden');
    };

    tabRegister.onclick = () => {
        authMode = 'register';
        tabRegister.classList.add('active');
        tabLogin.classList.remove('active');
        registerFields?.classList.remove('hidden');
    };

    btnSubmit.onclick = async () => {
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
    };

    AuthService.onAuthStateChanged(async (user) => {
        if (user) {
            loginModal?.classList.add('hidden');

            let userData = await FirestoreService.getUserData(user.uid);
            
            // 🔍 向 Google 試算表查詢最新權限與到期日
            const sheetPerms = await fetchSheetPermissions(user.email);

            const today = new Date().toISOString().split('T')[0];

            let allowedLevels = ['1A'];
            let expireAt = '2026-12-31';

            if (sheetPerms) {
                if (!sheetPerms.active) {
                    alert("您的帳號已被後台管理員設定為停權狀態！");
                    await AuthService.logout();
                    return;
                }
                if (sheetPerms.expireAt && sheetPerms.expireAt < today) {
                    alert("您的帳號使用期限已到期！請聯繫後台管理員續約。");
                    await AuthService.logout();
                    return;
                }
                allowedLevels = sheetPerms.allowedLevels || ['1A'];
                expireAt = sheetPerms.expireAt || '2026-12-31';
            } else if (userData) {
                allowedLevels = userData.allowedLevels || (userData.allowedLevel ? [userData.allowedLevel] : ['1A']);
                expireAt = userData.expireAt || '2026-12-31';
            }

            const streakData = checkAndUpdateStreak(userData || {});

            const updatedUserData = {
                uid: user.uid,
                email: user.email,
                nickname: userData?.nickname || user.email.split('@')[0],
                allowedLevels: allowedLevels,
                expireAt: expireAt,
                xp: userData?.xp || 0,
                energy: userData?.energy || 100,
                focusHours: userData?.focusHours || 0.0,
                ...streakData
            };

            await FirestoreService.saveUserData(user.uid, updatedUserData);

            mainApp?.classList.remove('hidden');
            currentSelectedLevel = allowedLevels[0] || '1A';
            
            updateUIProfile(updatedUserData);
            renderMapUnits(currentCategory, currentSelectedLevel);

            // 開啟即時好友邀請監聽
            listenForFriendRequests(user.uid);

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
