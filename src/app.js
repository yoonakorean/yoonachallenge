// 🔗 Google Apps Script 白名單 API 網址 (請填入您部署完成的 Web App URL)
const GAS_API_URL = "https://script.google.com/macros/s/YOUR_GAS_DEPLOYMENT_ID/exec";

let currentUser = null;
let currentMemberData = null;
let userMemberships = [];
let currentSelectedLevel = '1A';
let friendRequestsUnsubscribe = null;

// 暱稱驗證規範：2~12字，支援中英韓數字
function validateNickname(nickname) {
    const regex = /^[a-zA-Z0-9\u4e00-\u9fa5\uac00-\ud7a3]{2,12}$/;
    return regex.test(nickname);
}

// 向 GAS 查詢最新 Members + Memberships 白名單
async function fetchGASWhitelist(email) {
    if (!GAS_API_URL || GAS_API_URL.includes("YOUR_GAS_DEPLOYMENT_ID")) {
        console.warn("GAS_API_URL 未設定，進入本機開發測試模式");
        return {
            status: "success",
            member: { email: email, realName: "測試學生", role: "student", status: "active" },
            memberships: [{ courseId: "1A", expireDate: "2027-12-31", status: "active" }]
        };
    }

    try {
        const response = await fetch(`${GAS_API_URL}?email=${encodeURIComponent(email)}`);
        return await response.json();
    } catch (err) {
        console.error("讀取 GAS 白名單失敗:", err);
        return null;
    }
}

// Google Sign-In 登入流程
async function handleGoogleLogin() {
    const errorDiv = document.getElementById('login-error-msg');
    errorDiv?.classList.add('hidden');

    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        const result = await firebase.auth().signInWithPopup(provider);
        const user = result.user;

        // 1. 查詢 GAS 白名單
        const gasResult = await fetchGASWhitelist(user.email);

        if (!gasResult || gasResult.status !== "success") {
            await firebase.auth().signOut();
            errorDiv.innerText = "❌ 存取被拒絕：您的 Email 未開通白名單權限或已被停權！";
            errorDiv.classList.remove('hidden');
            return;
        }

        // 2. 進行 Firebase 資料庫 Migration 與同步
        await syncUserToFirestore(user, gasResult.member, gasResult.memberships);

    } catch (err) {
        console.error("Google 登入失敗:", err);
        errorDiv.innerText = `登入失敗: ${err.message}`;
        errorDiv.classList.remove('hidden');
    }
}

// 🗄️ Members + Memberships Collection 平滑 Migration 機制
async function syncUserToFirestore(authUser, gasMember, gasMemberships) {
    const db = firebase.firestore();
    const memberRef = db.collection('members').doc(authUser.uid);
    const docSnap = await memberRef.get();

    const now = firebase.firestore.FieldValue.serverTimestamp();

    if (!docSnap.exists()) {
        // 第一次登入：建立 Member 基本檔案 (profileCompleted = false)
        const newMember = {
            uid: authUser.uid,
            email: authUser.email,
            realName: gasMember.realName || "",
            nickname: "", // 留空，待引導彈窗輸入
            photoURL: authUser.photoURL || "",
            role: gasMember.role || "student",
            status: gasMember.status || "active",
            profileCompleted: false,
            xp: 0,
            streak: 1,
            lastLoginDate: new Date().toISOString().split('T')[0],
            // 📍 預留首頁自動定位欄位
            lastCourseId: "korean",
            lastLevel: gasMemberships[0]?.courseId || "1A",
            lastUnit: 1,
            lastLesson: 1,
            lastStage: 1,
            createdAt: now,
            updatedAt: now
        };

        await memberRef.set(newMember);
        currentMemberData = newMember;
    } else {
        // 舊帳號 Migration 升級相容：只更新允許的欄位，保留既有 XP、streak 與暱稱
        const existingData = docSnap.data();
        
        const updatedFields = {
            realName: gasMember.realName || existingData.realName || "",
            role: gasMember.role || existingData.role || "student",
            status: gasMember.status || "active",
            photoURL: authUser.photoURL || existingData.photoURL || "",
            updatedAt: now
        };

        await memberRef.update(updatedFields);
        currentMemberData = { ...existingData, ...updatedFields };
    }

    // 同步更新獨立的 memberships Collection (每筆為 {uid}_{courseId})
    for (const ship of gasMemberships) {
        const shipId = `${authUser.uid}_${ship.courseId}`;
        await db.collection('memberships').doc(shipId).set({
            uid: authUser.uid,
            courseId: ship.courseId,
            expireDate: ship.expireDate,
            status: ship.status,
            purchaseDate: ship.purchaseDate || new Date().toISOString().split('T')[0],
            source: "GoogleSheets",
            updatedAt: now
        }, { merge: true });
    }

    // 讀取該使用者的所有 Memberships
    const shipsSnap = await db.collection('memberships').where('uid', '==', authUser.uid).get();
    userMemberships = shipsSnap.docs.map(doc => doc.data());

    // 檢查是否需跳出首次暱稱設定引導
    if (!currentMemberData.profileCompleted || !currentMemberData.nickname) {
        document.getElementById('modal-setup-nickname')?.classList.remove('hidden');
    } else {
        launchMainApp();
    }
}

function launchMainApp() {
    document.getElementById('login-modal')?.classList.add('hidden');
    document.getElementById('main-app')?.classList.remove('hidden');

    // 自動定位上次學習關卡
    currentSelectedLevel = currentMemberData.lastLevel || (userMemberships[0]?.courseId || '1A');

    updateHomeMetaBar();
    renderCourseMap();
    listenForFriendRequests(currentMemberData.uid);
}

// 🏠 更新首頁頂端資訊列（嚴格僅顯示：nickname, streak, xp, level）
function updateHomeMetaBar() {
    document.getElementById('lbl-username').innerText = currentMemberData.nickname || '學生';
    document.getElementById('lbl-login-days').innerText = currentMemberData.streak || 1;
    document.getElementById('lbl-xp').innerText = currentMemberData.xp || 0;
    document.getElementById('lbl-user-level').innerText = currentSelectedLevel;
}

// 👤 更新 Profile（我的帳號）詳細資料頁面
function updateProfileView() {
    document.getElementById('profile-user-avatar').src = currentMemberData.photoURL || "https://via.placeholder.com/72";
    document.getElementById('profile-nickname').innerText = currentMemberData.nickname || '學生';
    document.getElementById('profile-email').innerText = currentMemberData.email || '';
    document.getElementById('profile-realname').innerText = currentMemberData.realName || '-';
    document.getElementById('profile-role').innerText = currentMemberData.role || 'Student';
    document.getElementById('profile-status').innerText = currentMemberData.status === 'active' ? '開通中' : '停權';

    document.getElementById('profile-xp').innerText = currentMemberData.xp || 0;
    document.getElementById('profile-streak').innerText = currentMemberData.streak || 1;

    // 渲染 memberships Collection 開通清單
    const container = document.getElementById('profile-memberships-list');
    if (container) {
        if (userMemberships.length === 0) {
            container.innerHTML = `<span style="font-size:0.82rem; color:#9ca3af;">無有效課程紀錄</span>`;
        } else {
            container.innerHTML = userMemberships.map(m => `
                <div style="display:flex; justify-content:space-between; align-items:center; background:#f9fafb; padding:8px 12px; border-radius:10px; border:1px solid #e5e7eb;">
                    <span class="course-badge-pill">${m.courseId} 課程</span>
                    <span style="font-size:0.8rem; color:#4b5563;">到期日: <strong>${m.expireDate}</strong></span>
                </div>
            `).join('');
        }
    }
}

function renderCourseMap() {
    const container = document.getElementById('units-map-list');
    if (!container) return;

    // 依據 lastUnit 進行畫面呈現
    container.innerHTML = `
        <div class="unit-card">
            <div class="unit-header">
                <div class="unit-title"><i class="fa-solid fa-map-location-dot" style="color: var(--duo-blue);"></i> 韓語 - ${currentSelectedLevel} 學習關卡</div>
            </div>
            <div class="stages-path">
                <button class="stage-btn-3d" data-unit="1" data-stage="1"><i class="fa-solid fa-star"></i> 階段 1</button>
                <button class="stage-btn-3d locked" data-unit="1" data-stage="2"><i class="fa-solid fa-lock"></i> 階段 2</button>
            </div>
        </div>
    `;
}

function listenForFriendRequests(uid) {
    if (friendRequestsUnsubscribe) friendRequestsUnsubscribe();

    const db = firebase.firestore();
    friendRequestsUnsubscribe = db.collection('friendRequests')
        .where('toUid', '==', uid)
        .onSnapshot(snapshot => {
            const badge = document.getElementById('profile-notif-badge');
            if (!snapshot.empty) badge?.classList.remove('hidden');
            else badge?.classList.add('hidden');
        });
}

function setupEvents() {
    document.getElementById('btn-google-login').onclick = handleGoogleLogin;

    // 首次暱稱設定送出
    document.getElementById('btn-save-initial-nickname').onclick = async () => {
        const input = document.getElementById('input-setup-nickname').value.trim();
        const errDiv = document.getElementById('nickname-error-msg');

        if (!validateNickname(input)) {
            errDiv.innerText = "❌ 暱稱需為 2~12 字，僅能包含中文、英文、韓文及數字！";
            errDiv.classList.remove('hidden');
            return;
        }

        const db = firebase.firestore();
        // 檢查暱稱唯一性
        const existing = await db.collection('members').where('nickname', '==', input).get();
        if (!existing.empty) {
            errDiv.innerText = "❌ 此暱稱已被其他人使用，請換一個！";
            errDiv.classList.remove('hidden');
            return;
        }

        const today = new Date().toISOString().split('T')[0];
        await db.collection('members').doc(currentMemberData.uid).update({
            nickname: input,
            profileCompleted: true,
            lastNicknameChange: today
        });

        currentMemberData.nickname = input;
        currentMemberData.profileCompleted = true;

        document.getElementById('modal-setup-nickname')?.classList.add('hidden');
        launchMainApp();
    };

    // 頁面導覽
    document.getElementById('btn-profile-trigger').onclick = () => {
        document.getElementById('map-view')?.classList.add('hidden');
        document.getElementById('profile-view')?.classList.remove('hidden');
        updateProfileView();
    };

    document.getElementById('btn-profile-back-map').onclick = () => {
        document.getElementById('profile-view')?.classList.add('hidden');
        document.getElementById('map-view')?.classList.remove('hidden');
    };

    document.getElementById('btn-view-leaderboard').onclick = () => {
        document.getElementById('btn-view-leaderboard').classList.add('active');
        document.getElementById('btn-view-profile').classList.remove('active');
        document.getElementById('sub-page-leaderboard').classList.remove('hidden');
        document.getElementById('sub-page-profile').classList.add('hidden');
    };

    document.getElementById('btn-view-profile').onclick = () => {
        document.getElementById('btn-view-profile').classList.add('active');
        document.getElementById('btn-view-leaderboard').classList.remove('active');
        document.getElementById('sub-page-profile').classList.remove('hidden');
        document.getElementById('sub-page-leaderboard').classList.add('hidden');
        updateProfileView();
    };

    // 登出
    document.getElementById('btn-trigger-logout').onclick = () => {
        document.getElementById('modal-logout-confirm')?.classList.remove('hidden');
    };
    document.getElementById('btn-logout-no').onclick = () => {
        document.getElementById('modal-logout-confirm')?.classList.add('hidden');
    };
    document.getElementById('btn-logout-yes').onclick = async () => {
        await firebase.auth().signOut();
        location.reload();
    };
}

// 啟動系統
firebase.auth().onAuthStateChanged(user => {
    if (user) {
        currentUser = user;
    } else {
        document.getElementById('login-modal')?.classList.remove('hidden');
        document.getElementById('main-app')?.classList.add('hidden');
    }
});

setupEvents();
