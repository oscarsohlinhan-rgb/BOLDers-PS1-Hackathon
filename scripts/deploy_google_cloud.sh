#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GCP_REGION:-asia-southeast1}"
API_SERVICE="${API_SERVICE:-ps1-api}"
WEB_SERVICE="${WEB_SERVICE:-ps1-web}"
API_SERVICE_ACCOUNT="${API_SERVICE_ACCOUNT:-ps1-api-runtime}"

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "usage: $0 <google-cloud-project-id>" >&2
  exit 2
fi

command -v gcloud >/dev/null 2>&1 || {
  echo "gcloud is required" >&2
  exit 2
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_STAGE="$(mktemp -d)"
cleanup() {
  rm -rf -- "${WEB_STAGE}"
}
trap cleanup EXIT

gcloud config set project "${PROJECT_ID}" >/dev/null
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com \
  --project "${PROJECT_ID}"

API_SERVICE_ACCOUNT_EMAIL="${API_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "${API_SERVICE_ACCOUNT_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${API_SERVICE_ACCOUNT}" \
    --project "${PROJECT_ID}" \
    --display-name "Project TAO API runtime"
fi
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${API_SERVICE_ACCOUNT_EMAIL}" \
  --role roles/aiplatform.user \
  --condition=None \
  --quiet >/dev/null

gcloud run deploy "${API_SERVICE}" \
  --source "${REPO_ROOT}/api" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --platform managed \
  --service-account "${API_SERVICE_ACCOUNT_EMAIL}" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=global,GOOGLE_GENAI_USE_VERTEXAI=True,VERTEX_GEMINI_MODEL=gemini-2.5-flash" \
  --allow-unauthenticated \
  --cpu 1 \
  --memory 1Gi \
  --concurrency 10 \
  --timeout 120 \
  --min-instances 0 \
  --max-instances 2 \
  --quiet

API_URL="$(gcloud run services describe "${API_SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='value(status.url)')"

tar -C "${REPO_ROOT}/web" \
  --exclude=node_modules \
  --exclude=.next \
  --exclude='.env*' \
  -cf - . | tar -C "${WEB_STAGE}" -xf -
printf 'API_INTERNAL_URL=%s\n' "${API_URL}" > "${WEB_STAGE}/.env.production"

gcloud run deploy "${WEB_SERVICE}" \
  --source "${WEB_STAGE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --cpu 1 \
  --memory 512Mi \
  --concurrency 40 \
  --timeout 120 \
  --min-instances 0 \
  --max-instances 2 \
  --set-env-vars "API_INTERNAL_URL=${API_URL}" \
  --quiet

WEB_URL="$(gcloud run services describe "${WEB_SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='value(status.url)')"

printf 'API_URL=%s\nWEB_URL=%s\n' "${API_URL}" "${WEB_URL}"
