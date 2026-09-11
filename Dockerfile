FROM node:22-slim

# Set working directory
WORKDIR /app

# Copy only the files needed to install and run the project
COPY src /app/src/
COPY bin /app/bin/
COPY github-dorks.txt /app/
COPY package.json /app/
COPY README.md /app/

RUN npm install --omit=dev --no-audit --no-fund && npm link

# Set environment variables
ENV NODE_ENV=production

# Create volume for potential output files
VOLUME ["/app/output"]

ENTRYPOINT ["node", "bin/github-dork.js"]
