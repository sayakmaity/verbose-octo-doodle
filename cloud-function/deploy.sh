#!/bin/bash
set -euo pipefail

USAGE="Usage: ./deploy.sh <gcp-project-id> <allowed-gmail-addresses, comma-separated> [--rotate-vapid]
       (ALLOWED_EMAILS may also come from the environment)"
ROTATE_VAPID=false
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --rotate-vapid) ROTATE_VAPID=true ;;
    -*) echo "Unknown option: $arg" >&2; echo "$USAGE" >&2; exit 1 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
PROJECT_ID="${POSITIONAL[0]:-}"
# Only these Gmail accounts may register push subscriptions (register-push is
# publicly reachable; it verifies the caller's Google token against this list).
ALLOWED_EMAILS="${POSITIONAL[1]:-${ALLOWED_EMAILS:-}}"
[[ -n "$PROJECT_ID" && -n "$ALLOWED_EMAILS" ]] || { echo "$USAGE" >&2; exit 1; }
IFS=',' read -ra _emails <<< "$ALLOWED_EMAILS"
for e in "${_emails[@]}"; do
  e="${e// /}"
  [[ "$e" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "ERROR: '$e' in ALLOWED_EMAILS is not an email address" >&2; exit 1; }
done
TOPIC_NAME="gmail-code-push"

# Run from this script's directory: .env.yaml and --source=. are relative.
cd "$(dirname "$0")"

echo "==> Enabling required APIs..."
gcloud services enable \
  gmail.googleapis.com \
  cloudfunctions.googleapis.com \
  pubsub.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  eventarc.googleapis.com \
  firestore.googleapis.com \
  --project="$PROJECT_ID"

# Check existence explicitly instead of treating every create failure as
# "already exists" (which hid real errors like missing permissions).
echo "==> Creating Firestore database..."
if gcloud firestore databases describe --database='(default)' --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "    (already exists)"
else
  gcloud firestore databases create --location=us-central1 --project="$PROJECT_ID"
fi

echo "==> Creating Pub/Sub topic '$TOPIC_NAME'..."
if gcloud pubsub topics describe "$TOPIC_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "    (already exists)"
else
  gcloud pubsub topics create "$TOPIC_NAME" --project="$PROJECT_ID"
fi

echo "==> Granting Gmail push publish access..."
gcloud pubsub topics add-iam-policy-binding "$TOPIC_NAME" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher" \
  --project="$PROJECT_ID"

# Reuse existing VAPID keys — regenerating invalidates the extension's push
# subscription (it was created with the old applicationServerKey).
extract_yaml_value() {
  # Tolerates CRLF line endings, surrounding whitespace, and single/double
  # quotes; prints nothing if the key is absent.
  tr -d '\r' < .env.yaml | sed -n "s/^[[:space:]]*$1[[:space:]]*:[[:space:]]*[\"']\{0,1\}\([A-Za-z0-9_-]*\)[\"']\{0,1\}[[:space:]]*\$/\1/p"
}
VAPID_PUBLIC=""
VAPID_PRIVATE=""
if [[ -f .env.yaml ]]; then
  VAPID_PUBLIC=$(extract_yaml_value VAPID_PUBLIC_KEY)
  VAPID_PRIVATE=$(extract_yaml_value VAPID_PRIVATE_KEY)
fi
# A real key pair: public = 65-byte uncompressed P-256 point (0x04 prefix),
# private = 32 bytes, both base64url. Rejects placeholders like
# YOUR_VAPID_PUBLIC_KEY, which would otherwise be deployed over the live keys.
valid_vapid() {
  node -e '
    const b = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const [pub, priv] = process.argv.slice(1).map(b);
    process.exit(pub.length === 65 && pub[0] === 4 && priv.length === 32 ? 0 : 1);
  ' "$1" "$2"
}
if [[ "$ROTATE_VAPID" == false ]] && ! valid_vapid "$VAPID_PUBLIC" "$VAPID_PRIVATE"; then
  # The local file is missing/placeholder but the deployed function may hold
  # the real keys — recover them rather than breaking the live push channel.
  LIVE_PUBLIC=$(gcloud functions describe gmail-push-handler --gen2 --region=us-central1 --project="$PROJECT_ID" \
    --format='value(serviceConfig.environmentVariables.VAPID_PUBLIC_KEY)' 2>/dev/null || true)
  LIVE_PRIVATE=$(gcloud functions describe gmail-push-handler --gen2 --region=us-central1 --project="$PROJECT_ID" \
    --format='value(serviceConfig.environmentVariables.VAPID_PRIVATE_KEY)' 2>/dev/null || true)
  if valid_vapid "$LIVE_PUBLIC" "$LIVE_PRIVATE"; then
    [[ -f .env.yaml ]] && cp .env.yaml ".env.yaml.bak.$(date +%Y%m%d%H%M%S)"
    VAPID_PUBLIC="$LIVE_PUBLIC"
    VAPID_PRIVATE="$LIVE_PRIVATE"
    ( umask 077; cat > .env.yaml <<EOF
VAPID_PUBLIC_KEY: "$VAPID_PUBLIC"
VAPID_PRIVATE_KEY: "$VAPID_PRIVATE"
EOF
    )
    chmod 600 .env.yaml
    echo "==> Local .env.yaml had no valid VAPID keys — restored the live keys from the deployed function"
  fi
fi
if [[ "$ROTATE_VAPID" == false ]] && valid_vapid "$VAPID_PUBLIC" "$VAPID_PRIVATE"; then
  echo "==> Reusing existing VAPID keys"
elif [[ -f .env.yaml && "$ROTATE_VAPID" == false ]]; then
  # Never silently regenerate: new keys break the live push channel until
  # VAPID_PUBLIC_KEY in the extension's config.js is updated and the
  # extension reloaded, and the old private key would be lost.
  echo "ERROR: .env.yaml exists but has no valid VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY," >&2
  echo "       and no valid keys could be read from the deployed gmail-push-handler." >&2
  echo "       Fix the file, or re-run with --rotate-vapid to generate new keys" >&2
  echo "       (then update VAPID_PUBLIC_KEY in config.js and reload the extension)." >&2
  exit 1
else
  if [[ -f .env.yaml ]]; then
    BACKUP=".env.yaml.bak.$(date +%Y%m%d%H%M%S)"
    cp .env.yaml "$BACKUP"
    echo "==> Rotating VAPID keys (old file backed up to $BACKUP)"
  fi
  echo "==> Generating VAPID keys..."
  VAPID_KEYS=$(npx web-push generate-vapid-keys --json 2>/dev/null)
  VAPID_PUBLIC=$(echo "$VAPID_KEYS" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).publicKey)")
  VAPID_PRIVATE=$(echo "$VAPID_KEYS" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).privateKey)")

  ( umask 077; cat > .env.yaml <<EOF
VAPID_PUBLIC_KEY: "$VAPID_PUBLIC"
VAPID_PRIVATE_KEY: "$VAPID_PRIVATE"
EOF
  )
  chmod 600 .env.yaml
fi

# Per-deploy env file: VAPID keys + the allow-list. Kept out of the source
# upload by .gcloudignore; gcloud reads it locally.
DEPLOY_ENV=$(mktemp)
trap 'rm -f "$DEPLOY_ENV"' EXIT
cat > "$DEPLOY_ENV" <<EOF
VAPID_PUBLIC_KEY: "$VAPID_PUBLIC"
VAPID_PRIVATE_KEY: "$VAPID_PRIVATE"
ALLOWED_EMAILS: "$ALLOWED_EMAILS"
EOF

# register-push first: the handler only delivers to subscriptions registered
# through it, so the registration endpoint must be live before the handler.
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
  --env-vars-file="$DEPLOY_ENV"

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
  --env-vars-file="$DEPLOY_ENV"

# Print the cloudfunctions.net URL (not serviceConfig.uri, the run.app one):
# it's what the extension's host_permissions allow, and the extension's
# requests rely on host_permissions since register-push sends no CORS headers.
REGISTER_URL="https://us-central1-$PROJECT_ID.cloudfunctions.net/register-push"

echo ""
echo "========================================="
echo "Done! Update your Chrome extension with:"
echo ""
echo "  GCP_TOPIC_NAME = 'projects/$PROJECT_ID/topics/$TOPIC_NAME'"
echo "  VAPID_PUBLIC_KEY = '$VAPID_PUBLIC'"
echo "  REGISTER_PUSH_URL = '$REGISTER_URL'"
echo "========================================="
