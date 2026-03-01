import { useState, useEffect, createContext } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";
import Navbar from "./components/Navbar";
import HomePage from "./pages/HomePage";
import AboutMe from "./pages/AboutMe";
import Dashboard from "./pages/Dashboard";
import SignIn from "./pages/SignIn";
import ServicePage from "./pages/ServicePage";
import AdminPanel from "./pages/AdminPanel";
import Account from "./pages/Account";
import ResetPassword from "./pages/ResetPassword";
import SunnieAI from "./pages/SunnieAI";
import api from "./api";

export const UserContext = createContext(null);

// Get fresh Firebase ID token for API calls
export async function getIdToken() {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

// Authenticated fetch helper
export async function authFetch(url, options = {}) {
  const token = await getIdToken();
  if (!token) throw new Error("Not authenticated");
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // Fetch user profile from our backend (which upserts the user)
        try {
          const token = await firebaseUser.getIdToken();
          const res = await fetch(api.authMe(), {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const data = await res.json();
            setUser(data);
          } else {
            setUser(null);
          }
        } catch {
          setUser(null);
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleLogout = async () => {
    const { signOut } = await import("firebase/auth");
    await signOut(auth);
    setUser(null);
  };

  const handleSignInSuccess = (data) => {
    setUser(data);
  };

  if (loading) return null;

  return (
    <UserContext.Provider value={user}>
      <BrowserRouter>
        <div className="app">
          <Navbar user={user} onLogout={handleLogout} />
          <Routes>
            <Route path="/" element={<HomePage user={user} />} />
            <Route path="/about" element={<AboutMe />} />
            <Route
              path="/signin"
              element={
                user ? <Navigate to="/dashboard" /> : <SignIn onSuccess={handleSignInSuccess} />
              }
            />
            <Route
              path="/dashboard"
              element={user ? <Dashboard user={user} /> : <Navigate to="/signin" />}
            />
            <Route
              path="/services/:slug"
              element={user ? <ServicePage user={user} /> : <Navigate to="/signin" />}
            />
            <Route
              path="/account"
              element={user ? <Account user={user} /> : <Navigate to="/signin" />}
            />
            <Route
              path="/sunnieai"
              element={user ? <SunnieAI /> : <Navigate to="/signin" />}
            />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route
              path="/admin"
              element={user?.role === "admin" ? <AdminPanel user={user} /> : <Navigate to="/" />}
            />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
          <footer className="site-footer">
            <p>Contact: <a href="mailto:arayosunrp@gmail.com">arayosunrp@gmail.com</a></p>
            <p><a href="https://github.com/patelr3/patelr3-site" target="_blank" rel="noopener noreferrer">View source on GitHub ↗</a></p>
          </footer>
        </div>
      </BrowserRouter>
    </UserContext.Provider>
  );
}
