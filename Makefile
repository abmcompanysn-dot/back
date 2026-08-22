SHELL := /bin/bash
SERVICES := catalog-svc vendor-svc order-svc payment-svc shipping-svc auth-svc notification-svc admin-svc

.PHONY: tidy proto build up down ps logs health import clean

## Génère go.sum + résout les dépendances indirectes (obligatoire avant build Docker)
tidy:
	go mod tidy

## Génère les stubs Go depuis les contrats .proto (protoc + plugins grpc/gateway)
## Prérequis : protoc, protoc-gen-go, protoc-gen-go-grpc, protoc-gen-grpc-gateway
proto:
	protoc -I proto -I third_party/googleapis \
		--go_out=gen --go_opt=paths=source_relative \
		--go-grpc_out=gen --go-grpc_opt=paths=source_relative \
		--grpc-gateway_out=gen --grpc-gateway_opt=paths=source_relative \
		proto/miad/*/*/*.proto

## Compile tous les binaires localement (vérification rapide)
build:
	go build ./...
	@for s in $(SERVICES); do go build -o bin/$$s ./services/$$s || exit 1; done
	@echo "→ binaires dans ./bin"

up:
	docker compose up -d --build

down:
	docker compose down

ps:
	docker compose ps

logs:
	docker compose logs -f --tail=80

## Agrège le /system-check des 7 services (le point qui manquait sous WordPress)
health:
	@bash scripts/system-check.sh

## Import ponctuel WooCommerce/Dokan → Postgres (phase 2 de la migration)
import:
	go run ./cmd/wc-import \
		--wc-url=$(WC_URL) --wc-key=$(WC_KEY) --wc-secret=$(WC_SECRET)

clean:
	rm -rf bin
