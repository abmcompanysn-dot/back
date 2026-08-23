#!/bin/bash
# ============================================================
# Exécuté une seule fois par le conteneur postgres
# (docker-entrypoint-initdb.d) : crée les 10 bases dédiées.
# Principe microservices : une base par service, jamais partagée.
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
  miad_admin
  miad_users
)

for db in "${DATABASES[@]}"; do
  echo "→ création de la base $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE $db OWNER $POSTGRES_USER;
EOSQL
done

echo "→ 10 bases prêtes."
