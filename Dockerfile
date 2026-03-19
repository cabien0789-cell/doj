FROM timbru31/java-node:21-jdk-22

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN which javac || find / -name "javac" 2>/dev/null | head -5

EXPOSE 3000

CMD ["node", "index.js"]