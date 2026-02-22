FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
ARG VITE_AUTH_API_URL=""
ARG VITE_HELLO_API_URL=""
ARG VITE_HELLO_RESTRICTED_API_URL=""
RUN npm run build

# Serve the built SPA with a lightweight static server
FROM node:20-alpine
RUN npm install -g serve@14
WORKDIR /app
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["serve", "-s", "dist", "-l", "3000"]
