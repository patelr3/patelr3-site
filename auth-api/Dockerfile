FROM node:20-alpine

WORKDIR /app/auth-api
COPY packages/tracing/ /app/packages/tracing/
COPY auth-api/package.json ./
RUN npm install --omit=dev
COPY auth-api/src/ ./src/

EXPOSE 8000
CMD ["node", "src/index.js"]
