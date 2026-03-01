import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { sendPasswordResetEmail } from "firebase/auth";
import { auth } from "../firebase";

export default function ResetPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, email);
      setSent(true);
    } catch (err) {
      setError(err.code === "auth/user-not-found"
        ? "No account found with this email"
        : err.message || "Failed to send reset email");
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="page signin-page">
        <div className="signin-card">
          <h2>Check Your Email</h2>
          <p>We've sent a password reset link to <strong>{email}</strong>.</p>
          <p>Check your inbox and follow the link to reset your password.</p>
          <button className="signin-submit" onClick={() => navigate("/signin")} style={{ marginTop: "1rem" }}>
            Back to Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page signin-page">
      <div className="signin-card">
        <h2>Reset Password</h2>
        <p className="signin-subtitle">Enter your email to receive a password reset link.</p>
        <form onSubmit={handleSubmit}>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>
          {error && <p className="signin-error">{error}</p>}
          <button type="submit" className="signin-submit" disabled={loading}>
            {loading ? "Sending…" : "Send Reset Link"}
          </button>
        </form>
        <p className="signin-toggle">
          <button type="button" onClick={() => navigate("/signin")}>
            Back to Sign In
          </button>
        </p>
      </div>
    </div>
  );
}
