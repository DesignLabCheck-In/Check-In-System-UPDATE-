FROM node:18

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the code
COPY . .

# Expose the port Render/Northflank uses
EXPOSE 3000

# Run the app
CMD ["node", "index.js"]
