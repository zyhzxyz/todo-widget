FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-bookworm-slim
ENV NODE_ENV=production TODO_HOST=127.0.0.1 TODO_PORT=3210 TODO_DB_PATH=/var/lib/todo-widget/todo.db
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./package.json
COPY server/package.json server/package.json
COPY server/src server/src
COPY shared shared
RUN mkdir -p /var/lib/todo-widget && chown node:node /var/lib/todo-widget && chmod 700 /var/lib/todo-widget
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.TODO_PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.ts"]
