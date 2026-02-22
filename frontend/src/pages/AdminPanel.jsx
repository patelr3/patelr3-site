import { useState, useEffect } from "react";
import api from "../api";

export default function AdminPanel({ user }) {
  const [services, setServices] = useState([]);
  const [requests, setRequests] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  // User management filters
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  // Inline role editing
  const [editingRole, setEditingRole] = useState(null);

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
    if (res.ok) {
      setEditingRole(null);
      fetchData();
    }
  };

  const handleDeleteUser = async (userId, email) => {
    if (!confirm(`Delete account ${email}? This cannot be undone.`)) return;
    const res = await fetch(api.userDelete(userId), {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) fetchData();
  };

  const filteredUsers = users.filter((u) => {
    const matchesSearch = !search ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      (u.display_name || "").toLowerCase().includes(search.toLowerCase());
    const matchesRole = roleFilter === "all" || u.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  const isSelf = (u) => u.id === Number(user.sub);

  if (loading) return <div className="page"><p>Loading…</p></div>;

  return (
    <div className="page admin">
      <h2>Admin Panel</h2>

      <section>
        <h3>User Management</h3>
        <div className="admin-filters">
          <input
            type="text"
            placeholder="Search by email or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="admin-search"
          />
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="role-select"
          >
            <option value="all">All roles</option>
            <option value="admin">admin</option>
            <option value="user">user</option>
          </select>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Last Login</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.display_name}</td>
                <td>
                  {editingRole === u.id ? (
                    <select
                      value={u.role}
                      onChange={(e) => changeRole(u.id, e.target.value)}
                      onBlur={() => setEditingRole(null)}
                      autoFocus
                      className="role-select"
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  ) : (
                    <>
                      <span className={`role-badge role-${u.role}`}>{u.role}</span>
                      {!isSelf(u) && (
                        <button
                          className="edit-btn"
                          onClick={() => setEditingRole(u.id)}
                          title="Edit role"
                        >
                          ✏️
                        </button>
                      )}
                    </>
                  )}
                </td>
                <td className="date-cell">
                  {u.last_login_at
                    ? new Date(u.last_login_at).toLocaleString()
                    : "Never"}
                </td>
                <td>
                  {isSelf(u) ? (
                    <span style={{ color: "#999", fontSize: "0.8rem" }}>You</span>
                  ) : (
                    <button
                      className="btn-deny"
                      onClick={() => handleDeleteUser(u.id, u.email)}
                      title="Delete account"
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {filteredUsers.length === 0 && (
              <tr><td colSpan={5} style={{ color: "#999", textAlign: "center" }}>No users found.</td></tr>
            )}
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
