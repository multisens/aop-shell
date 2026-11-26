# AoP shell (Node.js). Build context: this repository.

FROM node:23-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
ENV NODE_ENV=production
COPY src ./src
COPY public ./public
EXPOSE 8080
CMD ["node", "src/server.js"]
