# ============================================================
# Dockerfile unique paramétrable — un binaire par service.
# Autonome : fait son propre `go mod tidy` (génère go.sum +
# complète les dépendances indirectes), donc il build même si
# go.sum n'est pas committé.
# Usage : docker build --build-arg SERVICE=catalog-svc -t miad/catalog-svc:latest .
# ============================================================
FROM golang:1.23-alpine AS build

ARG SERVICE
RUN test -n "$SERVICE" || (echo "ARG SERVICE obligatoire" && exit 1)

WORKDIR /src
# Copie tout le module puis résout les dépendances (réseau dispo au build)
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /bin/svc ./services/${SERVICE}

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata wget
COPY --from=build /bin/svc /svc
EXPOSE 8080
ENTRYPOINT ["/svc"]
