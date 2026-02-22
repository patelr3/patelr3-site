// API base URLs — empty in local dev (Nginx proxies /api/*), set in production builds
const AUTH_API = import.meta.env.VITE_AUTH_API_URL || "";
const HELLO_API = import.meta.env.VITE_HELLO_API_URL || "";

// In local dev, Nginx proxies /api/auth/* → auth-api /auth/* and /api/hello/* → hello-world /.
// In production, requests go directly to the service with its native route prefix.
const authPrefix = AUTH_API ? "/auth" : "/api/auth";
const helloPrefix = HELLO_API ? "" : "/api/hello";

const api = {
  // Auth
  authMe: () => `${AUTH_API}${authPrefix}/me`,
  authLogin: () => `${AUTH_API}${authPrefix}/login`,
  authRegister: () => `${AUTH_API}${authPrefix}/register`,
  authLogout: () => `${AUTH_API}${authPrefix}/logout`,
  authLoginGoogle: () => `${AUTH_API}${authPrefix}/login/google`,

  // Services
  services: () => `${AUTH_API}${authPrefix}/services`,
  serviceUpdate: (id) => `${AUTH_API}${authPrefix}/services/${id}`,

  // Access requests
  accessRequests: () => `${AUTH_API}${authPrefix}/access-requests`,
  accessRequestApprove: (id) => `${AUTH_API}${authPrefix}/access-requests/${id}/approve`,
  accessRequestDeny: (id) => `${AUTH_API}${authPrefix}/access-requests/${id}/deny`,

  // Account
  account: () => `${AUTH_API}${authPrefix}/account`,
  changePassword: () => `${AUTH_API}${authPrefix}/change-password`,
  forgotPassword: () => `${AUTH_API}${authPrefix}/forgot-password`,
  resetPassword: () => `${AUTH_API}${authPrefix}/reset-password`,

  // Admin: users
  users: () => `${AUTH_API}${authPrefix}/users`,
  userRole: (id) => `${AUTH_API}${authPrefix}/users/${id}/role`,
  userDelete: (id) => `${AUTH_API}${authPrefix}/users/${id}`,

  // Deployments
  deploymentStatus: (slug) => `${AUTH_API}${authPrefix}/deployments/${slug}`,

  // Service endpoints (called directly by service pages)
  hello: () => `${HELLO_API}${helloPrefix}/`,
  helloRestricted: () => `${HELLO_API ? HELLO_API.replace("hello-world", "hello-world-restricted") : ""}/api/hello-restricted/`,
};

// Build a service endpoint URL from a service's endpoint_url field
// In local dev, endpoint_url is already the correct path (e.g. /api/hello/)
// In production, we need to map to the actual service URL
api.serviceEndpoint = (endpointUrl) => {
  if (!HELLO_API) return endpointUrl; // local dev — nginx proxies
  // Map known endpoints to their ACA URLs
  if (endpointUrl.includes("hello-restricted")) {
    const HELLO_RESTRICTED_API = import.meta.env.VITE_HELLO_RESTRICTED_API_URL || HELLO_API.replace("hello-world", "hello-world-restricted");
    return `${HELLO_RESTRICTED_API}/`;
  }
  if (endpointUrl.includes("hello")) {
    return `${HELLO_API}/`;
  }
  return endpointUrl;
};

export default api;
