# ============================================================
# Dockerfile unique paramétrable — un binaire par service.
# Usage (orchestré par docker-compose.yml) :
#   docker build --build-arg SERVICE=catalog-svc -t catalog-svc .
# ============================================================
FROM golang:1.23-alpine AS build

ARG SERVICE
RUN test -n "$SERVICE" || (echo "ARG SERVICE obligatoire" && exit 1)

WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /bin/svc ./services/${SERVICE}

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata wget
COPY --from=build /bin/svc /svc
EXPOSE 8080
ENTRYPOINT ["/svc"]
