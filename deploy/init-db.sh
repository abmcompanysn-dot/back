#!/bin/bash
# ============================================================
# Exécuté une seule fois par le conteneur postgres
# (docker-entrypoint-initdb.d) : crée les 7 bases dédiées.
# Principe microservices : une base par service, jamais partagée.
# admin-svc n'a pas de base : pur agrégateur HTTP des autres services.
# ============================================================
set -e

DATABASES=(
  miad_catalog
  miad_vendor
  miad_order
  miad_payment
  miad_shipping
  miad_auth
  miad_notification
  miad_email
)

for db in "${DATABASES[@]}"; do
  echo "→ création de la base $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE $db OWNER $POSTGRES_USER;
EOSQL
done

echo "→ 7 bases prêtes."
