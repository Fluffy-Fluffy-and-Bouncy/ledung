# The relay (issue #160). Build from the repository's root, since it shares files with Ledung:
#   docker build -f relay/Dockerfile -t ledung-relay .
#   docker run -d --name ledung-relay -p 127.0.0.1:8080:8080 -v /path/to/relay.config.json:/config/relay.config.json:ro -v ledung-relay-data:/data ledung-relay
# Put a reverse proxy that ends HTTPS in front of it; see relay/README.md.
FROM node:24-alpine
WORKDIR /app/relay
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY relay/relay.ts ./
COPY src/remote/mux.ts src/remote/clienthello.ts src/remote/secret.ts src/remote/join-token.ts /app/src/remote/
# Computers added with "node relay.ts add" are kept here (README, Adding a computer); the config itself stays read-only.
RUN mkdir /data && chown node /data
ENV RELAY_STORE=/data/relay.added.json
# Invites and the computers that joined with them (README, Invite a computer) go beside it, in relay.invites.json.
VOLUME /data
USER node
# 8443 is the passthrough listener (README, End to end): for the proxy on the internal network only, never published.
EXPOSE 8080 8443
CMD ["node", "relay.ts", "/config/relay.config.json"]
