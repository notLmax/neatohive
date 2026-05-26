#!/usr/bin/env bash
set -euo pipefail

PROJECT=neato-os
TRIGGER_NAME=hive-releases-api-deploy
REPO_OWNER=anthonyconnelly
REPO_NAME=neato-hive
BRANCH_PATTERN='^main$'
BUILD_CONFIG=services/hive-releases-api/cloudbuild.yaml
REGION=global

PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
TRIGGER_STATUS='configured'

echo "==> Verifying Cloud Build trigger '${TRIGGER_NAME}'..."
if gcloud builds triggers describe "${TRIGGER_NAME}" --project="${PROJECT}" --region="${REGION}" >/dev/null 2>&1; then
  echo "==> Trigger '${TRIGGER_NAME}' already configured. Skipping."
else
  echo "==> Creating trigger '${TRIGGER_NAME}'..."
  set +e
  CREATE_OUTPUT=$(
    gcloud builds triggers create github \
      --name="${TRIGGER_NAME}" \
      --repo-name="${REPO_NAME}" \
      --repo-owner="${REPO_OWNER}" \
      --branch-pattern="${BRANCH_PATTERN}" \
      --build-config="${BUILD_CONFIG}" \
      --project="${PROJECT}" \
      --region="${REGION}" \
      --include-logs-with-status 2>&1
  )
  CREATE_EXIT=$?
  set -e

  if [ "${CREATE_EXIT}" -eq 0 ]; then
    echo "${CREATE_OUTPUT}"
  else
    TRIGGER_STATUS='deferred'
    echo "${CREATE_OUTPUT}"
    echo "==> Trigger creation deferred: GitHub App / Cloud Build connection for ${REPO_OWNER}/${REPO_NAME} is not installed yet."
    echo "==> Owner-side TODO: install the Cloud Build GitHub App for ${REPO_OWNER}/${REPO_NAME}, then re-run this script."
  fi
fi

for ROLE in roles/run.admin roles/iam.serviceAccountUser; do
  echo "==> Granting ${ROLE} to ${CLOUDBUILD_SA} (idempotent)..."
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${CLOUDBUILD_SA}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet
done

echo "==> 05-cloud-build-trigger.sh complete."
echo "    Trigger: ${TRIGGER_NAME} (${TRIGGER_STATUS})"
echo "    Cloud Build SA: ${CLOUDBUILD_SA}"
if [ "${TRIGGER_STATUS}" = 'deferred' ]; then
  echo "    Trigger create step: deferred pending owner GitHub App install for ${REPO_OWNER}/${REPO_NAME}."
fi
