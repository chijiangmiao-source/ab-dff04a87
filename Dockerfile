FROM node:20-alpine

WORKDIR /app

# No third-party runtime dependencies; copy sources directly.
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_FILE=/data/audits.json

RUN mkdir -p /data && addgroup -S app && adduser -S app -G app \
    && chown -R app:app /data /app
USER app

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
