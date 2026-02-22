import { NavLink, useNavigate } from "react-router-dom";

export default function Navbar({ user, onLogout }) {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await onLogout();
    navigate("/");
  };

  return (
    <nav>
      <span className="brand">patelr3</span>

      <NavLink to="/" className={({ isActive }) => `tab ${isActive ? "active" : ""}`} end>
        About Me
      </NavLink>

      {user && (
        <NavLink to="/dashboard" className={({ isActive }) => `tab ${isActive ? "active" : ""}`}>
          Dashboard
        </NavLink>
      )}

      {user?.role === "admin" && (
        <NavLink to="/admin" className={({ isActive }) => `tab ${isActive ? "active" : ""}`}>
          Admin
        </NavLink>
      )}

      {user ? (
        <>
          <span className="user-info">{user.name}</span>
          <button className="logout-btn" onClick={handleLogout}>
            Logout
          </button>
        </>
      ) : (
        <NavLink to="/signin" className="login-btn">
          Sign In
        </NavLink>
      )}
    </nav>
  );
}
