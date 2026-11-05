# A local NEAR node for the one-command judge run and the end-to-end demo.
#
# near-sandbox 2.14 needs glibc 2.38+, which Debian trixie has (2.41); the
# Node image is pinned by digest. The npm package downloads the nearcore
# sandbox binary on first run, so it is run once at build time.
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/sandbox
RUN npm init -y >/dev/null && npm install --silent near-sandbox@0.3.5 && npx near-sandbox --version
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3030
HEALTHCHECK --interval=3s --retries=40 CMD curl -fs http://127.0.0.1:3030/status >/dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]
