// API base URLs — empty in local dev (Nginx proxies /api/*), set in production builds
const AUTH_API = import.meta.env.VITE_AUTH_API_URL || "";
const HELLO_API = import.meta.env.VITE_HELLO_API_URL || "";

// In local dev, Nginx proxies /api/auth/* → auth-api /auth/* and /api/hello/* → hello-world /.
// In production, requests go directly to the service with its native route prefix.
const authPrefix = AUTH_API ? "/auth" : "/api/auth";
const helloPrefix = HELLO_API ? "" : "/api/hello";

const api = {
  authMe: () => `${AUTH_API}${authPrefix}/me`,
  authLogin: () => `${AUTH_API}${authPrefix}/login`,
  authRegister: () => `${AUTH_API}${authPrefix}/register`,
  authLogout: () => `${AUTH_API}${authPrefix}/logout`,
  authLoginGoogle: () => `${AUTH_API}${authPrefix}/login/google`,
  hello: () => `${HELLO_API}${helloPrefix}/`,
};

export default api;
