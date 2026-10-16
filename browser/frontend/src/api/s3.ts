import { fetchJson } from './sharedFetch';

const API_BASE = '/api';

export interface S3Status {
  available: boolean;
  configured: boolean;
  profile?: string | null;
  region?: string;
  /** S3-compatible endpoint (R2, B2, MinIO, ...); null for AWS. */
  endpoint_url?: string | null;
  error?: string;
  message?: string;
}

export interface S3ConfigureResult {
  success: boolean;
  profile?: string | null;
  region?: string;
  endpoint_url?: string | null;
  method?: string;
  error?: string;
}

export interface S3TestResult {
  accessible: boolean;
  size?: number;
  content_type?: string;
  last_modified?: string;
  error?: string;
}

export interface S3Object {
  key: string;
  size: number;
  last_modified: string;
}

export interface S3ListResult {
  success: boolean;
  bucket?: string;
  prefix?: string;
  objects?: S3Object[];
  truncated?: boolean;
  error?: string;
}

export async function getS3Status(): Promise<S3Status> {
  return fetchJson(`${API_BASE}/s3/status`);
}

export async function configureS3(profile?: string, region?: string, endpointUrl?: string): Promise<S3ConfigureResult> {
  const params = new URLSearchParams();
  if (profile) params.set('profile', profile);
  if (region) params.set('region', region);
  if (endpointUrl) params.set('endpoint_url', endpointUrl);
  const url = params.toString()
    ? `${API_BASE}/s3/configure?${params}`
    : `${API_BASE}/s3/configure`;
  return fetchJson(url, { method: 'POST' });
}

export async function testS3Access(url: string): Promise<S3TestResult> {
  const params = new URLSearchParams({ url });
  return fetchJson(`${API_BASE}/s3/test?${params}`);
}

export async function listS3Bucket(
  bucket: string,
  prefix = '',
  maxKeys = 100,
): Promise<S3ListResult> {
  const params = new URLSearchParams({
    bucket,
    prefix,
    max_keys: maxKeys.toString(),
  });
  return fetchJson(`${API_BASE}/s3/list?${params}`);
}

export async function getPresignedUrl(
  url: string,
  expiration = 3600,
): Promise<{ success: boolean; url?: string; expiration_seconds?: number; error?: string }> {
  const params = new URLSearchParams({
    url,
    expiration: expiration.toString(),
  });
  return fetchJson(`${API_BASE}/s3/presign?${params}`);
}
