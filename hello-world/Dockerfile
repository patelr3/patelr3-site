FROM node:20-alpine

WORKDIR /app/hello-world
COPY packages/tracing/ /app/packages/tracing/
COPY hello-world/package.json ./
RUN npm install --omit=dev
COPY hello-world/src/ ./src/

EXPOSE 5000
CMD ["node", "src/index.js"]
