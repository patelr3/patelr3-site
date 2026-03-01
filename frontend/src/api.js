const api = {
  // Auth (Firebase handles login/register — only profile endpoints remain)
  authMe: () => "/api/auth/me",
  authLogout: () => "/api/auth/logout",

  // Services
  services: () => "/api/auth/services",
  serviceUpdate: (id) => `/api/auth/services/${id}`,

  // Access requests
  accessRequests: () => "/api/auth/access-requests",
  accessRequestApprove: (id) => `/api/auth/access-requests/${id}/approve`,
  accessRequestDeny: (id) => `/api/auth/access-requests/${id}/deny`,

  // Account
  account: () => "/api/auth/account",

  // Admin: users
  users: () => "/api/auth/users",
  userRole: (id) => `/api/auth/users/${id}/role`,
  userDelete: (id) => `/api/auth/users/${id}`,

  // Deployments
  deploymentStatus: (slug) => `/api/auth/deployments/${slug}`,

  serviceEndpoint: (endpointUrl) => endpointUrl,
};

export default api;
