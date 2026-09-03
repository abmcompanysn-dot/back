# Outil ponctuel de rattrapage des miniatures — voir main.go pour le
# contexte. Build depuis la racine du repo (a besoin de tout le module) :
#   docker build -f cmd/generate-thumbnails/Dockerfile -t miad/generate-thumbnails:latest .
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /bin/generate-thumbnails ./cmd/generate-thumbnails

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /bin/generate-thumbnails /generate-thumbnails
ENTRYPOINT ["/generate-thumbnails"]
