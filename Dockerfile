FROM node:22-alpine3.19

# Set working directory to /app
WORKDIR /app

# Install pnpm
RUN npm install --global pnpm

# Copy package-related files
COPY package.json pnpm-lock.yaml ./

# Install all dependencies
RUN pnpm install --prod

# Copy source files
COPY . .

# Ensure the app knows we're running in production
ENV NODE_ENV=production

# Run!
CMD npm run start