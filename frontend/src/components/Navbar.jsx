import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";

export default function Navbar({ user, onLogout }) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLogout = async () => {
    setMenuOpen(false);
    await onLogout();
    navigate("/");
  };

  const handleNavClick = () => setMenuOpen(false);

  return (
    <nav>
      <span className="brand">patelr3</span>
      <button className="hamburger" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">
        {menuOpen ? "✕" : "☰"}
      </button>

      <div className={`nav-links ${menuOpen ? "open" : ""}`}>
        <NavLink to="/" className={({ isActive }) => `tab ${isActive ? "active" : ""}`} end onClick={handleNavClick}>
          Home
        </NavLink>
        <NavLink to="/about" className={({ isActive }) => `tab ${isActive ? "active" : ""}`} onClick={handleNavClick}>
          About Me
        </NavLink>

        {user && (
          <NavLink to="/dashboard" className={({ isActive }) => `tab ${isActive ? "active" : ""}`} onClick={handleNavClick}>
            Dashboard
          </NavLink>
        )}

        {user?.role === "admin" && (
          <NavLink to="/admin" className={({ isActive }) => `tab ${isActive ? "active" : ""}`} onClick={handleNavClick}>
            Admin
          </NavLink>
        )}

        {user ? (
          <>
            <NavLink to="/account" className={({ isActive }) => `user-name-link ${isActive ? "active" : ""}`} onClick={handleNavClick}>
              {user.name}
            </NavLink>
            <button className="logout-btn" onClick={handleLogout}>
              Logout
            </button>
          </>
        ) : (
          <NavLink to="/signin" className="login-btn" onClick={handleNavClick}>
            Sign In
          </NavLink>
        )}
      </div>
    </nav>
  );
}
