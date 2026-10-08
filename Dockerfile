FROM node:22-slim
RUN npm install -g pnpm@10.34.6
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
EXPOSE 3000
CMD ["sh", "-c", "pnpm migrate && exec node_modules/.bin/tsx apps/api/src/main.ts"]
