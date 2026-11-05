import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getStorage } from "firebase/storage";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
};

export const SUPERADMIN = (import.meta.env.VITE_SUPERADMIN || "alexgoldenstein@hotmail.com").toLowerCase();
export const configOk = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

export const app = configOk ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
// Caché local: la app abre y muestra datos sin señal, y los cambios se sincronizan al volver la conexión.
export const db = app ? initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }) : null;
export const storage = app ? getStorage(app) : null;

// Segunda instancia: permite que un admin cree usuarios sin cerrar su propia sesión.
let secondary = null;
export function secondaryAuth() {
  if (!configOk) return null;
  if (!secondary) secondary = getAuth(initializeApp(firebaseConfig, "alta-usuarios"));
  return secondary;
}
