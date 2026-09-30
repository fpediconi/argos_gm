FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV DB_PATH=/data/dj.sqlite NODE_NO_WARNINGS=1
EXPOSE 3100
CMD ["npx", "tsx", "src/index.ts"]
