{{- define "the-artifact.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "the-artifact.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "the-artifact.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "the-artifact.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels of one component: (list $ "app") */}}
{{- define "the-artifact.selectorLabels" -}}
{{- $ := index . 0 -}}
app.kubernetes.io/name: {{ include "the-artifact.name" $ }}
app.kubernetes.io/instance: {{ $.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end }}

{{- define "the-artifact.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "the-artifact.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "the-artifact.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag | toString) }}
{{- end }}

{{- define "the-artifact.appUrl" -}}
{{- if .Values.appUrl }}
{{- .Values.appUrl | trimSuffix "/" }}
{{- else if .Values.ingress.enabled }}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host }}
{{- else }}
{{- print "http://localhost:8080" }}
{{- end }}
{{- end }}

{{- define "the-artifact.trustProxy" -}}
{{- $v := .Values.trustProxy | toString }}
{{- if or (eq $v "") (eq $v "<nil>") }}
{{- ternary "true" "false" .Values.ingress.enabled }}
{{- else }}
{{- $v }}
{{- end }}
{{- end }}

{{- define "the-artifact.postgresqlName" -}}
{{- printf "%s-postgresql" (include "the-artifact.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "the-artifact.minioName" -}}
{{- printf "%s-minio" (include "the-artifact.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "the-artifact.postgresqlSecretName" -}}
{{- default (include "the-artifact.postgresqlName" .) .Values.postgresql.auth.existingSecret }}
{{- end }}

{{- define "the-artifact.minioSecretName" -}}
{{- default (include "the-artifact.minioName" .) .Values.minio.existingSecret }}
{{- end }}

{{/*
A secret value that stays the same across upgrades: the one given in values, else the one the
Secret already holds, else a new random one. (list $ given secretName key)
*/}}
{{- define "the-artifact.stableSecret" -}}
{{- $ := index . 0 -}}
{{- $given := index . 1 }}
{{- if $given }}
{{- $given }}
{{- else }}
{{- $existing := lookup "v1" "Secret" $.Release.Namespace (index . 2) }}
{{- $current := "" }}
{{- if and $existing $existing.data }}
{{- $current = index $existing.data (index . 3) | default "" | b64dec }}
{{- end }}
{{- $current | default (randAlphaNum 32) }}
{{- end }}
{{- end }}

{{- define "the-artifact.metricsTokenGenerated" -}}
{{- if and .Values.metrics.serviceMonitor.enabled (not .Values.metrics.token) (not .Values.existingSecret) }}true{{ end }}
{{- end }}

{{/* The app's settings, shared by the app and the container that waits for its services */}}
{{- define "the-artifact.env" -}}
- name: APP_URL
  value: {{ include "the-artifact.appUrl" . | quote }}
{{- with .Values.contentOrigin }}
- name: CONTENT_ORIGIN
  value: {{ . | quote }}
{{- end }}
- name: SELF_HOSTED
  value: {{ .Values.selfHosted | toString | quote }}
- name: TRUST_PROXY
  value: {{ include "the-artifact.trustProxy" . | quote }}
{{- if not .Values.releaseCheck }}
- name: RELEASE_CHECK
  value: 'false'
{{- end }}
{{- with .Values.rateLimits }}
- name: RATE_LIMITS
  value: {{ . | quote }}
{{- end }}
{{- with .Values.workspaceQuota.maxPages | toString }}
{{- if ne . "" }}
- name: WORKSPACE_MAX_PAGES
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- with .Values.workspaceQuota.maxVersions | toString }}
{{- if ne . "" }}
- name: WORKSPACE_MAX_VERSIONS
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- with .Values.workspaceQuota.maxStorage }}
- name: WORKSPACE_MAX_STORAGE
  value: {{ . | quote }}
{{- end }}
{{- if .Values.smtp.host }}
- name: SMTP_HOST
  value: {{ .Values.smtp.host | quote }}
- name: SMTP_PORT
  value: {{ .Values.smtp.port | toString | quote }}
- name: SMTP_SECURE
  value: {{ .Values.smtp.secure | toString | quote }}
{{- with .Values.smtp.user }}
- name: SMTP_USER
  value: {{ . | quote }}
{{- end }}
{{- with .Values.smtp.from }}
- name: SMTP_FROM
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- with .Values.google.clientId }}
- name: GOOGLE_CLIENT_ID
  value: {{ . | quote }}
{{- end }}
{{- if not .Values.thumbnails.enabled }}
- name: CHROME_PATH
  value: ''
{{- end }}
{{- with .Values.thumbnails.cdnHosts }}
- name: THUMBNAIL_CDN_HOSTS
  value: {{ . | quote }}
{{- end }}
{{- if .Values.thumbnails.enabled }}
- name: THUMBNAIL_CONCURRENCY
  value: {{ .Values.thumbnails.concurrency | default 2 | toString | quote }}
{{- end }}
{{- if .Values.postgresql.enabled }}
- name: DATABASE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "the-artifact.postgresqlSecretName" . }}
      key: {{ ternary .Values.postgresql.auth.existingSecretPasswordKey "password" (ne .Values.postgresql.auth.existingSecret "") }}
- name: DATABASE_URL
  value: {{ printf "postgres://%s:$(DATABASE_PASSWORD)@%s:5432/%s" .Values.postgresql.auth.username (include "the-artifact.postgresqlName" .) .Values.postgresql.auth.database | quote }}
{{- else }}
{{- with .Values.externalDatabase }}
{{- if and .existingSecret .existingSecretUrlKey }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .existingSecret }}
      key: {{ .existingSecretUrlKey }}
{{- else if and .existingSecret (not .url) }}
- name: DATABASE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .existingSecret }}
      key: {{ .existingSecretPasswordKey }}
- name: DATABASE_URL
  value: {{ printf "postgres://%s:$(DATABASE_PASSWORD)@%s:%v/%s%s" .user (required "Set externalDatabase.host (or externalDatabase.url) when postgresql.enabled is false." .host) .port .database (ternary (printf "?%s" .params) "" (ne .params "")) | quote }}
{{- end }}
{{- if not .prepare }}
- name: DATABASE_PREPARE
  value: 'false'
{{- end }}
{{- end }}
{{- end }}
{{- if .Values.minio.enabled }}
- name: S3_ENDPOINT
  value: {{ printf "http://%s:9000" (include "the-artifact.minioName" .) | quote }}
- name: S3_REGION
  value: us-east-1
- name: S3_BUCKET
  value: {{ .Values.minio.bucket | quote }}
- name: S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "the-artifact.minioSecretName" . }}
      key: root-user
- name: S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "the-artifact.minioSecretName" . }}
      key: root-password
{{- else }}
{{- with .Values.externalS3 }}
{{- with .endpoint }}
- name: S3_ENDPOINT
  value: {{ . | quote }}
{{- end }}
- name: S3_REGION
  value: {{ .region | quote }}
- name: S3_BUCKET
  value: {{ required "Set externalS3.bucket when minio.enabled is false." .bucket | quote }}
{{- if .existingSecret }}
- name: S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ .existingSecret }}
      key: {{ .existingSecretAccessKeyIdKey }}
- name: S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .existingSecret }}
      key: {{ .existingSecretSecretAccessKeyKey }}
{{- end }}
{{- with .publicEndpoint }}
- name: S3_PUBLIC_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "the-artifact.envFrom" -}}
- secretRef:
    name: {{ include "the-artifact.fullname" . }}
{{- with .Values.existingSecret }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- end }}
