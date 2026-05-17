FROM node:20-alpine
WORKDIR /app
# Install build dependencies for sharp and zip for backups
RUN apk add --no-cache python3 make g++ zip
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV DB_PATH=/app/data/cabledrums.db
EXPOSE 3040
CMD ["node", "server.js"]