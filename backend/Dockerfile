FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# Dev dependencies stay installed: the same image runs the tests and send-webhook (tsx).
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
