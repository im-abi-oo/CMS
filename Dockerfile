FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# بیلد کردن فایل EXE
RUN npx pkg . --output dist/saino-forge.exe
