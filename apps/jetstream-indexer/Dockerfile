FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY sql ./sql
COPY tsconfig.json ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "start"]
