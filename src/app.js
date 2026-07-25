// 🔗 Google Apps Script 白名單 API 網址
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

// 檢查暱稱是否在一年的冷卻期內
function canChangeNickname(lastChangeDateStr) {
    if (!lastChangeDateStr) return true;
    const lastDate = new Date(lastChangeDateStr);
    const oneYearLater = new Date(lastDate);
    oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
    return new Date() >= oneYearLater;
}

// 向 GAS 查詢最新 Members + Memberships 白名單
async function fetchGASWhitelist(email) {
    if (!GAS_API_URL || GAS_API_URL.includes("YOUR_GAS_DEPLOYMENT_ID")) {
        console.warn("GAS_API_URL 未設定，進入預設白名單驗證模式");
        return {
            status: "success",
            member: { email: email, realName: "測試學生", role: "student", status: "active" },
            memberships: [{ courseId: "1A", expireDate: "2027-12-31", status: "active" }]
        };
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(`${GAS_API_URL}?email=${encodeURIComponent(email)}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`GAS API 狀態碼異常: ${response.status}`);
        return await response.json();
    } catch (err) {
        console.error("讀取 GAS 白名單失敗:", err);
        return null;
    }
}

// Google Sign-In 登入流程
async function handleGoogleLogin() {
    console.log("🔍 [DEBUG] 觸發 handleGoogleLogin()");
    const errorDiv = document.getElementById('login-error-msg');
    const loginBtn = document.getElementById('btn-google-login');

    if (errorDiv) errorDiv.classList.add('hidden');
    if (loginBtn) loginBtn.disabled = true;

    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });

        console.log("🔍 [DEBUG] 開始執行 signInWithPopup...");
        const result = await firebase.auth().signInWithPopup(provider);
        console.log("✅ [DEBUG] signInWithPopup 成功:", result.user);
        const user = result.user;

        // 1. 查詢 GAS 白名單
        const gasResult = await fetchGASWhitelist(user.email);

        if (!gasResult || gasResult.status !== "success") {
            await firebase.auth().signOut();
            if (errorDiv) {
                errorDiv.innerText = "❌ 存取被拒絕：您的 Email 未開通白名單權限或已被停權！";
                errorDiv.classList.remove('hidden');
            }
            return;
        }

        // 2. 進行 Firebase 資料同步
        await syncUserToFirestore(user, gasResult.member, gasResult.memberships);

    } catch (err) {
        // 🎯 問題 A 關鍵偵錯：印出最真實的 Error Code 與 Message
        console.error("❌ [DEBUG] Google 登入失敗捕獲之完整 Error 物件:", err);
        console.error("❌ [DEBUG] Error Code:", err.code);
        console.error("❌ [DEBUG] Error Message:", err.message);

        if (errorDiv && err.code !== 'auth/popup-closed-by-user') {
            errorDiv.innerText = `登入失敗: ${err.message}`;
            errorDiv.classList.remove('hidden');
        }
    } finally {
        if (loginBtn) loginBtn.disabled = false;
    }
}

// Members + Memberships 資料同步
async function syncUserToFirestore(authUser, gasMember, gasMemberships) {
    const db = firebase.firestore();
    const memberRef = db.collection('members').doc(authUser.uid);
    const docSnap = await memberRef.get();

    const now = firebase.firestore.FieldValue.serverTimestamp();

    if (!docSnap.exists) {
        const newMember = {
            uid: authUser.uid,
            email: authUser.email,
            realName: gasMember.realName || "",
            nickname: "",
            photoURL: authUser.photoURL || "",
            role: gasMember.role || "student",
            status: gasMember.status || "active",
            profileCompleted: false,
            xp: 0,
            streak: 1,
            lastLoginDate: new Date().toISOString().split('T')[0],
            lastCourseId: "KR",
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

    if (Array.isArray(gasMemberships)) {
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
    }

    const shipsSnap = await db.collection('memberships').where('uid', '==', authUser.uid).get();
    userMemberships = shipsSnap.docs.map(doc => doc.data());

    if (!currentMemberData.profileCompleted || !currentMemberData.nickname) {
        document.getElementById('modal-setup-nickname')?.classList.remove('hidden');
    } else {
        launchMainApp();
    }
}

function launchMainApp() {
    document.getElementById('login-modal')?.classList.add('hidden');
    document.getElementById('main-app')?.classList.remove('hidden');

    currentSelectedLevel = currentMemberData.lastLevel || (userMemberships[0]?.courseId || '1A');

    updateHomeMetaBar();
    renderCourseMap();
    listenForFriendRequests(currentMemberData.uid);
}

function updateHomeMetaBar() {
    const lblName = document.getElementById('lbl-username');
    const lblDays = document.getElementById('lbl-login-days');
    const lblXp = document.getElementById('lbl-xp');
    const lblLevel = document.getElementById('lbl-user-level');

    if (lblName) lblName.innerText = currentMemberData?.nickname || '學生';
    if (lblDays) lblDays.innerText = currentMemberData?.streak || 1;
    if (lblXp) lblXp.innerText = currentMemberData?.xp || 0;
    if (lblLevel) lblLevel.innerText = currentSelectedLevel;
}

function updateProfileView() {
    const avatarImg = document.getElementById('profile-user-avatar');
    if (avatarImg) {
        avatarImg.src = currentMemberData?.photoURL || "https://placehold.co/72x72/e2e8f0/475569?text=User";
    }

    const lblNick = document.getElementById('profile-nickname');
    const lblEmail = document.getElementById('profile-email');
    const lblReal = document.getElementById('profile-realname');
    const lblRole = document.getElementById('profile-role');
    const lblStatus = document.getElementById('profile-status');
    const lblXp = document.getElementById('profile-xp');
    const lblStreak = document.getElementById('profile-streak');

    if (lblNick) lblNick.innerText = currentMemberData?.nickname || '學生';
    if (lblEmail) lblEmail.innerText = currentMemberData?.email || '';
    if (lblReal) lblReal.innerText = currentMemberData?.realName || '-';
    if (lblRole) lblRole.innerText = currentMemberData?.role || 'Student';
    if (lblStatus) lblStatus.innerText = currentMemberData?.status === 'active' ? '開通中' : '停權';
    if (lblXp) lblXp.innerText = currentMemberData?.xp || 0;
    if (lblStreak) lblStreak.innerText = currentMemberData?.streak || 1;

    const container = document.getElementById('profile-memberships-list');
    if (container) {
        if (!userMemberships || userMemberships.length === 0) {
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

    const userLastUnit = currentMemberData?.lastUnit || 1;
    const userLastStage = currentMemberData?.lastStage || 1;

    // 依據 Unit 與 Stage 進度動態生成關卡地圖
    const unitsData = [
        { unit: 1, title: `韓語 - ${currentSelectedLevel} 基礎學習`, stages: [1, 2, 3] },
        { unit: 2, title: `韓語 - ${currentSelectedLevel} 進階應用`, stages: [1, 2, 3] }
    ];

    container.innerHTML = unitsData.map(u => {
        const stagesHtml = u.stages.map(s => {
            let isLocked = true;
            if (u.unit < userLastUnit) {
                isLocked = false;
            } else if (u.unit === userLastUnit && s <= userLastStage) {
                isLocked = false;
            }

            if (isLocked) {
                return `<button class="stage-btn-3d locked" data-unit="${u.unit}" data-stage="${s}"><i class="fa-solid fa-lock"></i> 階段 ${s}</button>`;
            } else {
                return `<button class="stage-btn-3d" data-unit="${u.unit}" data-stage="${s}"><i class="fa-solid fa-star"></i> 階段 ${s}</button>`;
            }
        }).join('');

        return `
            <div class="unit-card">
                <div class="unit-header">
                    <div class="unit-title"><i class="fa-solid fa-map-location-dot" style="color: var(--duo-blue);"></i> ${u.title}</div>
                </div>
                <div class="stages-path">
                    ${stagesHtml}
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.stage-btn-3d').forEach(btn => {
        btn.onclick = () => {
            if (btn.classList.contains('locked')) {
                const modal = document.getElementById('modal-locked');
                if (modal) modal.classList.remove('hidden');
            } else {
                const unit = btn.getAttribute('data-unit');
                const stage = btn.getAttribute('data-stage');
                alert(`進入 ${currentSelectedLevel} 課程 - 單元 ${unit} 階段 ${stage}`);
            }
        };
    });
}

function listenForFriendRequests(uid) {
    if (friendRequestsUnsubscribe) friendRequestsUnsubscribe();

    const db = firebase.firestore();
    friendRequestsUnsubscribe = db.collection('friendRequests')
        .where('toUid', '==', uid)
        .where('status', '==', 'pending')
        .onSnapshot(snapshot => {
            const badge = document.getElementById('profile-notif-badge');
            const pendingRequests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            if (badge) {
                if (pendingRequests.length > 0) badge.classList.remove('hidden');
                else badge.classList.add('hidden');
            }

            renderPendingFriendRequests(pendingRequests);
        }, err => {
            console.error("監聽好友邀請失敗:", err);
        });
    function renderPendingFriendRequests(requests) {
    const container = document.getElementById('pending-friend-requests-container');
    if (!container) return;

    if (!requests || requests.length === 0) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');
    container.innerHTML = requests.map(req => `
        <div class="friend-request-card">
            <div style="font-size:0.88rem; font-weight:bold; color:#1f2937;">
                <i class="fa-solid fa-user-clock" style="color:var(--duo-blue);"></i> ${req.fromNickname} 邀請您成為好友
            </div>
            <div style="font-size:0.78rem; color:#6b7280;">(${req.fromEmail})</div>
            <div style="display:flex; gap:8px; margin-top:6px;">
                <button class="btn-3d btn-3d-primary btn-accept-req" data-id="${req.id}" data-from="${req.fromUid}" style="padding:4px 10px; font-size:0.8rem !important;">接受</button>
                <button class="btn-3d btn-3d-secondary btn-reject-req" data-id="${req.id}" style="padding:4px 10px; font-size:0.8rem !important;">拒絕</button>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.btn-accept-req').forEach(btn => {
        btn.onclick = () => {
            const reqId = btn.getAttribute('data-id');
            const fromUid = btn.getAttribute('data-from');
            acceptFriendRequest(reqId, fromUid);
        };
    });

    container.querySelectorAll('.btn-reject-req').forEach(btn => {
        btn.onclick = () => {
            const reqId = btn.getAttribute('data-id');
            rejectFriendRequest(reqId);
        };
    });
}

async function acceptFriendRequest(requestId, fromUid) {
    try {
        const db = firebase.firestore();
        const batch = db.batch();

        const reqRef = db.collection('friendRequests').doc(requestId);
        batch.update(reqRef, { status: 'accepted', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

        const myFriendRef = db.collection('members').doc(currentMemberData.uid).collection('friends').doc(fromUid);
        batch.set(myFriendRef, { uid: fromUid, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

        const targetFriendRef = db.collection('members').doc(fromUid).collection('friends').doc(currentMemberData.uid);
        batch.set(targetFriendRef, { uid: currentMemberData.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

        await batch.commit();
        alert('已成功新增好友！');
        fetchFriendsList(currentMemberData.uid);
    } catch (err) {
        console.error('接受好友邀請失敗:', err);
        alert('操作失敗，請重新試一次。');
    }
}

async function rejectFriendRequest(requestId) {
    try {
        const db = firebase.firestore();
        await db.collection('friendRequests').doc(requestId).update({
            status: 'rejected',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert('已拒絕好友邀請。');
    } catch (err) {
        console.error('拒絕好友邀請失敗:', err);
    }
}

async function fetchFriendsList(uid) {
    const container = document.getElementById('friends-list-container');
    if (!container) return;

    try {
        const db = firebase.firestore();
        const friendsSnap = await db.collection('members').doc(uid).collection('friends').get();

        if (friendsSnap.empty) {
            renderFriendsList([]);
            return;
        }

        const friendUids = friendsSnap.docs.map(doc => doc.id);
        const friendPromises = friendUids.map(fUid => db.collection('members').doc(fUid).get());
        const friendDocs = await Promise.all(friendPromises);

        const friendsData = friendDocs
            .filter(doc => doc.exists)
            .map(doc => doc.data());

        renderFriendsList(friendsData);
    } catch (err) {
        console.error('讀取好友列表失敗:', err);
    }
}

function renderFriendsList(friends) {
    const container = document.getElementById('friends-list-container');
    if (!container) return;

    if (!friends || friends.length === 0) {
        container.innerHTML = `<span style="font-size:0.85rem; color:#9ca3af; text-align:center; padding:10px;">目前尚無好友，快點擊上方「新增好友」吧！</span>`;
        return;
    }

    // 依據 XP 排序好友
    friends.sort((a, b) => (b.xp || 0) - (a.xp || 0));

    container.innerHTML = friends.map((f, index) => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#ffffff; padding:10px 14px; border-radius:12px; border:1px solid #e5e7eb;">
            <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-weight:bold; color:${index === 0 ? 'var(--duo-gold)' : '#6b7280'}; width:18px;">${index + 1}</span>
                <img src="${f.photoURL || 'https://placehold.co/36x36'}" style="width:36px; height:36px; border-radius:50%; object-fit:cover;" />
                <div>
                    <div style="font-size:0.88rem; font-weight:bold; color:#1f2937;">${f.nickname || '學生'}</div>
                    <div style="font-size:0.75rem; color:#9ca3af;">連續 ${f.streak || 1} 天</div>
                </div>
            </div>
            <div style="font-size:0.88rem; font-weight:bold; color:var(--duo-gold);">
                <i class="fa-solid fa-star"></i> ${f.xp || 0}
            </div>
        </div>
    `).join('');
}

async function fetchGlobalLeaderboard(courseLevel) {
    const container = document.getElementById('content-rank-global');
    const levelLbl = document.getElementById('lbl-global-rank-level');
    if (levelLbl) levelLbl.innerText = courseLevel;

    if (!container) return;

    try {
        const db = firebase.firestore();
        const topSnap = await db.collection('members')
            .where('lastLevel', '==', courseLevel)
            .orderBy('xp', 'desc')
            .limit(20)
            .get();

        if (topSnap.empty) {
            container.innerHTML = `<p style="font-size: 0.9rem; color: #6b7280; margin: 10px 0;">該程度尚無排行紀錄</p>`;
            return;
        }

        const topUsers = topSnap.docs.map(doc => doc.data());
        container.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:8px; text-align:left;">
                ${topUsers.map((u, idx) => `
                    <div style="display:flex; justify-content:space-between; align-items:center; background:#ffffff; padding:10px 14px; border-radius:12px; border:1px solid #e5e7eb;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <span style="font-weight:bold; color:${idx === 0 ? 'var(--duo-gold)' : '#6b7280'}; width:20px;">${idx + 1}</span>
                            <img src="${u.photoURL || 'https://placehold.co/36x36'}" style="width:36px; height:36px; border-radius:50%; object-fit:cover;" />
                            <span style="font-size:0.88rem; font-weight:bold; color:#1f2937;">${u.nickname || '匿名學生'}</span>
                        </div>
                        <span style="font-size:0.88rem; font-weight:bold; color:var(--duo-gold);"><i class="fa-solid fa-star"></i> ${u.xp || 0}</span>
                    </div>
                `).join('')}
            </div>
        `;
    } catch (err) {
        console.error('讀取全球排行榜失敗:', err);
        container.innerHTML = `<p style="font-size: 0.85rem; color: var(--duo-red); margin: 10px 0;">全球排行榜載入失敗</p>`;
    }
}

// 🎯 全域安全事件綁定 Helper（加入問題 B 除錯輸出）
function bindClick(elementId, handler) {
    const el = document.getElementById(elementId);
    if (el) {
        el.onclick = handler;
        console.log(`✅ [DEBUG] 按鈕事件綁定成功: ID = "${elementId}"`);
    } else {
        console.error(`❌ [DEBUG] 按鈕事件綁定失敗 (找不到 DOM 元素): ID = "${elementId}"`);
    }
}

function setupEvents() {
    console.log("🔍 [DEBUG] setupEvents() 被呼叫執行，當前 readyState =", document.readyState);

    bindClick('btn-google-login', handleGoogleLogin);

    bindClick('btn-save-initial-nickname', async () => {
        const inputEl = document.getElementById('input-setup-nickname');
        const input = inputEl ? inputEl.value.trim() : '';
        const errDiv = document.getElementById('nickname-error-msg');

        if (!validateNickname(input)) {
            if (errDiv) {
                errDiv.innerText = "❌ 暱稱需為 2~12 字，僅能包含中文、英文、韓文及數字！";
                errDiv.classList.remove('hidden');
            }
            return;
        }

        const db = firebase.firestore();
        const existing = await db.collection('members').where('nickname', '==', input).get();
        if (!existing.empty) {
            if (errDiv) {
                errDiv.innerText = "❌ 此暱稱已被其他人使用，請換一個！";
                errDiv.classList.remove('hidden');
            }
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
        currentMemberData.lastNicknameChange = today;

        document.getElementById('modal-setup-nickname')?.classList.add('hidden');
        launchMainApp();
    });

    bindClick('btn-save-nickname', async () => {
        const inputEl = document.getElementById('input-edit-nickname');
        const input = inputEl ? inputEl.value.trim() : '';
        const errDiv = document.getElementById('edit-nickname-error-msg');

        if (!canChangeNickname(currentMemberData?.lastNicknameChange)) {
            if (errDiv) {
                errDiv.innerText = "❌ 暱稱一年僅能修改一次，目前尚未滿足修改冷卻時間！";
                errDiv.classList.remove('hidden');
            }
            return;
        }

        if (!validateNickname(input)) {
            if (errDiv) {
                errDiv.innerText = "❌ 暱稱需為 2~12 字，僅能包含中文、英文、韓文及數字！";
                errDiv.classList.remove('hidden');
            }
            return;
        }

        const db = firebase.firestore();
        const existing = await db.collection('members').where('nickname', '==', input).get();
        if (!existing.empty && input !== currentMemberData.nickname) {
            if (errDiv) {
                errDiv.innerText = "❌ 此暱稱已被其他人使用！";
                errDiv.classList.remove('hidden');
            }
            return;
        }

        const today = new Date().toISOString().split('T')[0];
        await db.collection('members').doc(currentMemberData.uid).update({
            nickname: input,
            lastNicknameChange: today
        });

        currentMemberData.nickname = input;
        currentMemberData.lastNicknameChange = today;

        document.getElementById('modal-edit-nickname')?.classList.add('hidden');
        updateHomeMetaBar();
        updateProfileView();
    });

    bindClick('btn-profile-trigger', () => {
        document.getElementById('map-view')?.classList.add('hidden');
        document.getElementById('profile-view')?.classList.remove('hidden');
        updateProfileView();
    });

    bindClick('btn-level-trigger', () => {
        document.getElementById('modal-select-initial-level')?.classList.remove('hidden');
    });

    bindClick('btn-close-level-modal', () => {
        document.getElementById('modal-select-initial-level')?.classList.add('hidden');
    });

    bindClick('btn-confirm-initial-level', () => {
        const select = document.getElementById('initial-level-select');
        if (select) {
            currentSelectedLevel = select.value;
            updateHomeMetaBar();
            renderCourseMap();
        }
        document.getElementById('modal-select-initial-level')?.classList.add('hidden');
    });

    bindClick('btn-profile-back-map', () => {
        document.getElementById('profile-view')?.classList.add('hidden');
        document.getElementById('map-view')?.classList.remove('hidden');
    });

    bindClick('btn-view-leaderboard', () => {
        document.getElementById('btn-view-leaderboard')?.classList.add('active');
        document.getElementById('btn-view-profile')?.classList.remove('active');
        document.getElementById('sub-page-leaderboard')?.classList.remove('hidden');
        document.getElementById('sub-page-profile')?.classList.add('hidden');
    });

    bindClick('btn-view-profile', () => {
        document.getElementById('btn-view-profile')?.classList.add('active');
        document.getElementById('btn-view-leaderboard')?.classList.remove('active');
        document.getElementById('sub-page-profile')?.classList.remove('hidden');
        document.getElementById('sub-page-leaderboard')?.classList.add('hidden');
        updateProfileView();
    });

    bindClick('btn-open-edit-nickname', () => {
        const inputEl = document.getElementById('input-edit-nickname');
        if (inputEl) inputEl.value = currentMemberData?.nickname || '';
        document.getElementById('modal-edit-nickname')?.classList.remove('hidden');
    });
    bindClick('btn-cancel-nickname', () => {
        document.getElementById('modal-edit-nickname')?.classList.add('hidden');
    });

    bindClick('btn-open-add-friend', () => {
        document.getElementById('modal-add-friend')?.classList.remove('hidden');
    });
    bindClick('btn-cancel-add-friend', () => {
        document.getElementById('modal-add-friend')?.classList.add('hidden');
    });

    bindClick('btn-close-locked-modal', () => {
        document.getElementById('modal-locked')?.classList.add('hidden');
    });

    bindClick('btn-trigger-logout', () => {
        document.getElementById('modal-logout-confirm')?.classList.remove('hidden');
    });
    bindClick('btn-logout-no', () => {
        document.getElementById('modal-logout-confirm')?.classList.add('hidden');
    });
    bindClick('btn-logout-yes', async () => {
        try {
        await firebase.auth().signOut();
        currentUser = null;
        currentMemberData = null;
        userMemberships = [];
        // 強制重新整理並清空 Session 快取
        window.location.href = window.location.pathname; 
    } catch (err) {
        console.error("登出失敗:", err);
    }
    });
    // 綁定發送好友邀請事件
    bindClick('btn-submit-add-friend', async () => {
        const inputEl = document.getElementById('input-friend-id');
        const friendEmail = inputEl ? inputEl.value.trim() : '';
        if (!friendEmail) {
            alert('請輸入好友的 Email！');
            return;
        }
        if (friendEmail === currentMemberData.email) {
            alert('不能新增自己為好友！');
            return;
        }

        try {
            const db = firebase.firestore();
            const targetSnap = await db.collection('members').where('email', '==', friendEmail).get();
            if (targetSnap.empty) {
                alert('找不到該 Email 的使用者！');
                return;
            }

            const targetUserDoc = targetSnap.docs[0];
            const targetUserData = targetUserDoc.data();

            await db.collection('friendRequests').add({
                fromUid: currentMemberData.uid,
                fromEmail: currentMemberData.email,
                fromNickname: currentMemberData.nickname || '學生',
                toUid: targetUserData.uid,
                status: 'pending',
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            alert('好友邀請已成功發送！');
            if (inputEl) inputEl.value = '';
            document.getElementById('modal-add-friend')?.classList.add('hidden');
        } catch (err) {
            console.error('發送好友邀請失敗:', err);
            alert('發送好友邀請失敗，請稍後再試。');
        }
    });

    // 綁定排行榜頁籤切換事件
    bindClick('tab-leaderboard-friends', () => {
        document.getElementById('tab-leaderboard-friends')?.classList.add('active');
        document.getElementById('tab-leaderboard-global')?.classList.remove('active');
        document.getElementById('content-rank-friends')?.classList.remove('hidden');
        document.getElementById('content-rank-global')?.classList.add('hidden');
        fetchFriendsList(currentMemberData.uid);
    });

    bindClick('tab-leaderboard-global', () => {
        document.getElementById('tab-leaderboard-global')?.classList.add('active');
        document.getElementById('tab-leaderboard-friends')?.classList.remove('active');
        document.getElementById('content-rank-global')?.classList.remove('hidden');
        document.getElementById('content-rank-friends')?.classList.add('hidden');
        fetchGlobalLeaderboard(currentSelectedLevel);
    });
}

firebase.auth().onAuthStateChanged(async (user) => {
    console.log("🔍 [DEBUG] onAuthStateChanged 觸發, user =", user ? user.uid : null);
    if (user) {
        currentUser = user;
        const db = firebase.firestore();
        const docSnap = await db.collection('members').doc(user.uid).get();

        if (docSnap.exists) {
            currentMemberData = docSnap.data();
            const shipsSnap = await db.collection('memberships').where('uid', '==', user.uid).get();
            userMemberships = shipsSnap.docs.map(doc => doc.data());

            if (!currentMemberData.profileCompleted || !currentMemberData.nickname) {
                document.getElementById('modal-setup-nickname')?.classList.remove('hidden');
            } else {
                launchMainApp();
            }
        } else {
            document.getElementById('login-modal')?.classList.remove('hidden');
            document.getElementById('main-app')?.classList.add('hidden');
        }
    } else {
        document.getElementById('login-modal')?.classList.remove('hidden');
        document.getElementById('main-app')?.classList.add('hidden');
    }
});

// 執行事件綁定
setupEvents();
