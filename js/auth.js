import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  updatePassword,
  signOut,
  onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { saveUserData, getUserData } from "./firebase.js";

const auth = getAuth();
const googleProvider = new GoogleAuthProvider();

// 預設頭像網址
const DEFAULT_AVATAR = 'https://placehold.co/72x72';

// 1. Google Gmail 快捷登入/註冊（原始函式，保留不變，供舊流程相容）
export async function loginWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;
    
    let userData = await getUserData(user.uid);
    if (!userData) {
      userData = {
        email: user.email,
        displayName: user.displayName || user.email.split('@')[0],
        photoURL: user.photoURL || DEFAULT_AVATAR, // 優先使用 Google 頭像，若無則使用預設圖
        language: 'zh-TW',
        permissions: ['0A'] // 預設權限
      };
      await saveUserData(user.uid, userData);
    }
    return user;
  } catch (error) {
    console.error("Google 登入失敗:", error);
    throw error;
  }
}

// 2. Email 登入（原始函式，保留不變）
export function loginWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

// 3. Email 註冊（原始函式，保留不變）
export async function signUpWithEmail(email, password) {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  const user = result.user;
  const userData = {
    email: user.email,
    displayName: user.email.split('@')[0],
    photoURL: DEFAULT_AVATAR, // Email 註冊預設頭像
    language: 'zh-TW',
    permissions: ['0A']
  };
  await saveUserData(user.uid, userData);
  return user;
}

// 4. 登出（原始函式，保留不變）
export function logoutUser() {
  return signOut(auth);
}

// 5. 監聽身份狀態變更（原始函式，保留不變）
export function initAuthListener(onUserChanged) {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      const userData = await getUserData(user.uid);
      onUserChanged(user, userData);
    } else {
      onUserChanged(null, null);
    }
  });
}

/* =========================================================
 * 🆕 新增函式（不修改、不覆蓋上方任何原始函式）
 * 因應「Google／Email 登入成功後統一走 GAS 白名單 → Members →
 * Firestore」的流程需求：Firebase Auth 只負責「登入本身」，
 * 不在這裡直接寫入 Firestore（避免與統一流程重複寫入、資料衝突）。
 * ========================================================= */

// Google 登入（僅回傳 Firebase User，不寫入 Firestore；由 app.js 統一處理）
export async function loginWithGoogleAuth() {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

// Email 註冊（僅建立 Firebase Auth 帳號，不寫入 Firestore；由 app.js 統一處理）
export async function registerWithEmail(email, password) {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return result.user;
}

// 忘記密碼：寄送重設密碼信
export function sendPasswordReset(email) {
  return sendPasswordResetEmail(auth, email);
}

// 修改密碼（需使用者已登入）
export function changePassword(newPassword) {
  if (!auth.currentUser) {
    return Promise.reject(new Error("尚未登入，無法修改密碼"));
  }
  return updatePassword(auth.currentUser, newPassword);
}

// 監聽登入狀態（僅回傳 Firebase User，不預先讀取 Firestore；
// 由 app.js 統一走 GAS 白名單 → Members → Firestore 流程）
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, (user) => {
    callback(user || null);
  });
}

/**
 * GAS 白名單驗證
 * GET https://script.google.com/macros/s/AKfycbw.../exec?email=xxx
 * 成功: { status: "success", member: {...}, memberships: [...] }
 * 失敗: { status: "not_allowed" }
 * 前端不修改此 API 呼叫方式與回傳格式。
 */
const GAS_WHITELIST_URL = "https://script.google.com/macros/s/AKfycbw_M7IruZjeXV70lJb7CoaeRUYKsNus7-_ZsvjM_00I_ovqmo3SmJO6ZE5G54-OGP1H/exec";

export async function checkWhitelist(email) {
  try {
    const res = await fetch(`${GAS_WHITELIST_URL}?email=${encodeURIComponent(email)}`);
    if (!res.ok) {
      throw new Error(`GAS 白名單服務回應異常 (HTTP ${res.status})`);
    }
    const data = await res.json();
    return data; // { status: 'success', member, memberships } 或 { status: 'not_allowed' }
  } catch (error) {
    console.error("GAS 白名單驗證失敗:", error);
    return { status: "error", message: error.message };
  }
}

/* =========================================================
 * 📦 統一服務介面（新增，供 app.js 使用；不覆蓋上方任何既有函式）
 * ========================================================= */
export const AuthService = {
  login: loginWithEmail,
  register: registerWithEmail,
  loginWithGoogle: loginWithGoogleAuth,
  logout: logoutUser,
  onAuthStateChanged: onAuthChange,
  updatePassword: changePassword,
  sendPasswordReset,
  checkWhitelist
};
