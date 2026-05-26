#!/usr/bin/env bash
set -euo pipefail

PROJECT=neato-os
RUNTIME_SA_NAME=hive-releases-api
RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SECRETS=(
  hive-releases-db-password
  hive-releases-clerk-secret-key
  hive-releases-clerk-webhook-secret
)
PLACEHOLDER_VALUE='placeholder-replace-at-A.5-or-v1.5.x'

echo "==> Verifying runtime SA ${RUNTIME_SA_EMAIL}..."
if gcloud iam service-accounts describe "${RUNTIME_SA_EMAIL}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "==> Runtime SA already exists. Skipping."
else
  echo "==> Creating runtime SA..."
  gcloud iam service-accounts create "${RUNTIME_SA_NAME}" \
    --display-name='hive-releases-api runtime SA (Cloud Run)' \
    --project="${PROJECT}"
fi

echo "==> Granting roles/cloudsql.client to runtime SA (idempotent)..."
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role='roles/cloudsql.client' \
  --condition=None \
  --quiet

for SECRET in "${SECRETS[@]}"; do
  echo "==> Verifying Secret Manager placeholder ${SECRET}..."
  if gcloud secrets describe "${SECRET}" --project="${PROJECT}" >/dev/null 2>&1; then
    echo "==> Secret ${SECRET} already exists. Skipping creation."
  else
    echo "==> Creating placeholder secret ${SECRET}..."
    printf '%s' "${PLACEHOLDER_VALUE}" | gcloud secrets create "${SECRET}" \
      --data-file=- \
      --replication-policy='automatic' \
      --project="${PROJECT}"
  fi

  echo "==> Granting roles/secretmanager.secretAccessor to runtime SA on ${SECRET} (idempotent)..."
  gcloud secrets add-iam-policy-binding "${SECRET}" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role='roles/secretmanager.secretAccessor' \
    --condition=None \
    --project="${PROJECT}" \
    --quiet
done

echo "==> 04-cloud-run.sh complete."
echo "    Runtime SA: ${RUNTIME_SA_EMAIL}"
echo "    Secrets: ${SECRETS[*]}"
echo "    Cloud Run service will be created on first cloudbuild.yaml deploy run."
