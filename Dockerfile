FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /data
ENV NODE_ENV=production
ENV DATABASE_FILE=/data/store.db
EXPOSE 10000
CMD ["npm", "start"]
