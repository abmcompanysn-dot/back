// ============================================================
// generate-thumbnails — rattrapage ponctuel : génère les miniatures
// 300x300/150x150 manquantes pour toutes les images déjà en ligne sur
// MinIO (uploadées avant l'introduction de kit.Media.UploadWithThumbnails
// le 2026-09-03 — voir CLAUDE.md racine, section perf images). Rejouable
// sans risque : une miniature déjà présente n'est jamais régénérée (voir
// kit.Media.GenerateThumbnailsFor, StatObject avant upload).
//
// Usage :
//   go run ./cmd/generate-thumbnails \
//     --minio-endpoint minio:9000 --minio-user ... --minio-password ... \
//     --minio-bucket miad-media --media-base-url https://img.miadmarket.ca \
//     --prefix products --concurrency 8
//
// Rapport final HONNÊTE : N traitées / M déjà à jour / K échouées, avec la
// liste exacte des échecs — jamais un "terminé" silencieux.
// ============================================================
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miadmarket/miad-backend/internal/kit"
)

var (
	minioEndpoint = flag.String("minio-endpoint", "localhost:9000", "host:port MinIO")
	minioUser     = flag.String("minio-user", "", "MINIO_ROOT_USER")
	minioPassword = flag.String("minio-password", "", "MINIO_ROOT_PASSWORD")
	minioBucket   = flag.String("minio-bucket", "miad-media", "bucket cible")
	mediaBaseURL  = flag.String("media-base-url", "https://img.miadmarket.ca", "domaine public servant le bucket")
	prefix        = flag.String("prefix", "products", "préfixe à traiter (products, vendors, categories)")
	concurrency   = flag.Int("concurrency", 8, "traitements en parallèle")
)

func main() {
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))

	if *minioUser == "" || *minioPassword == "" {
		log.Error("--minio-user, --minio-password obligatoires")
		os.Exit(1)
	}

	media, err := kit.NewMedia(*minioEndpoint, *minioUser, *minioPassword, *minioBucket, *mediaBaseURL)
	if err != nil {
		log.Error("client minio", "err", err)
		os.Exit(1)
	}

	ctx := context.Background()
	start := time.Now()

	keys, err := media.ListKeys(ctx, *prefix)
	if err != nil {
		log.Error("listage des objets échoué", "err", err)
		os.Exit(1)
	}

	// Ne garde que les images "originales" (jamais des miniatures déjà
	// générées, ni des fichiers non-image évidents comme .json).
	var originals []string
	for _, k := range keys {
		lower := strings.ToLower(k)
		if strings.Contains(k, "-300x300.") || strings.Contains(k, "-150x150.") {
			continue
		}
		if !strings.HasSuffix(lower, ".jpg") && !strings.HasSuffix(lower, ".jpeg") &&
			!strings.HasSuffix(lower, ".png") && !strings.HasSuffix(lower, ".avif") &&
			!strings.HasSuffix(lower, ".webp") {
			continue
		}
		originals = append(originals, k)
	}

	log.Info("objets à traiter", "total_objets", len(keys), "originaux_candidats", len(originals))

	var (
		processed int64
		failed    int64
		mu        sync.Mutex
		failures  []string
	)

	sem := make(chan struct{}, *concurrency)
	var wg sync.WaitGroup

	for i, key := range originals {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, key string) {
			defer wg.Done()
			defer func() { <-sem }()

			if err := media.GenerateThumbnailsFor(ctx, key, log); err != nil {
				atomic.AddInt64(&failed, 1)
				mu.Lock()
				failures = append(failures, fmt.Sprintf("%s: %s", key, err.Error()))
				mu.Unlock()
				log.Warn("échec", "key", key, "err", err.Error())
			} else {
				atomic.AddInt64(&processed, 1)
			}

			if (i+1)%100 == 0 {
				log.Info("progression", "traitees", i+1, "total", len(originals))
			}
		}(i, key)
	}
	wg.Wait()

	elapsed := time.Since(start)
	log.Info("terminé",
		"total_candidats", len(originals),
		"reussies_ou_deja_a_jour", processed,
		"echouees", failed,
		"duree", elapsed.String(),
	)
	if failed > 0 {
		log.Warn("détail des échecs")
		for _, f := range failures {
			fmt.Println(" - " + f)
		}
		os.Exit(1)
	}
}
