FROM node:20 AS frontend-build

WORKDIR /build

COPY frontend/package*.json ./

RUN npm install

COPY frontend/ ./

RUN npm run build

FROM node:20

RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package*.json ./

RUN npm install

COPY backend/prisma ./prisma
RUN npx prisma generate

COPY backend/ ./

COPY --from=frontend-build /build/dist ./frontend-dist

CMD ["npm", "run", "start:dev"]