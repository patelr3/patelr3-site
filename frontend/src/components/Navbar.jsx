import api from "../api";

export default function Navbar({ user, tab, setTab, onLogout }) {
  return (
    <nav>
      <span className="brand">patelr3</span>

      <button
        className={`tab ${tab === "about" ? "active" : ""}`}
        onClick={() => setTab("about")}
      >
        About Me
      </button>

      {user && (
        <button
          className={`tab ${tab === "dashboard" ? "active" : ""}`}
          onClick={() => setTab("dashboard")}
        >
          Dashboard
        </button>
      )}

      {user ? (
        <>
          <span className="user-info">{user.name}</span>
          <button className="logout-btn" onClick={onLogout}>
            Logout
          </button>
        </>
      ) : (
        <button className="login-btn" onClick={() => setTab("signin")}>
          Sign In
        </button>
      )}
    </nav>
  );
}
