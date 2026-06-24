# Build context: REPO ROOT (not acp-template/).
# On Railway: Root Directory = "" (empty), Dockerfile Path = "acp-template/Dockerfile".

FROM node:20-slim
WORKDIR /app

# 1. Stage acp-core at /sdk so `file:../sdk` resolves from /app.
COPY sdk/package.json sdk/package-lock.json* sdk/tsconfig.json /sdk/
COPY sdk/idl/ /sdk/idl/
COPY sdk/src/ /sdk/src/
RUN cd /sdk && npm install && npm run build

# 2. Install acp-template deps.
COPY acp-template/package.json acp-template/package-lock.json* ./
RUN npm install --omit=dev

# acp-core strips peer deps from its build. Keep peer resolution anchored at
# /app/node_modules when Node follows the file dependency's real path.
RUN ln -s /app/node_modules /node_modules

# 3. Source.
COPY acp-template/ ./

CMD ["npx", "tsx", "src/seller/runtime/seller.ts"]
