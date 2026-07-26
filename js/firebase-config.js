// Firebase 組態配置與初始化
const firebaseConfig = {
    apiKey: "AIzaSyAp5Le7hrYQDicV2SqUyJFDEO2dmlqbSkc",
    authDomain: "koreangame-b33a0.firebaseapp.com",
    projectId: "koreangame-b33a0",
    storageBucket: "koreangame-b33a0.firebasestorage.app",
    messagingSenderId: "390133595067",
    appId: "1:390133595067:web:552047a19871b89d36a29e",
    measurementId: "G-0DGW1TVJBQ"
};

try {
    firebase.initializeApp(firebaseConfig);
} catch (error) {
    UI.handleError(error, "Firebase 初始化失敗");
}

const auth = firebase.auth();
const db = firebase.firestore();
