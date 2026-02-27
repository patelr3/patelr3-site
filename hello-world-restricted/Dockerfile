FROM node:20-alpine

WORKDIR /app/hello-world-restricted
COPY packages/tracing/ /app/packages/tracing/
COPY hello-world-restricted/package.json ./
RUN npm install --omit=dev
COPY hello-world-restricted/src/ ./src/

EXPOSE 5001
CMD ["node", "src/index.js"]
