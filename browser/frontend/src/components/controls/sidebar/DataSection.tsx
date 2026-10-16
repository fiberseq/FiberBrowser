import { useEffect, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { SidebarSubSection } from '../SidebarSubSection';
import { DatasetSection } from './DatasetSection';
import { CatalogSection } from './CatalogSection';
import { LoadLocalFileSettings } from './file/LoadLocalFileSettings';
import { RemoteUrlSettings } from './file/RemoteUrlSettings';
import { ConnectClusterSettings } from './file/ConnectClusterSettings';
import { SessionExportSettings } from './file/SessionExportSettings';
import { SessionRestoreButton } from './file/SessionRestoreButton';
import { useDatasetActions } from '../../../hooks/useDatasetActions';
import { useBrowserStore } from '../../../stores/browserStore';
import { DafRunSidebarSection } from '../daf-run/DafRunEntryPoints';
import { LibrarySidebarSection } from '../library/LibraryHost';
import { SHOW_REMOTE_URL_EVENT, takeRemoteUrlRequest } from '../../../utils/loadByPath';

interface FileSectionProps {
  onExport: () => void;
  onCopyLink: () => void;
  linkCopied: boolean;
}

export function FileSection({ onCopyLink, linkCopied }: FileSectionProps) {
  const {
    setError, loading,
    showS3Input, setShowS3Input, s3Url, setS3Url, s3Profile, setS3Profile, s3Endpoint, setS3Endpoint,
    s3Status, s3Testing, handleLoadS3,
  } = useDatasetActions();

  const publicMode = useBrowserStore(s => s.publicMode);

  // Open ▾ → Load by path / URL… opens the Remote URL form too (utils/loadByPath):
  // asked before this section mounted (the sidebar opens on the same click), or while it is on show.
  // Synchronously, so its URL field's autofocus comes before Load by path's field takes the focus.
  useLayoutEffect(() => {
    if (takeRemoteUrlRequest()) setShowS3Input(true);
  }, [setShowS3Input]);
  useEffect(() => {
    const show = () => { takeRemoteUrlRequest(); flushSync(() => setShowS3Input(true)); };
    window.addEventListener(SHOW_REMOTE_URL_EVENT, show);
    return () => window.removeEventListener(SHOW_REMOTE_URL_EVENT, show);
  }, [setShowS3Input]);

  return (
    <div className="space-y-1.5">
      <SessionRestoreButton setError={setError} />

      <LoadLocalFileSettings setError={setError} />

      {/* Right below Load by path: Open ▾ → Load by path / URL… shows the two together. */}
      <RemoteUrlSettings
        publicMode={publicMode}
        loading={loading}
        showS3Input={showS3Input}
        setShowS3Input={setShowS3Input}
        s3Url={s3Url}
        setS3Url={setS3Url}
        s3Profile={s3Profile}
        setS3Profile={setS3Profile}
        s3Endpoint={s3Endpoint}
        setS3Endpoint={setS3Endpoint}
        s3Status={s3Status}
        s3Testing={s3Testing}
        handleLoadS3={handleLoadS3}
      />

      <DafRunSidebarSection />

      <LibrarySidebarSection />

      <ConnectClusterSettings publicMode={publicMode} />

      {/* Dataset catalog — shown in --catalog / --public review deployments.
          Renders nothing if no catalog is configured. */}
      <CatalogSection />

      <SidebarSubSection
        id="file.panels"
        label="Loaded Datasets"
        helpText="Manage loaded dataset panels, layout, linking, merging, and overlays"
        defaultOpen
        persist
      >
        <DatasetSection />
      </SidebarSubSection>

      <SessionExportSettings
        onCopyLink={onCopyLink}
        linkCopied={linkCopied}
        setError={setError}
      />
    </div>
  );
}
