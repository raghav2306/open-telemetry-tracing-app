# One image for all four services — the SERVICE env var / command picks which one runs.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
# --require loads OpenTelemetry BEFORE the service code (needed for auto-instrumentation)
CMD ["sh", "-c", "exec node --require ./src/tracing.js src/services/${SERVICE}.js"]
