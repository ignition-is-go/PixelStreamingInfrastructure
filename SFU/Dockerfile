# Match the repository-required Node version.
ARG NODE_IMAGE=node:22.14.0
FROM ${NODE_IMAGE}
ARG H264_RTP_CAPACITY=1500
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY NODE_VERSION ./NODE_VERSION
COPY /vendor ./vendor
COPY /SFU ./SFU
COPY package.json package-lock.json ./
COPY Extras/mediasoup-sdp-bridge ./Extras/mediasoup-sdp-bridge
COPY scripts/update-protocol-types.mjs ./scripts/update-protocol-types.mjs

RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    node scripts/update-protocol-types.mjs --check \
    && npm ci --workspace SFU --workspace Extras/mediasoup-sdp-bridge --include-workspace-root \
    && npm --workspace SFU run check:health \
    && node -e "require('mediasoup'); require('@epicgames-ps/mediasoup-sdp-bridge')"

COPY Extras/FrontendTests/build-h264-large-packet-worker.cjs ./Extras/FrontendTests/build-h264-large-packet-worker.cjs

RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca SSL_CERT_FILE=/run/secrets/proxy_ca PIP_CERT=/run/secrets/proxy_ca; \
    fi; \
    case "$H264_RTP_CAPACITY" in \
      1500) ;; \
      1900) node Extras/FrontendTests/build-h264-large-packet-worker.cjs --install ;; \
      *) echo "H264_RTP_CAPACITY must be 1500 or 1900" >&2; exit 1 ;; \
    esac

ENV SIGNALLING_URL ws://localhost:8889

EXPOSE 40000-49999/tcp
EXPOSE 40000-49999/udp

CMD node SFU/sfu_server.js --signallingURL=${SIGNALLING_URL}
