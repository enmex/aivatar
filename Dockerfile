FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

FROM node:22-alpine AS server-deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM server-deps AS test
COPY src ./src
COPY migrations ./migrations
COPY test ./test
CMD ["sh", "-c", "npm test && npm run test:integration"]

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY migrations ./migrations
COPY --from=client-build /app/client/build ./client/build
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
