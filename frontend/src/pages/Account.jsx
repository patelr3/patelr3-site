import { useState, useEffect } from "react";
import { authFetch } from "../App";
import api from "../api";

export default function Account({ user }) {
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch(api.account())
      .then((r) => (r.ok ? r.json() : null))
      .then(setAccount)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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
      </div>

      <p className="signin-toggle" style={{ marginTop: "1rem" }}>
        To change your password or manage your sign-in methods, visit your{" "}
        <a href="https://myaccount.google.com/security" target="_blank" rel="noopener noreferrer">
          Google Account settings
        </a>.
      </p>
    </div>
  );
}
