FROM node:20-bookworm-slim AS base

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY db ./db

RUN mkdir -p /app/logs

EXPOSE 3000
CMD ["node", "src/index.js"]
