FROM node:20-alpine AS build

# Firebase config — injected from AKV in CI, hardcoded fallback in firebase.js for local dev
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# Serve via nginx with API reverse proxy
FROM nginx:1.25-alpine
COPY --from=build /app/dist /usr/share/nginx/html

# nginx config template — env vars (AUTH_API_UPSTREAM etc.) substituted at runtime
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
