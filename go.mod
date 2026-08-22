module github.com/miadmarket/miad-backend

go 1.23.0

require (
	github.com/IBM/sarama v1.43.3
	github.com/jackc/pgx/v5 v5.7.2
	github.com/redis/go-redis/v9 v9.7.0
)

// NOTE : lancer `go mod tidy` (ou `make tidy`) avant le premier build —
// génère go.sum et complète les dépendances indirectes.
