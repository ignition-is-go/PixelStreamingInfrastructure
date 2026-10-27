# Match the repository-required Node version.
FROM node:22.14.0
WORKDIR /app

COPY NODE_VERSION ./NODE_VERSION
COPY /vendor ./vendor
COPY /SFU ./SFU
COPY package.json package-lock.json ./
COPY Extras/mediasoup-sdp-bridge ./Extras/mediasoup-sdp-bridge
COPY scripts/update-reporting-types.mjs ./scripts/update-reporting-types.mjs

RUN node scripts/update-reporting-types.mjs --check \
    && npm ci --workspace SFU --workspace Extras/mediasoup-sdp-bridge --include-workspace-root \
    && npm --workspace SFU run check:health \
    && node -e "require('mediasoup'); require('@epicgames-ps/mediasoup-sdp-bridge')"

ENV SIGNALLING_URL ws://localhost:8889

EXPOSE 40000-49999/tcp
EXPOSE 40000-49999/udp

CMD node SFU/sfu_server.js --signallingURL=${SIGNALLING_URL}
