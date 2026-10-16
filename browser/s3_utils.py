"""
S3 credential management and URL handling for FiberHMM browser.

Supports reading BAM, BigBed/bigWig and .mcool files from S3 and
S3-compatible stores (Cloudflare R2, Backblaze B2, MinIO, institutional
object stores).

boto3 is the one place S3 settings live (profile, keys, region, endpoint).
Readers never see ``s3://``: every file is opened through an HTTPS URL made
here (``open_url``), pre-signed when the object needs credentials and plain
when the bucket is public. htslib's own S3 support reads a different set of
settings (``HTS_S3_HOST``, ``s3+http://``, no ``endpoint_url`` from the AWS
config file, no SSO or instance roles), so handing it ``s3://`` worked only
for AWS with keys in the environment; anything else opened with zero reads.

Credential sources (boto3's default chain unless given explicitly):
1. Explicit access_key/secret_key
2. AWS profile name (``~/.aws/credentials`` / ``~/.aws/config``, including
   ``endpoint_url`` set in the profile)
3. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
4. IAM role (EC2/ECS/Lambda)
Public buckets need none of these: a signed request that is refused is
retried anonymously.
"""

import os
import threading
import time
from typing import Optional, Tuple, Dict, Any
from urllib.parse import quote

# Optional boto3 import - only needed for S3 functionality
try:
    import boto3
    from botocore.exceptions import ClientError, NoCredentialsError, BotoCoreError, EndpointConnectionError
    from botocore import UNSIGNED
    from botocore.client import Config as BotoConfig
    HAS_BOTO3 = True
except ImportError:
    HAS_BOTO3 = False
    boto3 = None
    UNSIGNED = None
    BotoConfig = None
    ClientError = Exception
    NoCredentialsError = Exception
    BotoCoreError = Exception
    EndpointConnectionError = Exception

# Error codes meaning "these credentials can't read this": try anonymously.
_AUTH_CODES = frozenset({
    '401', '403', 'AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch',
    'InvalidToken', 'ExpiredToken', 'TokenRefreshRequired', 'AllAccessDisabled',
    'InvalidClientTokenId', 'UnrecognizedClientException',
})
# ...of which these say the credentials themselves are wrong (not just not allowed).
_BAD_CREDENTIAL_CODES = frozenset({
    'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidToken', 'ExpiredToken',
    'TokenRefreshRequired', 'InvalidClientTokenId', 'UnrecognizedClientException',
})
_NOT_FOUND_CODES = frozenset({'404', 'NoSuchKey', 'NotFound'})


def _client_config(signature_version='s3v4'):
    """SigV4 (every region accepts it; SigV2 only the oldest), and a store that is
    down is reported in a few seconds rather than after botocore's default
    retries and 60 s timeouts."""
    return BotoConfig(signature_version=signature_version, connect_timeout=5, read_timeout=30,
                      retries={'max_attempts': 2, 'mode': 'standard'})


def _error_code(err) -> str:
    try:
        return str(err.response.get('Error', {}).get('Code', '') or '')
    except AttributeError:
        return ''


def _is_aws_endpoint(url: Optional[str]) -> bool:
    if not url:
        return True
    host = url.split('://', 1)[-1].split('/', 1)[0].split(':', 1)[0].lower()
    return host.endswith('.amazonaws.com') or host.endswith('.amazonaws.com.cn')


class S3Manager:
    """Manages S3 credentials and the URLs readers open.

    Supports three access modes:
    - Signed: standard AWS credentials via profile / env / IAM role.
    - Anonymous (UNSIGNED): public buckets that don't require authentication.
    - Custom endpoint: S3-compatible services (Cloudflare R2, MinIO,
      DigitalOcean Spaces, Backblaze B2) via ``endpoint_url`` (given here,
      or set in the AWS profile / ``AWS_ENDPOINT_URL_S3``).

    For a given request, the signed client is tried first. If it fails
    with ``NoCredentialsError`` or an authorization error, we retry using
    the anonymous client. This lets a single deployment serve private
    buckets for authenticated users AND public buckets with no configuration.
    Which of the two worked is remembered per object, so readers get a
    pre-signed URL for private objects and the plain URL for public ones.
    """

    def __init__(self):
        self._client = None         # signed client (None if no creds)
        self._anon_client = None    # lazy UNSIGNED client for public buckets
        self._session = None        # boto3 session behind the signed client
        self._profile: Optional[str] = None
        self._region: Optional[str] = None
        self._endpoint_url: Optional[str] = None
        self._method: Optional[str] = None
        self._configured = False
        # Bumped by every configure(): answers worked out under older settings
        # (a URL signed for the previous endpoint) are never cached after it.
        self._generation = 0
        self._lock = threading.RLock()
        # Cache for pre-signed URLs (path -> (url, expiration_time))
        self._presigned_cache: Dict[str, Tuple[str, float]] = {}
        # (bucket, key) -> "signed" | "anonymous": how the object was last read.
        self._access_mode: Dict[Tuple[str, str], str] = {}
        # AWS only: bucket -> region (a pre-signed URL must name the bucket's region).
        self._bucket_regions: Dict[str, Optional[str]] = {}
        self._regional_clients: Dict[str, Any] = {}
        # Default expiration for pre-signed URLs (1 hour)
        self._default_expiration = 3600
        # Refresh URLs when they have less than this time remaining
        self._refresh_threshold = 300  # 5 minutes

    @property
    def is_available(self) -> bool:
        """Check if boto3 is available."""
        return HAS_BOTO3

    @property
    def is_configured(self) -> bool:
        """Check if S3 credentials have been configured."""
        return self._configured

    @property
    def generation(self) -> int:
        """Changes whenever the S3 settings change (configure())."""
        return self._generation

    @property
    def endpoint_url(self) -> Optional[str]:
        """The S3-compatible endpoint in use (None for AWS)."""
        return self._endpoint_url

    def configure(
        self,
        profile: Optional[str] = None,
        access_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        region: Optional[str] = None,
        session_token: Optional[str] = None,
        endpoint_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Configure S3 credentials and (optionally) a custom endpoint.

        Args:
            profile: AWS profile name from ~/.aws/credentials
            access_key: AWS access key ID
            secret_key: AWS secret access key
            region: AWS region (default: the profile's, else AWS_DEFAULT_REGION, else us-east-1)
            session_token: Optional session token for temporary credentials
            endpoint_url: S3-compatible endpoint (e.g. Cloudflare R2
                ``https://<account>.r2.cloudflarestorage.com``, MinIO
                ``http://localhost:9000``). Omit for AWS S3, or when the
                profile sets ``endpoint_url`` itself.

        Returns:
            Dict with success status and configuration info. Note: we do
            NOT issue a test API call here. Many valid setups lack the
            ListBuckets permission (or the account has no buckets at all);
            a test would produce spurious failures. Errors surface on
            actual use (``test_access``, ``open_url``).
        """
        if not HAS_BOTO3:
            return {
                "success": False,
                "error": "boto3 not installed. Run: pip install boto3"
            }

        explicit_endpoint = (endpoint_url or os.environ.get('AWS_S3_ENDPOINT_URL') or '').strip() or None
        client_kwargs: Dict[str, Any] = {'config': _client_config()}
        if region:
            client_kwargs['region_name'] = region
        if explicit_endpoint:
            client_kwargs['endpoint_url'] = explicit_endpoint

        try:
            if access_key and secret_key:
                session = boto3.Session(
                    aws_access_key_id=access_key,
                    aws_secret_access_key=secret_key,
                    aws_session_token=session_token,
                )
                profile_name = None
                method = "explicit"
            elif profile:
                session = boto3.Session(profile_name=profile)
                profile_name = profile
                method = "profile"
            else:
                # Default credential chain (env vars, IAM role, etc.). With no
                # credentials at all the client still builds; signed calls
                # raise NoCredentialsError and fall back to anonymous.
                session = boto3.Session()
                profile_name = os.environ.get('AWS_PROFILE')
                method = "default_chain"
            if 'region_name' not in client_kwargs and not session.region_name:
                client_kwargs['region_name'] = os.environ.get('AWS_DEFAULT_REGION') or 'us-east-1'
            client = session.client('s3', **client_kwargs)
        except Exception as e:
            with self._lock:
                self._configured = False
            return {
                "success": False,
                "error": f"Failed to build S3 client: {e}",
            }

        # The endpoint boto3 actually uses: the one given, else one set in the
        # profile or AWS_ENDPOINT_URL(_S3); None means AWS itself.
        effective = explicit_endpoint
        if not effective:
            used = getattr(getattr(client, 'meta', None), 'endpoint_url', None)
            effective = None if _is_aws_endpoint(used) else used
        with self._lock:
            self._session = session
            self._client = client
            self._anon_client = None  # rebuilt for the new endpoint/region on use
            self._profile = profile_name
            self._region = getattr(getattr(client, 'meta', None), 'region_name', None) or region or 'us-east-1'
            self._endpoint_url = effective.rstrip('/') if effective else None
            self._method = method
            self._configured = True
            self._generation += 1
            self._presigned_cache.clear()
            self._access_mode.clear()
            self._bucket_regions.clear()
            self._regional_clients.clear()
        return {
            "success": True,
            "profile": self._profile,
            "region": self._region,
            "endpoint_url": self._endpoint_url,
            "method": method,
        }

    def _ensure_configured(self) -> None:
        if not self._configured:
            self.configure()

    def _get_anon_client(self):
        """Lazy anonymous (UNSIGNED) client for public buckets.

        Uses the same region/endpoint as the signed client, so public-bucket
        reads against R2/MinIO/etc. go to the right endpoint.
        """
        if not HAS_BOTO3:
            return None
        with self._lock:
            if self._anon_client is not None:
                return self._anon_client
            kwargs: Dict[str, Any] = {
                'config': _client_config(signature_version=UNSIGNED),
                'region_name': self._region or 'us-east-1',
            }
            if self._endpoint_url:
                kwargs['endpoint_url'] = self._endpoint_url
            try:
                self._anon_client = boto3.client('s3', **kwargs)
            except Exception:
                self._anon_client = None
            return self._anon_client

    def _try_with_fallback(self, signed_op, anon_op):
        """Run signed_op first; on auth failure, retry anon_op.

        Both args are callables that wrap the actual boto3 call (``anon_op``
        takes the anonymous client). Returns ``(result, used_anonymous,
        error)``; error is None on success. When both fail, the error is the
        more telling one: the signed error when the credentials themselves
        were rejected, else the anonymous one.
        """
        signed_error = None
        if self._client is not None:
            try:
                return (signed_op(), False, None)
            except NoCredentialsError as e:
                signed_error = e
            except ClientError as e:
                if _error_code(e) not in _AUTH_CODES:
                    return (None, False, e)
                signed_error = e  # may be a public bucket we can still read anonymously
            except Exception as e:
                return (None, False, e)
        anon = self._get_anon_client()
        if anon is None:
            return (None, True, signed_error or Exception("Anonymous client unavailable"))
        try:
            return (anon_op(anon), True, None)
        except Exception as e:
            if isinstance(signed_error, ClientError) and _error_code(signed_error) in _BAD_CREDENTIAL_CODES:
                return (None, False, signed_error)
            if isinstance(signed_error, NoCredentialsError) and _error_code(e) in _AUTH_CODES:
                return (None, True, signed_error)  # "not public, and no credentials"
            return (None, True, e)

    # ------------------------------------------------------------------ URLs

    def public_url(self, s3_url: str) -> str:
        """The plain HTTPS URL of an object (works for public buckets only)."""
        bucket, key = self.parse_s3_url(s3_url)
        quoted = quote(key, safe="/~")
        if self._endpoint_url:
            return f"{self._endpoint_url.rstrip('/')}/{bucket}/{quoted}"
        region = self._bucket_regions.get(bucket) or self._region or 'us-east-1'
        if '.' in bucket:  # dotted names break the virtual-hosted TLS certificate
            host = 's3.amazonaws.com' if region == 'us-east-1' else f's3.{region}.amazonaws.com'
            return f"https://{host}/{bucket}/{quoted}"
        if region == 'us-east-1':
            return f"https://{bucket}.s3.amazonaws.com/{quoted}"
        return f"https://{bucket}.s3.{region}.amazonaws.com/{quoted}"

    def _bucket_region(self, bucket: str) -> Optional[str]:
        """AWS only: the bucket's region, from the ``x-amz-bucket-region`` header
        (sent even when the HEAD itself is refused). None when unknown or not AWS."""
        if self._endpoint_url or self._client is None:
            return None
        with self._lock:
            if bucket in self._bucket_regions:
                return self._bucket_regions[bucket]
        generation = self._generation
        region = None
        try:
            response = self._client.head_bucket(Bucket=bucket)
            region = response.get('ResponseMetadata', {}).get('HTTPHeaders', {}).get('x-amz-bucket-region')
        except ClientError as e:
            region = (e.response.get('ResponseMetadata', {}) or {}).get('HTTPHeaders', {}).get('x-amz-bucket-region')
        except Exception:
            region = None
        with self._lock:
            if self._generation == generation:
                self._bucket_regions[bucket] = region
        return region

    def _signing_client(self, bucket: str):
        """The signed client, or one for the bucket's own region (AWS signatures name it)."""
        region = self._bucket_region(bucket)
        if not region or region == self._region or self._session is None:
            return self._client
        with self._lock:
            client = self._regional_clients.get(region)
            if client is None:
                client = self._session.client('s3', region_name=region, config=_client_config())
                self._regional_clients[region] = client
            return client

    def get_presigned_url(self, s3_url: str, expiration: int = None) -> str:
        """
        Generate a pre-signed URL for an S3 object.

        The pre-signed URL can be used as a regular HTTPS URL by any reader.
        Without usable credentials (or for an object only readable
        anonymously) the plain public URL is returned instead.

        Args:
            s3_url: S3 URL (s3://bucket/key)
            expiration: URL expiration time in seconds (default: 3600)

        Returns:
            Pre-signed (or public) HTTPS URL

        Raises:
            ValueError: If not an S3 URL
        """
        if expiration is None:
            expiration = self._default_expiration

        # Check cache first
        cached = self._presigned_cache.get(s3_url)
        if cached:
            url, expiry_time = cached
            # Return cached URL if still valid (with buffer)
            if time.time() < expiry_time - self._refresh_threshold:
                return url

        self._ensure_configured()
        bucket, key = self.parse_s3_url(s3_url)
        generation = self._generation

        def remember(url: str) -> str:
            with self._lock:
                if self._generation == generation:  # settings unchanged meanwhile
                    self._presigned_cache[s3_url] = (url, time.time() + expiration)
            return url

        if self._client is not None and self._access_mode.get((bucket, key)) != 'anonymous':
            try:
                return remember(self._signing_client(bucket).generate_presigned_url(
                    'get_object',
                    Params={'Bucket': bucket, 'Key': key},
                    ExpiresIn=expiration,
                ))
            except Exception:
                pass  # no credentials to sign with: the public URL below

        # Public URLs don't expire; the cache entry just keeps answers consistent.
        return remember(self.public_url(s3_url))

    def open_url(self, s3_url: str) -> str:
        """The HTTPS URL a reader (htslib, pyBigWig, h5py) should open for ``s3_url``.

        Pre-signed when the object was readable with the credentials, plain
        when only anonymously (a pre-signed URL made from credentials the
        bucket refuses would be refused too, even for a public object).
        """
        bucket, key = self.parse_s3_url(s3_url)
        if (bucket, key) not in self._access_mode:
            result = self.test_access(s3_url)  # learns the mode
            if not result.get("accessible"):
                raise OSError(f"{s3_url}: {result.get('error') or 'not accessible'}")
        return self.get_presigned_url(s3_url)

    def clear_presigned_cache(self):
        """Clear the pre-signed URL cache."""
        self._presigned_cache.clear()

    @staticmethod
    def parse_s3_url(s3_url: str) -> Tuple[str, str]:
        """
        Parse s3://bucket/key into (bucket, key).

        The key is taken as written: ``#`` and ``?`` are legal in S3 keys
        (urlparse would cut them off as a fragment / query, which turned
        ``x.bam##idx##...`` into ``x.bam``).

        Raises:
            ValueError: If not a valid S3 URL
        """
        if not isinstance(s3_url, str) or not s3_url.startswith('s3://'):
            raise ValueError(f"Not an S3 URL: {s3_url}")
        bucket, _, key = s3_url[len('s3://'):].partition('/')
        if not bucket:
            raise ValueError(f"Invalid S3 URL (no bucket): {s3_url}")
        if not key:
            raise ValueError(f"Invalid S3 URL (no key): {s3_url}")
        return bucket, key

    @staticmethod
    def is_s3_url(url: str) -> bool:
        """Check if URL is an S3 URL."""
        if not url:
            return False
        return url.startswith('s3://')

    def _where(self) -> str:
        return self._endpoint_url or "AWS S3"

    def describe_error(self, err, s3_url: str) -> str:
        """A user-facing message for a failed S3 call on ``s3_url``."""
        if isinstance(err, ClientError):
            code = _error_code(err) or 'Unknown'
            if code in _NOT_FOUND_CODES:
                return f"Object not found: {s3_url} (on {self._where()})"
            if code == 'NoSuchBucket':
                bucket = s3_url[len('s3://'):].split('/', 1)[0]
                return f"Bucket '{bucket}' does not exist on {self._where()}"
            if code in _BAD_CREDENTIAL_CODES:
                who = f"profile '{self._profile}'" if self._profile else "the configured credentials"
                return (f"{self._where()} rejected {who} ({code}): check the access key and secret, "
                        "and that they belong to this endpoint")
            if code in _AUTH_CODES:
                if self._client is None or self._method is None:
                    return "Access denied: the bucket is not public and no credentials are configured"
                return ("Access denied: the bucket is not public, and the configured credentials "
                        "are not allowed this (check the key's policy for this bucket)")
            if code in ('301', 'PermanentRedirect', 'AuthorizationHeaderMalformed'):
                return f"The bucket is in another region or on another endpoint than {self._where()} ({code})"
            return f"S3 error {code} for {s3_url}"
        if isinstance(err, NoCredentialsError):
            return "Access denied: the bucket is not public and no credentials are configured"
        if isinstance(err, EndpointConnectionError):
            return f"Cannot reach {self._where()} (network down, or wrong endpoint URL?)"
        if isinstance(err, BotoCoreError):
            return f"S3 request failed: {err}"
        return str(err)

    def test_access(self, s3_url: str) -> Dict[str, Any]:
        """
        Test if we can access an S3 object.

        Args:
            s3_url: S3 URL to test

        Returns:
            Dict with access status and details
        """
        if not HAS_BOTO3:
            return {
                "accessible": False,
                "error": "boto3 not installed"
            }

        # Auto-configure if not already done (non-fatal if no creds —
        # we'll fall through to anonymous access below).
        self._ensure_configured()

        try:
            bucket, key = self.parse_s3_url(s3_url)
        except ValueError as e:
            return {"accessible": False, "error": str(e)}

        generation = self._generation
        signed = lambda: self._client.head_object(Bucket=bucket, Key=key)
        anon = lambda c: c.head_object(Bucket=bucket, Key=key)
        response, used_anon, err = self._try_with_fallback(signed, anon)

        if err is not None and _error_code(err) in ('403', '400') and self._client is not None:
            # A HEAD error has no body, so "403" can't tell wrong keys from a
            # missing permission: a one-byte signed GET says which.
            try:
                self._client.get_object(Bucket=bucket, Key=key, Range='bytes=0-0')['Body'].close()
            except ClientError as detail:
                if _error_code(detail) in _BAD_CREDENTIAL_CODES:
                    err = detail
            except Exception:
                pass

        if err is not None:
            return {"accessible": False, "error": self.describe_error(err, s3_url),
                    "code": _error_code(err) or type(err).__name__}

        mode = 'anonymous' if used_anon else 'signed'
        with self._lock:
            if self._generation == generation:
                if self._access_mode.get((bucket, key)) != mode:
                    self._presigned_cache.pop(s3_url, None)
                self._access_mode[(bucket, key)] = mode
        return {
            "accessible": True,
            "size": response.get('ContentLength'),
            "content_type": response.get('ContentType'),
            "last_modified": str(response.get('LastModified')),
            "etag": response.get('ETag'),
            "anonymous": used_anon,
        }

    def get_object_bytes(self, s3_url: str, max_bytes: int) -> bytes:
        """The whole object (small files: indexes, maps), signed or anonymously."""
        self._ensure_configured()
        bucket, key = self.parse_s3_url(s3_url)
        signed = lambda: self._client.get_object(Bucket=bucket, Key=key)
        anon = lambda c: c.get_object(Bucket=bucket, Key=key)
        response, _anon, err = self._try_with_fallback(signed, anon)
        if err is not None:
            raise OSError(self.describe_error(err, s3_url))
        body = response['Body']
        try:
            data = body.read(max_bytes + 1)
        except Exception as exc:  # botocore's ResponseStreamingError is not an OSError
            raise OSError(f"Reading {s3_url} failed ({type(exc).__name__}): the connection dropped?") from None
        finally:
            body.close()
        if len(data) > max_bytes:
            raise OSError(f"{s3_url} is larger than {max_bytes // (1024 * 1024)} MB")
        return data

    def list_bucket(self, bucket: str, prefix: str = "", max_keys: int = 100) -> Dict[str, Any]:
        """
        List objects in an S3 bucket (anonymously when the bucket is public).

        Args:
            bucket: Bucket name
            prefix: Optional key prefix to filter results
            max_keys: Maximum number of keys to return

        Returns:
            Dict with list of objects or error
        """
        if not HAS_BOTO3:
            return {"success": False, "error": "boto3 not installed"}

        self._ensure_configured()
        kwargs = dict(Bucket=bucket, Prefix=prefix, MaxKeys=max_keys)
        response, _anon, err = self._try_with_fallback(
            lambda: self._client.list_objects_v2(**kwargs),
            lambda c: c.list_objects_v2(**kwargs),
        )
        if err is not None:
            return {"success": False, "error": self.describe_error(err, f"s3://{bucket}/{prefix}")}
        objects = []
        for obj in response.get('Contents', []):
            objects.append({
                "key": obj['Key'],
                "size": obj['Size'],
                "last_modified": str(obj['LastModified'])
            })
        return {
            "success": True,
            "bucket": bucket,
            "prefix": prefix,
            "objects": objects,
            "truncated": response.get('IsTruncated', False)
        }

    def get_credentials_info(self) -> Dict[str, Any]:
        """Get information about currently configured credentials (never the secrets)."""
        if not HAS_BOTO3:
            return {
                "available": False,
                "error": "boto3 not installed"
            }

        if not self._configured:
            return {
                "available": True,
                "configured": False,
                "message": "S3 not configured. Call configure() or set AWS environment variables."
            }

        return {
            "available": True,
            "configured": True,
            "profile": self._profile,
            "region": self._region,
            "endpoint_url": self._endpoint_url,
            "method": self._method,
        }


# Global S3 manager instance
s3_manager = S3Manager()


def get_s3_aware_path(path: str) -> str:
    """
    The path a reader should open: local paths unchanged, ``s3://`` as an
    HTTPS URL (pre-signed for private objects, plain for public ones).

    htslib, pyBigWig and h5py all read HTTPS by range, and that URL carries
    boto3's settings (profile, endpoint, region), which htslib's native
    ``s3://`` support would not see.
    """
    if not S3Manager.is_s3_url(path):
        return path
    return s3_manager.open_url(path)


def setup_s3_environment():
    """Kept for callers of the old API; does nothing.

    It used to export ``AWS_PROFILE``/``HTS_S3_REGION`` for htslib. Readers
    now open S3 objects through :func:`get_s3_aware_path` (boto3's settings),
    and the exported ``AWS_PROFILE`` outlived the configuration that set it:
    a later "default credentials" configuration silently kept using the old
    profile.
    """
    return None
