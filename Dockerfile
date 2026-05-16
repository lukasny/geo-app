FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# Install all deps (dev included) — needed for prisma generate and the Remix build
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

# At container start: deploy pending migrations, then serve the app
CMD ["npm", "run", "docker-start"]
