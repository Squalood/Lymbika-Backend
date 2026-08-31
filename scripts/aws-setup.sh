#!/usr/bin/env bash
# Crea la infraestructura de media de Lymbika en AWS: bucket privado de S3,
# distribución de CloudFront que lo sirve, y un usuario IAM con acceso sólo a
# ese bucket para que Strapi suba archivos.
#
# Pensado para pegarse en AWS CloudShell con una sesión de administrador.
# Imprime al final los cinco valores que hay que copiar al .env.
#
# El bucket queda con las cuatro protecciones de acceso público activas: el
# Origin Access Control de CloudFront no cuenta como acceso público, así que
# funciona sin relajarlas.

set -euo pipefail

BUCKET="${BUCKET:-lymbika-media}"
REGION="${REGION:-us-east-1}"
IAM_USER="${IAM_USER:-lymbika-strapi-media}"
POLICY_NAME="${POLICY_NAME:-LymbikaMediaReadWrite}"

# Política de caché administrada "CachingOptimized" de AWS
CACHE_POLICY_ID="658327ea-f89d-4fab-a63d-7e88639e58f6"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== 1/6  Bucket S3 =="
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "   $BUCKET ya existe en esta cuenta, se reutiliza."
else
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  echo "   Creado: $BUCKET ($REGION)"
fi

# Las cuatro activas. CloudFront entra por OAC, que no es acceso público.
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null
echo "   Acceso público bloqueado (4/4)."

echo "== 2/6  Origin Access Control =="
OAC_ID="$(aws cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?Name=='$BUCKET-oac'].Id | [0]" --output text 2>/dev/null || echo "None")"
if [ "$OAC_ID" = "None" ] || [ -z "$OAC_ID" ]; then
  # Por JSON y no por sintaxis abreviada: la descripción lleva espacios y el
  # parser abreviado del CLI los interpreta mal.
  cat > "$TMP/oac.json" <<JSON
{
  "Name": "$BUCKET-oac",
  "Description": "Acceso de CloudFront al bucket de media de Lymbika",
  "SigningProtocol": "sigv4",
  "SigningBehavior": "always",
  "OriginAccessControlOriginType": "s3"
}
JSON
  OAC_ID="$(aws cloudfront create-origin-access-control \
    --origin-access-control-config "file://$TMP/oac.json" \
    --query 'OriginAccessControl.Id' --output text)"
fi
echo "   OAC: $OAC_ID"

echo "== 3/6  Distribución de CloudFront =="
cat > "$TMP/dist.json" <<JSON
{
  "CallerReference": "$BUCKET-$(date +%s)",
  "Comment": "Media de Lymbika (Strapi)",
  "Enabled": true,
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "s3-$BUCKET",
      "DomainName": "$BUCKET.s3.$REGION.amazonaws.com",
      "OriginAccessControlId": "$OAC_ID",
      "S3OriginConfig": { "OriginAccessIdentity": "" }
    }]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-$BUCKET",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] },
    "Compress": true,
    "CachePolicyId": "$CACHE_POLICY_ID"
  },
  "PriceClass": "PriceClass_100"
}
JSON

# Dos campos en una llamada, con --query: así el script no depende de python.
read -r DIST_ID DIST_DOMAIN <<<"$(aws cloudfront create-distribution \
  --distribution-config "file://$TMP/dist.json" \
  --query 'Distribution.[Id,DomainName]' --output text)"
echo "   Distribución: $DIST_ID  ->  $DIST_DOMAIN"

echo "== 4/6  Política del bucket (sólo esta distribución puede leer) =="
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
cat > "$TMP/policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "SoloCloudFront",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::$BUCKET/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::$ACCOUNT_ID:distribution/$DIST_ID"
      }
    }
  }]
}
JSON
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$TMP/policy.json"
echo "   Aplicada."

echo "== 5/6  Usuario IAM para Strapi =="
POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/$POLICY_NAME"
if ! aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  cat > "$TMP/iam.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::$BUCKET/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::$BUCKET"
    }
  ]
}
JSON
  aws iam create-policy --policy-name "$POLICY_NAME" \
    --policy-document "file://$TMP/iam.json" >/dev/null
fi
aws iam get-user --user-name "$IAM_USER" >/dev/null 2>&1 || aws iam create-user --user-name "$IAM_USER" >/dev/null
aws iam attach-user-policy --user-name "$IAM_USER" --policy-arn "$POLICY_ARN"
read -r AKID SECRET <<<"$(aws iam create-access-key --user-name "$IAM_USER" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)"
echo "   Usuario $IAM_USER listo."

echo "== 6/6  Prueba de subida =="
echo "ok $(date)" > "$TMP/_prueba.txt"
aws s3 cp "$TMP/_prueba.txt" "s3://$BUCKET/_prueba.txt" >/dev/null
echo "   Subida correcta."

cat <<RESUMEN

=====================  COPIAR AL .env  =====================
AWS_BUCKET=$BUCKET
AWS_REGION=$REGION
AWS_ACCESS_KEY_ID=$AKID
AWS_SECRET_ACCESS_KEY=$SECRET
AWS_CDN_URL=https://$DIST_DOMAIN
============================================================

El secret NO se vuelve a mostrar. Copialo ahora.

CloudFront tarda 5-15 min en desplegarse. Cuando termine, esta URL
debe devolver "ok" con la fecha:
  https://$DIST_DOMAIN/_prueba.txt
RESUMEN
