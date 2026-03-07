#!/bin/bash
set -euo pipefail

PROJECT_ID="${1:?Usage: ./deploy.sh <gcp-project-id>}"
TOPIC_NAME="gmail-code-push"

echo "==> Enabling required APIs..."
gcloud services enable \
  gmail.googleapis.com \
  cloudfunctions.googleapis.com \
  pubsub.googleapis.com \
  fcm.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  eventarc.googleapis.com \
  firebase.googleapis.com \
  firestore.googleapis.com \
  --project="$PROJECT_ID"

echo "==> Adding Firebase to the project..."
curl -s -X POST "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID:addFirebase" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "X-Goog-User-Project: $PROJECT_ID" \
  -H "Content-Type: application/json" || true

echo "==> Creating Firestore database..."
gcloud firestore databases create --location=us-central1 --project="$PROJECT_ID" 2>/dev/null || echo "    (already exists)"

echo "==> Creating Pub/Sub topic '$TOPIC_NAME'..."
gcloud pubsub topics create "$TOPIC_NAME" --project="$PROJECT_ID" 2>/dev/null || echo "    (already exists)"

echo "==> Granting Gmail push publish access..."
gcloud pubsub topics add-iam-policy-binding "$TOPIC_NAME" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher" \
  --project="$PROJECT_ID"

echo "==> Generating VAPID keys..."
VAPID_KEYS=$(npx web-push generate-vapid-keys --json 2>/dev/null)
VAPID_PUBLIC=$(echo "$VAPID_KEYS" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).publicKey)")
VAPID_PRIVATE=$(echo "$VAPID_KEYS" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).privateKey)")

cat > .env.yaml <<EOF
VAPID_PUBLIC_KEY: "$VAPID_PUBLIC"
VAPID_PRIVATE_KEY: "$VAPID_PRIVATE"
EOF

echo "==> Deploying gmail-push-handler (Pub/Sub triggered)..."
gcloud functions deploy gmail-push-handler \
  --gen2 \
  --runtime=nodejs22 \
  --trigger-topic="$TOPIC_NAME" \
  --entry-point=gmailPushHandler \
  --region=us-central1 \
  --memory=256MB \
  --timeout=30s \
  --project="$PROJECT_ID" \
  --source=. \
  --env-vars-file=.env.yaml

echo "==> Deploying register-push (HTTP triggered)..."
gcloud functions deploy register-push \
  --gen2 \
  --runtime=nodejs22 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point=registerPush \
  --region=us-central1 \
  --memory=256MB \
  --timeout=30s \
  --project="$PROJECT_ID" \
  --source=. \
  --env-vars-file=.env.yaml

REGISTER_URL=$(gcloud functions describe register-push --gen2 --region=us-central1 --project="$PROJECT_ID" --format="value(serviceConfig.uri)")

echo ""
echo "========================================="
echo "Done! Update your Chrome extension with:"
echo ""
echo "  GCP_TOPIC_NAME = 'projects/$PROJECT_ID/topics/$TOPIC_NAME'"
echo "  VAPID_PUBLIC_KEY = '$VAPID_PUBLIC'"
echo "  REGISTER_PUSH_URL = '$REGISTER_URL'"
echo "========================================="
