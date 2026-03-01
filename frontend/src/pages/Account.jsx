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

  // Debug mode
  const [debugMode, setDebugMode] = useState(false);
  const [debugSaving, setDebugSaving] = useState(false);

  useEffect(() => {
    fetch(api.account(), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        setAccount(data);
        if (data?.debugMode != null) setDebugMode(data.debugMode);
      })
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

  const handleDebugToggle = async () => {
    setDebugSaving(true);
    try {
      const res = await fetch(api.debugMode(), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled: !debugMode }),
      });
      if (res.ok) {
        const data = await res.json();
        setDebugMode(data.debugMode);
      }
    } catch {
      // Revert on error — state unchanged
    } finally {
      setDebugSaving(false);
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

      <div className="account-card" style={{ marginTop: "1.5rem" }}>
        <h3>Developer Settings</h3>
        <div className="account-field" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <label style={{ fontWeight: 600 }}>Debug Mode</label>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "var(--text-muted, #888)" }}>
              When enabled, full chat message content is included in application telemetry for debugging. Disabled by default for privacy.
            </p>
          </div>
          <button
            onClick={handleDebugToggle}
            disabled={debugSaving}
            className={`debug-toggle ${debugMode ? "debug-on" : "debug-off"}`}
            style={{
              minWidth: "60px",
              padding: "0.4rem 0.8rem",
              borderRadius: "6px",
              border: "1px solid var(--border, #333)",
              cursor: debugSaving ? "wait" : "pointer",
              fontWeight: 600,
              fontSize: "0.85rem",
              background: debugMode ? "var(--accent, #4caf50)" : "var(--bg-card, #1e1e1e)",
              color: debugMode ? "#fff" : "var(--text-muted, #888)",
            }}
          >
            {debugSaving ? "…" : debugMode ? "ON" : "OFF"}
          </button>
        </div>
      </div>
    </div>
  );
}
