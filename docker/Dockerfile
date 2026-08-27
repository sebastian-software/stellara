# build (bookworm-slim so the Playwright Chromium installer finds the
# glibc + apt ecosystem it expects; better-sqlite3 ships a glibc prebuilt
# so the dedicated `deps` build stage from the Alpine image is no longer
# necessary).
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable \
  && corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
RUN pnpm install --frozen-lockfile
# Install Chromium plus its runtime system libraries. `--with-deps` runs
# `apt-get install` for the system packages Playwright is known to need;
# the browser binary itself lands under PLAYWRIGHT_BROWSERS_PATH so it
# can be copied verbatim into the runtime stage below.
RUN pnpm exec playwright install --with-deps chromium
COPY . .
RUN pnpm build

# runtime
FROM node:24-bookworm-slim
ARG APP_VERSION=0.0.0
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Mirror `playwright install --with-deps chromium` on the runtime image so
# the bundled Chromium has its system libraries available. Keep the list
# narrow: Playwright maintains it per release, and any drift surfaces as a
# `browser_launch_failed` error at the first session_start.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       tini \
       ca-certificates \
       fonts-liberation \
       libasound2 \
       libatk-bridge2.0-0 \
       libatk1.0-0 \
       libatspi2.0-0 \
       libcairo2 \
       libcups2 \
       libdbus-1-3 \
       libdrm2 \
       libgbm1 \
       libglib2.0-0 \
       libnspr4 \
       libnss3 \
       libpango-1.0-0 \
       libx11-6 \
       libxcb1 \
       libxcomposite1 \
       libxdamage1 \
       libxext6 \
       libxfixes3 \
       libxkbcommon0 \
       libxrandr2 \
  && rm -rf /var/lib/apt/lists/* \
  # Pin UID/GID to 999 so the on-disk owner of the /data volume stays
  # stable across base-image upgrades. Without a fixed UID, switching
  # the base image (e.g. Alpine -> Debian) reallocates the system UID
  # and existing /data files become unreadable to the new app user,
  # surfacing as SQLITE_CANTOPEN at boot.
  && groupadd --system --gid 999 app \
  && useradd --system --uid 999 --gid 999 --create-home --home-dir /home/app app \
  && mkdir -p /data \
  && chown app:app /data
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist         ./dist
COPY --from=build --chown=app:app /app/package.json ./
COPY --from=build --chown=app:app /app/LICENSE      /app/LICENSE
# The Playwright browser cache lives outside /app and is shared between
# the build and runtime stages via the explicit `PLAYWRIGHT_BROWSERS_PATH`.
COPY --from=build --chown=app:app /ms-playwright    /ms-playwright
USER app
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    STELLARA_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
