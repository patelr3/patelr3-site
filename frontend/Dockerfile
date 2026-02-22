FROM node:20-alpine AS build

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
