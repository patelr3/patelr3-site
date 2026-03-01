// API routes — always go through the same-origin nginx proxy (/api/*)
// Both local dev and production use nginx to proxy API requests.

const api = {
  // Auth
  authMe: () => "/api/auth/me",
  authLogin: () => "/api/auth/login",
  authRegister: () => "/api/auth/register",
  authLogout: () => "/api/auth/logout",
  authLoginGoogle: () => "/api/auth/login/google",

  // Services
  services: () => "/api/auth/services",
  serviceUpdate: (id) => `/api/auth/services/${id}`,

  // Access requests
  accessRequests: () => "/api/auth/access-requests",
  accessRequestApprove: (id) => `/api/auth/access-requests/${id}/approve`,
  accessRequestDeny: (id) => `/api/auth/access-requests/${id}/deny`,

  // Account
  account: () => "/api/auth/account",
  changePassword: () => "/api/auth/change-password",
  debugMode: () => "/api/auth/debug-mode",
  forgotPassword: () => "/api/auth/forgot-password",
  resetPassword: () => "/api/auth/reset-password",

  // Admin: users
  users: () => "/api/auth/users",
  userRole: (id) => `/api/auth/users/${id}/role`,
  userDelete: (id) => `/api/auth/users/${id}`,

  // Deployments
  deploymentStatus: (slug) => `/api/auth/deployments/${slug}`,

  // Service endpoint URLs are already /api/* paths from the database
  serviceEndpoint: (endpointUrl) => endpointUrl,
};

export default api;
