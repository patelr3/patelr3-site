import { useState, useEffect, createContext } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Navbar from "./components/Navbar";
import HomePage from "./pages/HomePage";
import AboutMe from "./pages/AboutMe";
import Dashboard from "./pages/Dashboard";
import SignIn from "./pages/SignIn";
import ServicePage from "./pages/ServicePage";
import AdminPanel from "./pages/AdminPanel";
import Account from "./pages/Account";
import ResetPassword from "./pages/ResetPassword";
import api from "./api";

export const UserContext = createContext(null);

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(api.authMe(), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.authenticated) setUser(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = async () => {
    await fetch(api.authLogout(), { credentials: "include" });
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
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route
              path="/admin"
              element={user?.role === "admin" ? <AdminPanel user={user} /> : <Navigate to="/" />}
            />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
          <footer className="site-footer">
            <p>Contact: <a href="mailto:arayosunrp@gmail.com">arayosunrp@gmail.com</a></p>
          </footer>
        </div>
      </BrowserRouter>
    </UserContext.Provider>
  );
}
