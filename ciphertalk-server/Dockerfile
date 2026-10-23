FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/ciphertalk-db.json \
    DB_ENCRYPTION=true \
    UPLOADS_DIR=/data/uploads

# Непривилегированный пользователь: файлы БД, ключа шифрования (.dbkey)
# и загрузок принадлежат ему, а не root.
RUN addgroup -S ciphertalk && adduser -S ciphertalk -G ciphertalk \
 && mkdir -p /data/uploads \
 && chown -R ciphertalk:ciphertalk /data /app
USER ciphertalk
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
