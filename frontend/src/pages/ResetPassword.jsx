import { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import api from "../api";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token");

  // Forgot password (request reset)
  const [email, setEmail] = useState("");
  const [reqMsg, setReqMsg] = useState("");

  // Reset password (use token)
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [resetMsg, setResetMsg] = useState("");
  const [resetErr, setResetErr] = useState("");

  const handleForgot = async (e) => {
    e.preventDefault();
    const res = await fetch(api.forgotPassword(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email }),
    });
    if (res.ok) {
      const data = await res.json();
      setReqMsg(data.resetUrl
        ? `Reset link generated. Check console or use: ${data.resetUrl}`
        : "If that email exists, a reset link has been generated.");
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setResetErr("");
    if (newPw !== confirmPw) {
      setResetErr("Passwords do not match");
      return;
    }
    const res = await fetch(api.resetPassword(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token, newPassword: newPw }),
    });
    const data = await res.json();
    if (res.ok) {
      setResetMsg("Password has been reset. Redirecting to sign in…");
      setTimeout(() => navigate("/signin"), 2000);
    } else {
      setResetErr(data.error || "Reset failed");
    }
  };

  return (
    <div className="page signin-page">
      <div className="signin-card">
        {token ? (
          <>
            <h2>Reset Password</h2>
            <form onSubmit={handleReset}>
              <label>
                New Password
                <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)}
                  required minLength={8} placeholder="Min 8 characters" />
              </label>
              <label>
                Confirm Password
                <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)}
                  required minLength={8} />
              </label>
              {resetErr && <p className="signin-error">{resetErr}</p>}
              {resetMsg && <p className="pw-success">{resetMsg}</p>}
              <button type="submit" className="signin-submit">Reset Password</button>
            </form>
          </>
        ) : (
          <>
            <h2>Forgot Password</h2>
            <p className="signin-subtitle">Enter your email to receive a password reset link.</p>
            <form onSubmit={handleForgot}>
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  required placeholder="you@example.com" />
              </label>
              {reqMsg && <p className="pw-success">{reqMsg}</p>}
              <button type="submit" className="signin-submit">Send Reset Link</button>
            </form>
            <p className="signin-toggle">
              <button type="button" onClick={() => navigate("/signin")}>Back to Sign In</button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
