import React, { useState, useEffect } from "react";
import { authFetch } from "../App";
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
  // Access management
  const [managingAccess, setManagingAccess] = useState(null);
  const [userAccess, setUserAccess] = useState([]);
  const [accessLoading, setAccessLoading] = useState(false);

  const fetchData = async () => {
    try {
      const [svcsRes, reqsRes, usersRes] = await Promise.all([
        authFetch(api.services()),
        authFetch(api.accessRequests()),
        authFetch(api.users()),
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
    const res = await authFetch(api.serviceUpdate(svcId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) fetchData();
  };

  const handleRequest = async (requestId, action) => {
    const url = action === "approve"
      ? api.accessRequestApprove(requestId)
      : api.accessRequestDeny(requestId);
    const res = await authFetch(url, { method: "POST" });
    if (res.ok) fetchData();
  };

  const changeRole = async (userId, newRole) => {
    const res = await authFetch(api.userRole(userId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) {
      setEditingRole(null);
      fetchData();
    }
  };

  const handleDeleteUser = async (userId, email) => {
    if (!confirm(`Delete account ${email}? This cannot be undone.`)) return;
    const res = await authFetch(api.userDelete(userId), {
      method: "DELETE",
    });
    if (res.ok) fetchData();
  };

  const openAccessPanel = async (userId) => {
    if (managingAccess === userId) {
      setManagingAccess(null);
      return;
    }
    setManagingAccess(userId);
    setAccessLoading(true);
    try {
      const res = await authFetch(api.userAccess(userId));
      if (res.ok) setUserAccess(await res.json());
    } catch { /* ignore */ }
    setAccessLoading(false);
  };

  const toggleAccess = async (userId, serviceId, hasAccess) => {
    if (hasAccess) {
      await authFetch(api.userAccessRevoke(userId, serviceId), { method: "DELETE" });
    } else {
      await authFetch(api.userAccess(userId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId }),
      });
    }
    // Refresh access list
    const res = await authFetch(api.userAccess(userId));
    if (res.ok) setUserAccess(await res.json());
  };

  const restrictedServices = services.filter((s) => s.isRestricted);

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
        <div className="admin-table-wrap">
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
              <React.Fragment key={u.id}>
              <tr>
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
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
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
                    <div className="action-btns">
                      <button
                        className={`btn-secondary${managingAccess === u.id ? " active" : ""}`}
                        onClick={() => openAccessPanel(u.id)}
                        title="Manage service access"
                      >
                        🔑 Access
                      </button>
                      <button
                        className="btn-deny"
                        onClick={() => handleDeleteUser(u.id, u.email)}
                        title="Delete account"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </td>
              </tr>
              {managingAccess === u.id && (
                <tr key={`${u.id}-access`} className="access-row">
                  <td colSpan={5}>
                    <div className="access-panel">
                      <strong>Service Access for {u.display_name || u.email}</strong>
                      {accessLoading ? (
                        <p style={{ color: "#999" }}>Loading…</p>
                      ) : restrictedServices.length === 0 ? (
                        <p style={{ color: "#999" }}>No restricted services configured.</p>
                      ) : (
                        <div className="access-toggles">
                          {restrictedServices.map((svc) => {
                            const hasAccess = userAccess.includes(svc.id);
                            return (
                              <div key={svc.id} className="access-toggle-row">
                                <span>{svc.name}</span>
                                <button
                                  className={`toggle ${hasAccess ? "on" : "off"}`}
                                  onClick={() => toggleAccess(u.id, svc.id, hasAccess)}
                                >
                                  {hasAccess ? "Granted" : "No Access"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              </React.Fragment>
            ))}
            {filteredUsers.length === 0 && (
              <tr><td colSpan={5} style={{ color: "#999", textAlign: "center" }}>No users found.</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h3>Service Management</h3>
        <div className="admin-table-wrap">
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
        </div>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h3>Pending Access Requests</h3>
        {requests.length === 0 ? (
          <p style={{ color: "#777" }}>No pending requests.</p>
        ) : (
          <div className="admin-table-wrap">
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
          </div>
        )}
      </section>
    </div>
  );
}
