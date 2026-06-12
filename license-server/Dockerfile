# syntax=docker/dockerfile:1
# Self-hostable license + annotation sync server for Out-of-Code Insights.
# Zero runtime dependencies: the final image ships only the compiled JS.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund && npx tsc -p .

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist

# LICENSE_SECRET intentionally has no default: the server refuses to start
# without it. Provide it at runtime, e.g. `docker run -e LICENSE_SECRET=...`.
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787

USER node
CMD ["node", "dist/src/server.js"]
