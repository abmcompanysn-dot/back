# ============================================================
# Dockerfile unique paramétrable — un binaire par service.
# Autonome : fait son propre `go mod tidy` (génère go.sum +
# complète les dépendances indirectes), donc il build même si
# go.sum n'est pas committé.
# Usage : docker build --build-arg SERVICE=catalog-svc -t miad/catalog-svc:latest .
#
# Stage "webui" : build React (Vite) de la console admin — seul
# admin-svc en a besoin au final (go:embed de
# services/admin-svc/webui/dist, jamais committé dans git, comme
# node_modules), mais ce stage tourne pour TOUS les services : Docker
# ne le reconstruit qu'une fois (cache de layers), donc le coût réel
# n'est payé qu'au premier build, pas à chacun des 11.
# ============================================================
FROM node:20-alpine AS webui
WORKDIR /webui
COPY services/admin-svc/webui/package*.json ./
RUN npm ci
COPY services/admin-svc/webui/ ./
RUN npm run build

FROM golang:1.23-alpine AS build

ARG SERVICE
RUN test -n "$SERVICE" || (echo "ARG SERVICE obligatoire" && exit 1)

WORKDIR /src
# Copie tout le module puis résout les dépendances (réseau dispo au build)
COPY . .
COPY --from=webui /webui/dist ./services/admin-svc/webui/dist
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /bin/svc ./services/${SERVICE}

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata wget
COPY --from=build /bin/svc /svc
EXPOSE 8080
ENTRYPOINT ["/svc"]
