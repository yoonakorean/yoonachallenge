import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { saveUserData, getUserData } from "./firebase.js";

const auth = getAuth();
const googleProvider = new GoogleAuthProvider();

// 預設頭像網址
const DEFAULT_AVATAR = 'https://placehold.co/72x72';

// 1. Google Gmail 快捷登入/註冊
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

// 2. Email 登入
export function loginWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

// 3. Email 註冊
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

// 4. 登出
export function logoutUser() {
  return signOut(auth);
}

// 5. 監聽身份狀態變更
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
