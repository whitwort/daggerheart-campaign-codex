import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";

export const CONFIG = window.APP_CONFIG;
export const firebaseApp = initializeApp(CONFIG.firebase);
