FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# Install all deps (dev included) - needed for prisma generate and the Remix build
RUN npm ci && npm cache clean --force

# Remove CLI package since we don't need it in production
RUN npm remove @shopify/cli

COPY . .

# Generate the Prisma client before building (Remix imports @prisma/client at build time)
RUN npx prisma generate

# Build the Remix app
RUN npm run build

# Drop dev dependencies after the build to shrink the runtime image
RUN npm prune --omit=dev

# At container start: deploy pending migrations, then serve the app.
# `exec` makes node replace the shell as the signal recipient: the previous
# npm -> sh -> npm -> sh -> node chain swallowed SIGTERM, so every deploy
# ended in a SIGKILL that hard-killed in-flight audits and the detached
# llms.txt regeneration queue. remix-serve installs its own SIGTERM handler
# once it can actually receive the signal. (prisma generate is not needed
# here: the client is generated at image build time above.)
CMD ["sh", "-c", "npx prisma migrate deploy && exec npx remix-serve ./build/server/index.js"]
