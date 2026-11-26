# AoP shell (Node.js). Build context: this repository.

FROM node:23-alpine
WORKDIR /app
COPY package*.json ./
# Without --omit=dev: src/mqtt-ws.js requires http-proxy-middleware, listed in
# devDependencies.
RUN npm ci && npm cache clean --force
ENV NODE_ENV=production
COPY src ./src
COPY public ./public
EXPOSE 8080
CMD ["node", "src/server.js"]
