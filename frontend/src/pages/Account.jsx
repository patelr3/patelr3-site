import { useState, useEffect } from "react";
import api from "../api";

export default function Account({ user }) {
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);

  // Change password
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [pwErr, setPwErr] = useState("");

  useEffect(() => {
    fetch(api.account(), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setAccount)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwMsg("");
    setPwErr("");

    if (newPw !== confirmPw) {
      setPwErr("Passwords do not match");
      return;
    }

    const body = { newPassword: newPw };
    if (account?.hasPassword) body.currentPassword = currentPw;

    const res = await fetch(api.changePassword(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      setPwMsg("Password updated successfully");
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      // Update account state to reflect password now exists
      setAccount((a) => ({ ...a, hasPassword: true }));
    } else {
      setPwErr(data.error || "Failed to change password");
    }
  };

  if (loading) return <div className="page"><p>Loading…</p></div>;
  if (!account) return <div className="page"><p>Could not load account.</p></div>;

  return (
    <div className="page account-page">
      <h2>Account</h2>

      <div className="account-card">
        <div className="account-field">
          <label>Email</label>
          <span>{account.email}</span>
        </div>
        <div className="account-field">
          <label>Display Name</label>
          <span>{account.displayName}</span>
        </div>
        <div className="account-field">
          <label>Role</label>
          <span className={`role-badge role-${account.role}`}>{account.role}</span>
        </div>
        <div className="account-field">
          <label>Member Since</label>
          <span>{new Date(account.createdAt).toLocaleDateString()}</span>
        </div>
        {account.isGoogleUser && (
          <div className="account-field">
            <label>Sign-in Method</label>
            <span className="auth-badge auth-google">Google OAuth</span>
          </div>
        )}
      </div>

      {account.isGoogleUser && !account.hasPassword ? null : (
        <div className="account-card" style={{ marginTop: "1.5rem" }}>
          <h3>{account.hasPassword ? "Change Password" : "Set Password"}</h3>
          <form onSubmit={handleChangePassword} className="pw-form">
            {account.hasPassword && (
              <label>
                Current Password
                <input
                  type="password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  required
                />
              </label>
            )}
            <label>
              New Password
              <input
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                required
                minLength={8}
                placeholder="Min 8 characters"
              />
            </label>
            <label>
              Confirm New Password
              <input
                type="password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                required
                minLength={8}
              />
            </label>
            {pwErr && <p className="signin-error">{pwErr}</p>}
            {pwMsg && <p className="pw-success">{pwMsg}</p>}
            <button type="submit" className="signin-submit">
              {account.hasPassword ? "Update Password" : "Set Password"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
