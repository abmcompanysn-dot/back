// ============================================================
// migrate-images — migre les images produits de leur hébergement
// d'origine (Cloudflare R2, cdn.miadmarket.com) vers MinIO
// (img.miadmarket.ca), et met à jour catalog-svc avec les nouvelles
// URLs. Conçu pour un rapport final HONNÊTE : N réussies / M total,
// avec la liste exacte des échecs — jamais un "terminé" silencieux
// qui masquerait des images manquantes.
//
// Usage :
//   go run ./cmd/migrate-images \
//     --wc-url https://api.miadmarket.ca --wc-key ck_... --wc-secret cs_... \
//     --catalog-url http://localhost:8081 \
//     --minio-endpoint localhost:9000 --minio-user ... --minio-password ... \
//     --minio-bucket miad-media --media-base-url https://img.miadmarket.ca
//
// Rejouable sans risque : une image déjà migrée (même wc_id, même nom de
// fichier source) écrase le même objet MinIO — pas de doublons accumulés.
// En cas d'échecs, relancer le même outil ne re-télécharge QUE les
// produits en échec si --retry-file est fourni (fichier JSON produit par
// une exécution précédente).
// ============================================================
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"github.com/miadmarket/miad-backend/internal/kit"
)

var (
	wcURL      = flag.String("wc-url", "", "https://api.miadmarket.ca (source WooCommerce)")
	wcKey      = flag.String("wc-key", "", "ck_…")
	wcSecret   = flag.String("wc-secret", "", "cs_…")
	catalogURL = flag.String("catalog-url", "http://localhost:8081", "URL de catalog-svc")

	minioEndpoint = flag.String("minio-endpoint", "localhost:9000", "host:port MinIO")
	minioUser     = flag.String("minio-user", "", "MINIO_ROOT_USER")
	minioPassword = flag.String("minio-password", "", "MINIO_ROOT_PASSWORD")
	minioBucket   = flag.String("minio-bucket", "miad-media", "bucket cible")
	mediaBaseURL  = flag.String("media-base-url", "https://img.miadmarket.ca", "domaine public servant le bucket")

	retryFile = flag.String("retry-file", "", "fichier JSON d'une exécution précédente : ne retraite que les échecs listés")
	reportOut = flag.String("report-out", "migrate-images-report.json", "où écrire le rapport final")
	concurrency = flag.Int("concurrency", 4, "téléchargements/uploads en parallèle")
)

type wcProduct struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Images []struct {
		Src string `json:"src"`
	} `json:"images"`
}

type productResult struct {
	WcID       int64    `json:"wc_id"`
	Name       string   `json:"name"`
	SourceURLs []string `json:"source_urls"`
	NewURLs    []string `json:"new_urls,omitempty"`
	Error      string   `json:"error,omitempty"`
}

type report struct {
	Total     int             `json:"total"`
	Succeeded int             `json:"succeeded"`
	Failed    int             `json:"failed"`
	Failures  []productResult `json:"failures"`
	StartedAt string          `json:"started_at"`
	EndedAt   string          `json:"ended_at"`
}

func main() {
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))

	if *wcURL == "" || *wcKey == "" || *wcSecret == "" {
		log.Error("--wc-url, --wc-key, --wc-secret obligatoires")
		os.Exit(1)
	}
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

	var products []wcProduct
	if *retryFile != "" {
		products = loadRetryList(log, *retryFile)
	} else {
		products, err = fetchAllProducts(log)
		if err != nil {
			log.Error("lecture catalogue WooCommerce", "err", err)
			os.Exit(1)
		}
	}
	log.Info("produits à migrer", "n", len(products))

	rep := report{Total: len(products), StartedAt: time.Now().UTC().Format(time.RFC3339)}
	results := make(chan productResult, len(products))
	sem := make(chan struct{}, *concurrency)

	for _, p := range products {
		p := p
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()
			results <- migrateProduct(ctx, log, media, p)
		}()
	}
	for i := 0; i < len(products); i++ {
		r := <-results
		if r.Error != "" {
			rep.Failed++
			rep.Failures = append(rep.Failures, r)
			log.Error("échec migration produit", "wc_id", r.WcID, "name", r.Name, "err", r.Error)
		} else {
			rep.Succeeded++
			log.Info("produit migré", "wc_id", r.WcID, "name", r.Name, "n_images", len(r.NewURLs), "progress", fmt.Sprintf("%d/%d", rep.Succeeded+rep.Failed, rep.Total))
		}
	}
	rep.EndedAt = time.Now().UTC().Format(time.RFC3339)

	f, err := os.Create(*reportOut)
	if err == nil {
		_ = json.NewEncoder(f).Encode(rep)
		f.Close()
	}

	log.Info("migration terminée", "succeeded", rep.Succeeded, "failed", rep.Failed, "total", rep.Total, "report", *reportOut)
	if rep.Failed > 0 {
		log.Error(fmt.Sprintf("ATTENTION : %d/%d produits en échec — relancer avec --retry-file=%s après correction", rep.Failed, rep.Total, *reportOut))
		os.Exit(1)
	}
	log.Info(fmt.Sprintf("SUCCÈS COMPLET : %d/%d images migrées", rep.Succeeded, rep.Total))
}

// migrateProduct télécharge chaque image du produit, l'uploade dans
// MinIO, et — SEULEMENT si toutes les images du produit ont réussi —
// met à jour catalog-svc. Un produit dont une seule image échoue est
// entièrement marqué en échec plutôt que d'écrire un catalogue à moitié
// migré (mélange d'anciennes et nouvelles URLs sur le même produit).
func migrateProduct(ctx context.Context, log *slog.Logger, media *kit.Media, p wcProduct) productResult {
	res := productResult{WcID: p.ID, Name: p.Name}
	for _, img := range p.Images {
		res.SourceURLs = append(res.SourceURLs, img.Src)
	}
	if len(res.SourceURLs) == 0 {
		return res // rien à migrer, pas une erreur
	}

	newURLs := make([]string, 0, len(res.SourceURLs))
	for _, src := range res.SourceURLs {
		url, err := migrateOneImage(ctx, media, p.ID, src)
		if err != nil {
			res.Error = fmt.Sprintf("image %q: %v", src, err)
			return res
		}
		newURLs = append(newURLs, url)
	}

	if err := updateCatalogImages(ctx, p.ID, newURLs); err != nil {
		res.Error = fmt.Sprintf("mise à jour catalog-svc: %v", err)
		return res
	}
	res.NewURLs = newURLs
	return res
}

// migrateOneImage télécharge puis uploade, avec jusqu'à 3 tentatives et
// une vérification stricte : la taille annoncée par le téléchargement
// doit correspondre à ce qui a été réellement uploadé, sinon échec —
// pas d'image tronquée silencieusement acceptée.
func migrateOneImage(ctx context.Context, media *kit.Media, wcID int64, srcURL string) (string, error) {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		url, err := tryMigrateOneImage(ctx, media, wcID, srcURL)
		if err == nil {
			return url, nil
		}
		lastErr = err
		time.Sleep(time.Duration(attempt) * 2 * time.Second)
	}
	return "", fmt.Errorf("après 3 tentatives: %w", lastErr)
}

func tryMigrateOneImage(ctx context.Context, media *kit.Media, wcID int64, srcURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srcURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("téléchargement: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("téléchargement: statut HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("lecture réponse: %w", err)
	}
	if len(body) == 0 {
		return "", fmt.Errorf("fichier téléchargé vide")
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = guessContentType(srcURL)
	}

	filename := fmt.Sprintf("%d-%s", wcID, sanitizeName(path.Base(strings.Split(srcURL, "?")[0])))
	newURL, err := media.Upload(ctx, "products", filename, strings.NewReader(string(body)), int64(len(body)), contentType)
	if err != nil {
		return "", fmt.Errorf("upload minio: %w", err)
	}

	// Vérification 500/500 : re-télécharger depuis la nouvelle URL
	// publique et comparer la taille — garantit que Caddy/MinIO servent
	// bien l'objet complet, pas seulement que PutObject n'a pas erroré.
	if err := verifyUploaded(ctx, newURL, len(body)); err != nil {
		return "", fmt.Errorf("vérification post-upload: %w", err)
	}
	return newURL, nil
}

func verifyUploaded(ctx context.Context, url string, expectedSize int) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("relecture échouée: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("relecture: statut HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if len(body) != expectedSize {
		return fmt.Errorf("taille incohérente: attendu %d octets, reçu %d", expectedSize, len(body))
	}
	return nil
}

func guessContentType(url string) string {
	lower := strings.ToLower(url)
	switch {
	case strings.HasSuffix(lower, ".png"):
		return "image/png"
	case strings.HasSuffix(lower, ".webp"):
		return "image/webp"
	case strings.HasSuffix(lower, ".gif"):
		return "image/gif"
	case strings.HasSuffix(lower, ".svg"):
		return "image/svg+xml"
	default:
		return "image/jpeg"
	}
}

func sanitizeName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('-')
		}
	}
	out := b.String()
	if out == "" {
		return "image.jpg"
	}
	return out
}

func updateCatalogImages(ctx context.Context, wcID int64, images []string) error {
	body, _ := json.Marshal(map[string]any{"images": images})
	url := fmt.Sprintf("%s/products/%d/images?by=wc_id", *catalogURL, wcID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("statut HTTP %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

func fetchAllProducts(log *slog.Logger) ([]wcProduct, error) {
	var all []wcProduct
	page := 1
	for {
		url := fmt.Sprintf("%s/wp-json/wc/v3/products?per_page=100&page=%d&consumer_key=%s&consumer_secret=%s",
			*wcURL, page, *wcKey, *wcSecret)
		resp, err := http.Get(url)
		if err != nil {
			return nil, err
		}
		var batch []wcProduct
		err = json.NewDecoder(resp.Body).Decode(&batch)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("page %d: %w", page, err)
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("page %d: statut HTTP %d", page, resp.StatusCode)
		}
		all = append(all, batch...)
		log.Info("page WooCommerce lue", "page", page, "n", len(batch))
		if len(batch) < 100 {
			break
		}
		page++
	}
	return all, nil
}

func loadRetryList(log *slog.Logger, file string) []wcProduct {
	f, err := os.Open(file)
	if err != nil {
		log.Error("ouverture retry-file", "err", err)
		os.Exit(1)
	}
	defer f.Close()
	var rep report
	if err := json.NewDecoder(f).Decode(&rep); err != nil {
		log.Error("décodage retry-file", "err", err)
		os.Exit(1)
	}
	out := make([]wcProduct, 0, len(rep.Failures))
	for _, f := range rep.Failures {
		p := wcProduct{ID: f.WcID, Name: f.Name}
		for _, u := range f.SourceURLs {
			p.Images = append(p.Images, struct {
				Src string `json:"src"`
			}{Src: u})
		}
		out = append(out, p)
	}
	return out
}
