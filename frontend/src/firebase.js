import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

// Firebase web config — API key is a public identifier (not a secret).
// In production, injected via VITE_FIREBASE_API_KEY build arg from AKV.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyA0jbPd95nx7Dq26jCpMS95hsmmm4Y7sgk",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "patelr3-site.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "patelr3-site",
  storageBucket: "patelr3-site.firebasestorage.app",
  messagingSenderId: "760650812580",
  appId: "1:760650812580:web:46294fb06373d71e406a31",
  measurementId: "G-0Y295DNE6X",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export default app;
