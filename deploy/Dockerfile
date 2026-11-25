FROM node:24-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 8080
CMD ["sh", "-c", "node db/migrate.mjs && exec node_modules/.bin/next start -H 0.0.0.0 -p ${PORT:-8080}"]
