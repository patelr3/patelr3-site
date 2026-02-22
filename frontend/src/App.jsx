import { useState, useEffect } from "react";
import Navbar from "./components/Navbar";
import AboutMe from "./pages/AboutMe";
import Dashboard from "./pages/Dashboard";
import SignIn from "./pages/SignIn";
import api from "./api";

export default function App() {
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState("about");

  useEffect(() => {
    fetch(api.authMe(), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.authenticated) setUser(data);
      })
      .catch(() => {});
  }, []);

  const handleLogout = async () => {
    await fetch(api.authLogout(), { credentials: "include" });
    setUser(null);
    setTab("about");
  };

  const handleSignInSuccess = (data) => {
    setUser(data);
    setTab("dashboard");
  };

  return (
    <div className="app">
      <Navbar user={user} tab={tab} setTab={setTab} onLogout={handleLogout} />
      {tab === "about" && <AboutMe />}
      {tab === "signin" && <SignIn onSuccess={handleSignInSuccess} />}
      {tab === "dashboard" && <Dashboard user={user} />}
    </div>
  );
}
