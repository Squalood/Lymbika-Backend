#!/usr/bin/env bash
# Da a una persona autonomía sobre el almacenamiento de media, sin acceso de
# administrador: purgar la caché del CDN, ajustar sus cabeceras, configurar el
# bucket y rotar la clave de la aplicación.
#
# Lo ejecuta alguien con permisos de IAM, en AWS CloudShell.
#
# Uso:
#   bash aws-permisos.sh                      # lista los usuarios y sale
#   IAM_USER=nombre bash aws-permisos.sh      # crea la política y la asigna

set -euo pipefail

IAM_USER="${IAM_USER:-}"
POLICY_NAME="${POLICY_NAME:-LymbikaMediaOperacion}"
BUCKET="${BUCKET:-lymbika-media}"
CDN_HOST="${CDN_HOST:-d37j77u022tl8g.cloudfront.net}"
APP_USER="${APP_USER:-lymbika-strapi-media}"

if [ -z "$IAM_USER" ]; then
  echo "Indicá a qué usuario asignar los permisos. Usuarios en esta cuenta:"
  echo ""
  aws iam list-users --query 'Users[].UserName' --output text | tr '\t' '\n' | sed 's/^/  /'
  echo ""
  echo "Después corré:  IAM_USER=<nombre> bash aws-permisos.sh"
  exit 1
fi

aws iam get-user --user-name "$IAM_USER" >/dev/null
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "cuenta: $ACCOUNT_ID   usuario: $IAM_USER"

# Se localiza la distribución por su dominio para poder acotar los permisos de
# escritura a esa sola, en lugar de a todo CloudFront.
DIST_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?DomainName=='$CDN_HOST'].Id | [0]" --output text 2>/dev/null || echo "None")"

if [ "$DIST_ID" = "None" ] || [ -z "$DIST_ID" ]; then
  echo "AVISO: no se encontró una distribución con el dominio $CDN_HOST."
  echo "       Los permisos de escritura del CDN quedarán sobre todas las distribuciones."
  DIST_ARN="*"
else
  echo "distribución: $DIST_ID"
  DIST_ARN="arn:aws:cloudfront::$ACCOUNT_ID:distribution/$DIST_ID"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/politica.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VerLaConfiguracionDelCDN",
      "Effect": "Allow",
      "Action": ["cloudfront:Get*", "cloudfront:List*"],
      "Resource": "*"
    },
    {
      "Sid": "PurgarCacheYAjustarCabeceras",
      "Effect": "Allow",
      "Action": ["cloudfront:CreateInvalidation", "cloudfront:UpdateDistribution"],
      "Resource": "$DIST_ARN"
    },
    {
      "Sid": "ConfigurarElBucketDeMedia",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketCors", "s3:PutBucketCors", "s3:GetBucketPolicy",
        "s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::$BUCKET",
        "arn:aws:s3:::$BUCKET/*"
      ]
    },
    {
      "Sid": "RotarLaClaveDeLaAplicacion",
      "Effect": "Allow",
      "Action": ["iam:ListAccessKeys", "iam:CreateAccessKey", "iam:DeleteAccessKey"],
      "Resource": "arn:aws:iam::$ACCOUNT_ID:user/$APP_USER"
    }
  ]
}
JSON

POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/$POLICY_NAME"

if aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  echo "la política ya existe: se le agrega una versión nueva y se activa"
  aws iam create-policy-version --policy-arn "$POLICY_ARN" \
    --policy-document "file://$TMP/politica.json" --set-as-default >/dev/null
else
  aws iam create-policy --policy-name "$POLICY_NAME" \
    --policy-document "file://$TMP/politica.json" \
    --description "Operar el almacenamiento de media de Lymbika sin acceso de administrador" >/dev/null
  echo "política creada: $POLICY_NAME"
fi

aws iam attach-user-policy --user-name "$IAM_USER" --policy-arn "$POLICY_ARN"

echo ""
echo "políticas asignadas ahora a $IAM_USER:"
aws iam list-attached-user-policies --user-name "$IAM_USER" \
  --query 'AttachedPolicies[].PolicyName' --output text | tr '\t' '\n' | sed 's/^/  /'
echo ""
echo "Listo. Alcance: sólo el bucket $BUCKET, la distribución de CloudFront que"
echo "lo sirve, y la rotación de claves del usuario $APP_USER. Nada más de la cuenta."
