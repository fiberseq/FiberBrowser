import { SidebarSubSection } from '../../SidebarSubSection';
import { useBrowserStore } from '../../../../stores/browserStore';
import { defineSettings, inSidebar, settingAnchor } from '../../../../utils/settingsCatalog';

export const REMOTE_URL_SETTINGS = defineSettings({
  url: {
    id: 'file.remote-url',
    label: 'Load from URL',
    keywords: ['s3', 'https', 'remote', 'aws profile', 'url', 'cloud', 'endpoint', 'r2', 'b2', 'minio'],
    location: inSidebar('file.remote'),
    hiddenReason: () => (useBrowserStore.getState().publicMode ? 'not on a public server' : null),
  },
});

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface RemoteUrlSettingsProps {
  publicMode: boolean;
  loading: boolean;
  showS3Input: boolean;
  setShowS3Input: (show: boolean) => void;
  s3Url: string;
  setS3Url: (url: string) => void;
  s3Profile: string;
  setS3Profile: (profile: string) => void;
  s3Endpoint: string;
  setS3Endpoint: (endpoint: string) => void;
  s3Status: { configured?: boolean; profile?: string | null; endpoint_url?: string | null; available?: boolean } | null;
  s3Testing: boolean;
  handleLoadS3: () => void;
}

export function RemoteUrlSettings({
  publicMode,
  loading,
  showS3Input,
  setShowS3Input,
  s3Url,
  setS3Url,
  s3Profile,
  setS3Profile,
  s3Endpoint,
  setS3Endpoint,
  s3Status,
  s3Testing,
  handleLoadS3,
}: RemoteUrlSettingsProps) {
  if (publicMode) {
    return null;
  }

  return (
    <SidebarSubSection
      id="file.remote"
      label="Load Remote URL"
      helpText="Load BAM or BigBed data from s3:// or https:// URLs. HTTPS paths use htslib range requests."
      persist
    >
      <div className="space-y-1" {...settingAnchor(REMOTE_URL_SETTINGS.url)}>
        <button
          onClick={() => setShowS3Input(!showS3Input)}
          className="w-full text-left px-2 py-1 text-[12px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 rounded"
        >
          Load from URL...
          {s3Status?.configured && (
            <span className="text-[11px] text-ink-secondary ml-1" data-testid="remote-url-s3-status">
              (S3 profile: {s3Status.profile || 'default'}{s3Status.endpoint_url ? ` · ${hostOf(s3Status.endpoint_url)}` : ''})
            </span>
          )}
        </button>

        {showS3Input && (() => {
          const url = s3Url.trim();
          const isS3 = /^s3:\/\//i.test(url);
          const isHttps = /^https?:\/\//i.test(url);
          return (
            <div className="p-2 bg-orange-50 dark:bg-orange-950/30 rounded border border-orange-200 dark:border-orange-800/30">
              <input
                type="text"
                value={s3Url}
                onChange={e => setS3Url(e.target.value)}
                placeholder="s3://bucket/file.bam or https://host/path/file.bam"
                data-testid="remote-url-input"
                className="border rounded px-2 py-1 text-xs w-full dark:bg-white/10 dark:border-white/10 dark:text-gray-200"
                onKeyDown={e => e.key === 'Enter' && handleLoadS3()}
                autoFocus
              />
              {!isHttps && (
                <input
                  type="text"
                  value={s3Endpoint}
                  onChange={e => setS3Endpoint(e.target.value)}
                  placeholder="Endpoint for R2, B2, MinIO… (optional; blank = AWS)"
                  title="S3-compatible endpoint, e.g. https://<account>.r2.cloudflarestorage.com. Blank: AWS S3, or the endpoint your AWS profile sets. Starts from the current setting."
                  data-testid="remote-url-s3-endpoint"
                  className="border rounded px-2 py-1 text-xs w-full mt-1 dark:bg-white/10 dark:border-white/10 dark:text-gray-200"
                  onKeyDown={e => e.key === 'Enter' && handleLoadS3()}
                />
              )}
              <div className="flex gap-1 mt-1">
                {!isHttps && (
                  <input
                    type="text"
                    value={s3Profile}
                    onChange={e => setS3Profile(e.target.value)}
                    placeholder="AWS profile (optional)"
                    data-testid="remote-url-s3-profile"
                    className="border rounded px-2 py-1 text-xs flex-1 dark:bg-white/10 dark:border-white/10 dark:text-gray-200"
                  />
                )}
                <button
                  onClick={handleLoadS3}
                  disabled={loading || !url}
                  className="px-3 py-1 bg-orange-500 text-white rounded text-xs hover:bg-orange-600 disabled:opacity-50 ml-auto"
                >
                  {s3Testing ? 'Testing...' : 'Load'}
                </button>
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                {isHttps ? 'HTTPS -> htslib range requests (needs Accept-Ranges + a .bai/.csi next to the BAM, or <bam>##idx##<index URL>).'
                  : isS3  ? (s3Status?.available ? 'S3 -> boto3 (profile/endpoint apply to all s3:// files; public buckets need neither).' : 'S3 selected, but boto3 is not available on the server.')
                  :         'Prefix with s3:// or https://. The browser auto-detects which path to use.'}
              </div>
            </div>
          );
        })()}
      </div>
    </SidebarSubSection>
  );
}
