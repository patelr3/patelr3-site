import { useState, useEffect } from "react";
import api from "../api";

export default function AdminPanel({ user }) {
  const [services, setServices] = useState([]);
  const [requests, setRequests] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const [svcsRes, reqsRes, usersRes] = await Promise.all([
        fetch(api.services(), { credentials: "include" }),
        fetch(api.accessRequests(), { credentials: "include" }),
        fetch(api.users(), { credentials: "include" }),
      ]);
      if (svcsRes.ok) setServices(await svcsRes.json());
      if (reqsRes.ok) setRequests(await reqsRes.json());
      if (usersRes.ok) setUsers(await usersRes.json());
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const toggleField = async (svcId, field, currentValue) => {
    const body = { [field]: !currentValue };
    const res = await fetch(api.serviceUpdate(svcId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (res.ok) fetchData();
  };

  const handleRequest = async (requestId, action) => {
    const url = action === "approve"
      ? api.accessRequestApprove(requestId)
      : api.accessRequestDeny(requestId);
    const res = await fetch(url, { method: "POST", credentials: "include" });
    if (res.ok) fetchData();
  };

  const changeRole = async (userId, newRole) => {
    const res = await fetch(api.userRole(userId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) fetchData();
  };

  if (loading) return <div className="page"><p>Loading…</p></div>;

  return (
    <div className="page admin">
      <h2>Admin Panel</h2>

      <section>
        <h3>User Management</h3>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.display_name}</td>
                <td>
                  <span className={`role-badge role-${u.role}`}>{u.role}</span>
                </td>
                <td>
                  {u.id !== user.sub && u.id !== Number(user.sub) && (
                    <select
                      value={u.role}
                      onChange={(e) => changeRole(u.id, e.target.value)}
                      className="role-select"
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  )}
                  {(u.id === user.sub || u.id === Number(user.sub)) && (
                    <span style={{ color: "#999", fontSize: "0.8rem" }}>You</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h3>Service Management</h3>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Visible</th>
              <th>Restricted</th>
            </tr>
          </thead>
          <tbody>
            {services.map((svc) => (
              <tr key={svc.id}>
                <td>{svc.name}</td>
                <td>
                  <button
                    className={`toggle ${svc.isVisible ? "on" : "off"}`}
                    onClick={() => toggleField(svc.id, "isVisible", svc.isVisible)}
                  >
                    {svc.isVisible ? "Yes" : "No"}
                  </button>
                </td>
                <td>
                  <button
                    className={`toggle ${svc.isRestricted ? "on" : "off"}`}
                    onClick={() => toggleField(svc.id, "isRestricted", svc.isRestricted)}
                  >
                    {svc.isRestricted ? "Yes" : "No"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h3>Pending Access Requests</h3>
        {requests.length === 0 ? (
          <p style={{ color: "#777" }}>No pending requests.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Service</th>
                <th>Requested</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.user_email}</td>
                  <td>{r.service_name}</td>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td className="action-btns">
                    <button className="btn-approve" onClick={() => handleRequest(r.id, "approve")}>
                      Approve
                    </button>
                    <button className="btn-deny" onClick={() => handleRequest(r.id, "deny")}>
                      Deny
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
