FROM oven/bun:1.3.14
WORKDIR /app
COPY server.ts core.ts identity.ts dashboard.html ./
ENV ROUTER_BIND=0.0.0.0 PORT=8791 ROUTER_DB=/data/usage.sqlite
USER bun
CMD ["bun", "server.ts"]
