import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc,
  collection, query, where, getDocs, addDoc, onSnapshot,
  orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ⚠️ 修正：原本此處為預留字串 (YOUR_API_KEY...)，Firestore 永遠無法連線。
// 已改為與 js/firebase-config.js 相同的實際專案設定（同一個 Firebase 專案）。
const firebaseConfig = {
  apiKey: "AIzaSyAp5Le7hrYQDicV2SqUyJFDEO2dmlqbSkc",
  authDomain: "koreangame-b33a0.firebaseapp.com",
  projectId: "koreangame-b33a0",
  storageBucket: "koreangame-b33a0.firebasestorage.app",
  messagingSenderId: "390133595067",
  appId: "1:390133595067:web:552047a19871b89d36a29e",
  measurementId: "G-0DGW1TVJBQ"
};

// 初始化 Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

/* =========================================================
 * 🗂️ 舊版 Users Collection（沿用，供舊功能相容使用）
 * 欄位：allowedLevel, allowedLevels, energy, expireAt, currentCourse,
 *       currentLevel, level, nickname, realName, role, status, streak,
 *       points, xp, friends, friendRequests, loginHistory,
 *       maxUnlockedUnit, maxUnlockedStage, leitnerBoxes
 * 注意：Collection 名稱為 "Users"（大寫開頭），原始程式碼誤寫成小寫
 * "users" 導致從未真正命中過集合，此處修正為正確名稱（非新建集合）。
 * ========================================================= */
export async function getUserData(uid) {
  try {
    const userDocRef = doc(db, "Users", uid);
    const docSnap = await getDoc(userDocRef);
    if (docSnap.exists()) {
      return docSnap.data();
    } else {
      return null;
    }
  } catch (error) {
    console.error("讀取使用者資料失敗 (Users):", error);
    return null;
  }
}

export async function saveUserData(uid, data) {
  try {
    const userDocRef = doc(db, "Users", uid);
    await setDoc(userDocRef, data, { merge: true });
  } catch (error) {
    console.error("儲存使用者資料失敗 (Users):", error);
  }
}

// 新增：原本 app.js 呼叫的 updateUserData 從未被匯出過（會造成
// TypeError: FirestoreService.updateUserData is not a function）。
// 此為新增函式，行為與 saveUserData 相同（merge 寫入），僅補齊缺漏，不覆蓋原函式。
export async function updateUserData(uid, data) {
  return saveUserData(uid, data);
}

/* =========================================================
 * 🗂️ Members Collection（新版主要資料來源）
 * 欄位：uid, email, nickname, realName, photoURL, role, status,
 *       profileCompleted, xp, streak, lastLoginDate, lastNicknameChange,
 *       lastCourseId, lastLevel, lastLesson, lastUnit, lastStage,
 *       createdAt, updatedAt
 * ========================================================= */
export async function getMember(uid) {
  try {
    const ref = doc(db, "Members", uid);
    const snap = await getDoc(ref);
    return snap.exists() ? snap.data() : null;
  } catch (error) {
    console.error("讀取 Members 失敗:", error);
    return null;
  }
}

export async function saveMember(uid, data) {
  try {
    const ref = doc(db, "Members", uid);
    await setDoc(ref, data, { merge: true });
  } catch (error) {
    console.error("寫入 Members 失敗:", error);
  }
}

export async function updateMember(uid, data) {
  return saveMember(uid, data);
}

export async function getMemberByEmail(email) {
  try {
    const q = query(collection(db, "Members"), where("email", "==", email), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
  } catch (error) {
    console.error("依 Email 查詢 Members 失敗:", error);
    return null;
  }
}

// 全球排行榜：依 Members 讀取，交由 app.js 依 XP → Streak → 完成課程數排序
export async function getGlobalLeaderboard(topN = 50) {
  try {
    const q = query(collection(db, "Members"), orderBy("xp", "desc"), limit(topN));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (error) {
    console.error("讀取全球排行榜失敗:", error);
    return [];
  }
}

/* =========================================================
 * 🗂️ Memberships Collection
 * 欄位：uid, courseId, expireDate, purchaseDate, status, source, updatedAt
 * ========================================================= */
export async function getMemberships(uid) {
  try {
    const q = query(collection(db, "Memberships"), where("uid", "==", uid));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (error) {
    console.error("讀取 Memberships 失敗:", error);
    return [];
  }
}

// 新增或更新單筆課程權限（依 uid+courseId 找現有文件，避免重複建立）
export async function upsertMembership(uid, courseId, data) {
  try {
    const q = query(
      collection(db, "Memberships"),
      where("uid", "==", uid),
      where("courseId", "==", courseId)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      const existing = snap.docs[0];
      await setDoc(doc(db, "Memberships", existing.id), data, { merge: true });
      return existing.id;
    } else {
      const newDoc = await addDoc(collection(db, "Memberships"), data);
      return newDoc.id;
    }
  } catch (error) {
    console.error("寫入 Memberships 失敗:", error);
    return null;
  }
}

/* =========================================================
 * 🗂️ friendRequests Collection（Top-level）
 * 欄位：fromUid, fromEmail, fromNickname, toUid, status, createdAt, updatedAt
 * status: pending / accepted / rejected
 * ========================================================= */
export async function findExistingRequest(uidA, uidB) {
  try {
    // 檢查 A→B 或 B→A 是否已經有 pending 邀請
    const q1 = query(
      collection(db, "friendRequests"),
      where("fromUid", "==", uidA), where("toUid", "==", uidB), where("status", "==", "pending")
    );
    const q2 = query(
      collection(db, "friendRequests"),
      where("fromUid", "==", uidB), where("toUid", "==", uidA), where("status", "==", "pending")
    );
    const [s1, s2] = await Promise.all([getDocs(q1), getDocs(q2)]);
    if (!s1.empty) return { id: s1.docs[0].id, ...s1.docs[0].data() };
    if (!s2.empty) return { id: s2.docs[0].id, ...s2.docs[0].data() };
    return null;
  } catch (error) {
    console.error("檢查好友邀請失敗:", error);
    return null;
  }
}

export async function addFriendRequest({ fromUid, fromEmail, fromNickname, toUid }) {
  const ref = await addDoc(collection(db, "friendRequests"), {
    fromUid, fromEmail, fromNickname: fromNickname || fromEmail,
    toUid, status: "pending",
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
  return ref.id;
}

// 即時監聽「我收到的」待處理邀請
export function listenPendingRequests(uid, callback) {
  const q = query(
    collection(db, "friendRequests"),
    where("toUid", "==", uid),
    where("status", "==", "pending")
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function respondFriendRequest(requestId, accept, meUid, otherUid) {
  const reqRef = doc(db, "friendRequests", requestId);
  await updateDoc(reqRef, { status: accept ? "accepted" : "rejected", updatedAt: serverTimestamp() });
  if (accept) {
    // members/{uid}/friends Subcollection：雙向寫入
    await setDoc(doc(db, "Members", meUid, "friends", otherUid), {
      friendUid: otherUid, addedAt: serverTimestamp()
    }, { merge: true });
    await setDoc(doc(db, "Members", otherUid, "friends", meUid), {
      friendUid: meUid, addedAt: serverTimestamp()
    }, { merge: true });
  }
}

/* =========================================================
 * 🗂️ members/{uid}/friends Subcollection
 * ========================================================= */
export async function isAlreadyFriend(meUid, otherUid) {
  try {
    const ref = doc(db, "Members", meUid, "friends", otherUid);
    const snap = await getDoc(ref);
    return snap.exists();
  } catch (error) {
    console.error("檢查好友關係失敗:", error);
    return false;
  }
}

// 即時監聽好友清單（僅回傳 friendUid 清單，實際資料由呼叫端即時抓取 Members 以確保 XP/Streak 即時）
export function listenFriends(uid, callback) {
  const colRef = collection(db, "Members", uid, "friends");
  return onSnapshot(colRef, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

/* =========================================================
 * 📦 統一服務介面（新增，供 app.js 使用；不覆蓋上方任何既有函式）
 * ========================================================= */
export const FirestoreService = {
  // 舊版 Users
  getUserData, saveUserData, updateUserData,
  // Members
  getMember, saveMember, updateMember, getMemberByEmail, getGlobalLeaderboard,
  // Memberships
  getMemberships, upsertMembership,
  // friendRequests
  findExistingRequest, addFriendRequest, listenPendingRequests, respondFriendRequest,
  // members/{uid}/friends
  isAlreadyFriend, listenFriends
};
