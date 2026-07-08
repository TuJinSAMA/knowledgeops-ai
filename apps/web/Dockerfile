# syntax=docker/dockerfile:1
#
# Next.js web app (apps/web). Build context is the REPO ROOT so the pnpm
# workspace (root package.json + lockfile + pnpm-workspace.yaml) is available.
#
#   docker build -f apps/web/Dockerfile -t knowledgeops-web .
#
# Targets:
#   runner  (default) - minimal standalone runtime, runs `node server.js`
#   migrate           - has drizzle-kit + migrations, runs `pnpm db:migrate`

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- deps: install all workspace dependencies (cached on lockfile) ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- builder: compile the standalone Next.js server -------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
# Placeholder DB credentials so importing src/env.ts during `next build` does
# not fail (build never connects to a database). Overridden at runtime.
ENV POSTGRES_DB=build \
    POSTGRES_USER=build \
    POSTGRES_PASSWORD=build \
    NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* are inlined into the client bundle at build time.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
RUN pnpm --filter @knowledgeops/web build

# --- migrate: applies Drizzle migrations (one-shot, used by compose) --------
FROM builder AS migrate
WORKDIR /app/apps/web
CMD ["pnpm", "db:migrate"]

# --- runner: minimal production runtime -------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Standalone output mirrors the monorepo layout under apps/web/.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
