FROM node:20-alpine
WORKDIR /app
# Install build dependencies for sharp
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV DB_PATH=/app/data/cabledrums.db
EXPOSE 3040
CMD ["node", "server.js"]