FROM oven/bun:1

WORKDIR /app

# Dependencias primero (capa cacheable). bun.lock fija las versiones: el build es reproducible
# y falla si package.json y bun.lock no coinciden.
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY --chown=bun:bun . .

# El servidor escribe solo en out/ (sesiones, registros): esa es la única carpeta escribible por el
# usuario sin privilegios con el que corre la aplicación.
RUN mkdir -p /app/out && chown bun:bun /app/out

ENV PORT=3000
EXPOSE 3000
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# La clave del modelo se entrega como variable de entorno del servicio (nunca en la imagen).
# Detrás de un proxy/balanceador de la plataforma, configura también TRUST_PROXY_HOPS (ver README).
CMD ["bun", "run", "src/server.ts"]
